/**
 * Game recorder — orchestrates mouse tracking and RAWVF generation.
 *
 * This is the central coordinator that manages the lifecycle of a recording session:
 *   1. Idle → Ready: Board detected, waiting for game to start
 *   2. Ready → Recording: First click detected, recording begins
 *   3. Recording → Finished: Game ends (win/loss) or user stops manually
 *   4. Finished → RAWVF export available
 *
 * The recorder collects mouse events from the MouseTracker,
 * maintains the event timeline, and produces a RecordingData object
 * suitable for the RAWVF writer.
 */

import type {
  BoardConfig,
  BoardPosition,
  RecordedMouseEvent,
  RecordingData,
  RecordingState,
  ReplayMetadata,
  GameResult,
} from '../types/rawvf'
import { MouseTracker, type MouseTrackerConfig } from './mouseTracker'

/**
 * Callback for recording state changes.
 */
export type StateChangeCallback = (state: RecordingState) => void

/**
 * Configuration for the game recorder.
 */
export interface RecorderConfig {
  /** Board configuration (dimensions, mine count, cell size) */
  board: BoardConfig
  /** Mine positions (row, col), 0-indexed. If not yet known, can be set later. */
  minePositions?: BoardPosition[]
  /** Mouse tracker configuration (without onEvent — the recorder provides it) */
  mouseTrackerConfig: Omit<MouseTrackerConfig, 'onEvent'>
  /** Replay metadata */
  metadata: ReplayMetadata
  /** Callback when recording state changes */
  onStateChange?: StateChangeCallback
}

/**
 * Orchestrates recording of a minesweeper game.
 *
 * Usage:
 *   const recorder = new GameRecorder(config)
 *   recorder.start()          // Begin listening (transitions to 'ready')
 *   // ... game plays ...     // Automatically transitions to 'recording' on first click
 *   // ... game ends ...      // Call recorder.finish('won') or recorder.finish('lost')
 *   const data = recorder.getRecordingData()
 *   const rawvf = generateRawvf(data)
 */
export class GameRecorder {
  private state: RecordingState = 'idle'
  private board: BoardConfig
  private minePositions: BoardPosition[]
  private metadata: ReplayMetadata
  private onStateChange?: StateChangeCallback

  private mouseTracker: MouseTracker

  private events: RecordedMouseEvent[] = []
  /** Events buffered before the game officially starts (press before release) */
  private pendingEvents: RecordedMouseEvent[] = []
  /** Whether we've seen a press event and are waiting for the release */
  private waitingForRelease: boolean = false
  private gameStartTime: number = 0
  private gameEndTime: number = 0
  private result: GameResult = 'unknown'
  /** Position of the last emitted event — used to suppress redundant moves
   *  immediately after the first click rebase. */
  private lastEmittedX: number = -1
  private lastEmittedY: number = -1

  constructor(config: RecorderConfig) {
    this.board = config.board
    this.minePositions = config.minePositions ?? []
    this.metadata = config.metadata
    this.onStateChange = config.onStateChange

    // Create mouse tracker with our event handler
    this.mouseTracker = new MouseTracker({
      ...config.mouseTrackerConfig,
      onEvent: (event) => this.onMouseEvent(event),
    })
  }

  // --------------------------------------------------------------------------
  // Public API
  // --------------------------------------------------------------------------

  /**
   * Get the current recording state.
   */
  getState(): RecordingState {
    return this.state
  }

  /**
   * Get the number of events recorded so far.
   */
  getEventCount(): number {
    return this.events.length
  }

  /**
   * Get elapsed time in ms (0 if not yet recording).
   */
  getElapsedMs(): number {
    if (this.state === 'recording') {
      return Math.round(performance.now() - this.gameStartTime)
    }
    if (this.state === 'finished') {
      return this.gameEndTime
    }
    return 0
  }

  /**
   * Set mine positions (if not known at construction time).
   * Mine positions are often only revealed when the game ends.
   */
  setMinePositions(positions: BoardPosition[]): void {
    this.minePositions = positions
  }

  /**
   * Start listening for events. Transitions to 'ready' state.
   * The recorder will automatically transition to 'recording' on the first mouse click.
   */
  start(): void {
    if (this.state !== 'idle') return

    this.events = []
    this.pendingEvents = []
    this.waitingForRelease = false
    this.gameStartTime = 0
    this.gameEndTime = 0
    this.result = 'unknown'
    this.lastEmittedX = -1
    this.lastEmittedY = -1

    this.setState('ready')

    // Start the mouse tracker — will begin collecting events,
    // but we don't set gameStartTime until the first release
    this.mouseTracker.start(performance.now()) // temporary start time
  }

  /**
   * Mark the game as finished with a result.
   * Transitions to 'finished' state and stops all trackers.
   *
   * Because game-end is detected asynchronously (MutationObserver on the
   * face element), a small number of move events may slip in after the
   * actual final release.  We trim those and derive the total time from
   * the last meaningful event rather than the wall clock.
   */
  finish(result: GameResult): void {
    if (this.state !== 'recording' && this.state !== 'ready') return

    this.result = result
    this.mouseTracker.stop()

    if (this.state === 'recording') {
      // Trim trailing move events that arrived after the final release.
      // The game logically ends on the last release (lr, rr, or mr).
      this.trimTrailingMoves()

      // Derive total time from the last event's timestamp — this is more
      // accurate than performance.now() because the MutationObserver that
      // triggers finish() fires with a small delay.
      const lastEvent = this.events[this.events.length - 1]
      this.gameEndTime = lastEvent ? lastEvent.timeMs : 0
    } else {
      this.gameEndTime = 0
    }

    this.setState('finished')
  }

  /**
   * Stop recording without a result (manual stop / abort).
   */
  abort(): void {
    this.mouseTracker.stop()

    if (this.state === 'recording') {
      this.gameEndTime = Math.round(performance.now() - this.gameStartTime)
    }

    this.result = 'unknown'
    this.setState('finished')
  }

  /**
   * Reset the recorder to idle state for a new game.
   */
  reset(): void {
    this.mouseTracker.stop()
    this.events = []
    this.pendingEvents = []
    this.waitingForRelease = false
    this.gameStartTime = 0
    this.gameEndTime = 0
    this.result = 'unknown'
    this.lastEmittedX = -1
    this.lastEmittedY = -1
    this.setState('idle')
  }

  /**
   * Get the complete recording data, ready for RAWVF generation.
   * Only valid in 'finished' state.
   */
  getRecordingData(): RecordingData | null {
    if (this.state !== 'finished') return null

    return {
      board: { ...this.board },
      minePositions: [...this.minePositions],
      events: [...this.events],
      metadata: { ...this.metadata },
      result: this.result,
      totalTimeMs: this.gameEndTime,
    }
  }

  // --------------------------------------------------------------------------
  // Event handlers
  // --------------------------------------------------------------------------

  private onMouseEvent(event: RecordedMouseEvent): void {
    if (this.state === 'ready') {
      // Minesweeper convention: the game timer starts on the first mouse
      // *release* (e.g. 'lr'), not the press. We buffer press events while
      // waiting for the release, then emit both press + release at time 0.
      if (isPressEvent(event.event)) {
        // Buffer the press — we'll emit it at time 0 once we see the release
        this.pendingEvents.push(event)
        this.waitingForRelease = true
        return
      }

      if (this.waitingForRelease && isReleaseEvent(event.event)) {
        // This release marks the official game start.
        //
        // Use performance.now() — captured here in our event handler —
        // rather than domEvent.timeStamp.  Both are on the same clock
        // (relative to performance.timeOrigin), so mixing them in the
        // subtraction `domEvent.timeStamp - gameStartTime` is valid.
        //
        // Why not domEvent.timeStamp?  The timestamp reflects when the
        // browser detected the input, BEFORE any JavaScript runs.  The
        // site's own timer starts from performance.now() inside its
        // handler, which fires before ours (target/bubble ordering).
        // By the time our handler runs, the site has already spent
        // ~10-15ms processing the first click (revealing cells,
        // cascading openings, etc.) and then started its timer.
        // Using performance.now() here — after the site's handler —
        // aligns our time-zero with the site's.
        //
        // At game end the site's processing is much lighter (~1-2ms),
        // so using domEvent.timeStamp for end events is fine.  The net
        // effect is that our total game time closely matches the site's
        // reported duration.  Relative timing between events is
        // preserved exactly (all shifted by the same constant).
        const gameStartNow = performance.now()
        this.gameStartTime = gameStartNow
        this.mouseTracker.setGameStartTime(gameStartNow)

        // Emit all buffered press events at time 0.
        // Convention: overwrite press coordinates with the release
        // location — for the first click the press and release should
        // appear at the same cell position.
        for (const pending of this.pendingEvents) {
          this.events.push({ ...pending, timeMs: 0, x: event.x, y: event.y })
        }
        this.pendingEvents = []
        this.waitingForRelease = false

        // Emit this release at time 0
        this.events.push({ ...event, timeMs: 0 })

        // Track the first-click position so we can suppress a redundant
        // move event that the browser fires right after the release.
        this.lastEmittedX = event.x
        this.lastEmittedY = event.y

        this.setState('recording')
        return
      }

      // Move events or other non-press/release events before the first
      // click — discard (not meaningful before game start).
      return
    }

    if (this.state === 'recording') {
      // Suppress a redundant move event immediately after the first-click
      // rebase — the browser can fire a mousemove to the same pixel
      // position 1-2ms after the release, which adds a useless mv line.
      if (
        event.event === 'mv' &&
        this.lastEmittedX >= 0 &&
        event.x === this.lastEmittedX &&
        event.y === this.lastEmittedY
      ) {
        // Clear tracking — only suppress the very first redundant move
        this.lastEmittedX = -1
        this.lastEmittedY = -1
        return
      }
      // Any non-suppressed event clears the tracking
      this.lastEmittedX = -1
      this.lastEmittedY = -1

      this.events.push(event)
    }
  }

  // --------------------------------------------------------------------------
  // Internal
  // --------------------------------------------------------------------------

  /**
   * Remove trailing 'mv' events that occur after the last release event.
   * These are artefacts of the slight delay between the actual game end
   * (final release) and the MutationObserver firing to signal finish().
   */
  private trimTrailingMoves(): void {
    while (this.events.length > 0) {
      const last = this.events[this.events.length - 1]
      if (last.event === 'mv') {
        this.events.pop()
      } else {
        break
      }
    }
  }

  private setState(newState: RecordingState): void {
    this.state = newState
    this.onStateChange?.(newState)
  }
}

/**
 * Check if a mouse event code represents a button press (down).
 */
function isPressEvent(code: string): boolean {
  return code === 'lc' || code === 'rc' || code === 'mc' || code === 'sc'
}

/**
 * Check if a mouse event code represents a button release (up).
 */
function isReleaseEvent(code: string): boolean {
  return code === 'lr' || code === 'rr' || code === 'mr'
}
