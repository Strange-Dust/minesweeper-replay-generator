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
 *   // ... game ends ...      // Call recorder.finishAndReset('won') or recorder.abort()
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
  /**
   * When true, the recorder buffers mouse events instead of processing them.
   * Used after finishAndReset() to prevent a phantom game from starting
   * while the board still shows the end-game state (mines revealed, face
   * showing win/lose). Call unfreeze() when the board actually resets —
   * buffered events are replayed so the first click is captured.
   */
  private frozen: boolean = false
  /** Events captured while frozen — replayed on unfreeze(). */
  private frozenBuffer: RecordedMouseEvent[] = []

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
    this.frozen = false
    this.frozenBuffer = []

    this.setState('ready')

    // Start the mouse tracker — will begin collecting events,
    // but we don't set gameStartTime until the first release
    this.mouseTracker.start(performance.now()) // temporary start time
  }

  /**
   * Finish the current game and immediately reset to 'ready' for the next
   * game — **without ever stopping the mouse tracker**.
   *
   * This is the fast path for multi-game sessions. The mouse tracker's
   * event listeners stay attached to the board element continuously, so
   * there is zero gap where a fast player's click could be lost.
   *
   * Returns the completed game's RecordingData (same as getRecordingData()
   * would return after finish()), or null if the recorder wasn't recording.
   */
  finishAndReset(result: GameResult, newMetadata?: ReplayMetadata): RecordingData | null {
    if (this.state !== 'recording' && this.state !== 'ready') return null

    // --- Snapshot the finished game's data ---
    this.result = result

    let data: RecordingData | null = null
    if (this.state === 'recording') {
      this.trimTrailingMoves()
      const lastEvent = this.events[this.events.length - 1]
      const endTime = lastEvent ? lastEvent.timeMs : 0

      data = {
        board: { ...this.board },
        minePositions: [...this.minePositions],
        events: [...this.events],
        metadata: { ...this.metadata },
        result: this.result,
        totalTimeMs: endTime,
      }
    }

    // --- Reset internal state for next game (mouse tracker stays alive) ---
    this.events = []
    this.pendingEvents = []
    this.waitingForRelease = false
    this.gameStartTime = 0
    this.gameEndTime = 0
    this.result = 'unknown'
    this.minePositions = []
    this.lastEmittedX = -1
    this.lastEmittedY = -1

    // Update metadata for the next game if provided
    if (newMetadata) {
      this.metadata = newMetadata
    }

    // Go straight to 'ready' — mouse tracker is still listening,
    // so the next click will be captured immediately.
    // Start frozen: the board still shows the end-game state, so clicks
    // should not start a new recording until the board actually resets.
    // Events during freeze are buffered and replayed on unfreeze().
    this.frozen = true
    this.frozenBuffer = []
    this.setState('ready')

    return data
  }

  /**
   * Prevent the recorder from starting a new game while in 'ready' state.
   * Mouse events are buffered and replayed on unfreeze().
   */
  freeze(): void {
    this.frozen = true
    this.frozenBuffer = []
  }

  /**
   * Allow the recorder to start a new game.
   *
   * Replays buffered events from the freeze period through the normal
   * event handler. On minesweeper.online, the click that resets the board
   * also starts the new game — the mousedown fires before the face class
   * changes, so it lands in the freeze buffer. By replaying it here, the
   * first click of the new game is captured with zero loss.
   *
   * Only replays from the LAST press event onward — earlier events were
   * clicks on the end-game board that have no gameplay meaning.
   */
  unfreeze(): void {
    if (!this.frozen) return
    this.frozen = false

    // Find the last press event in the buffer — this is the click that
    // triggered the board reset (and doubles as the first game click).
    let lastPressIndex = -1
    for (let i = this.frozenBuffer.length - 1; i >= 0; i--) {
      if (isPressEvent(this.frozenBuffer[i].event)) {
        lastPressIndex = i
        break
      }
    }

    if (lastPressIndex >= 0) {
      // Replay from the last press onward. Events go through the normal
      // ready-state logic: press → pendingEvents, release → game starts.
      const toReplay = this.frozenBuffer.slice(lastPressIndex)
      this.frozenBuffer = []
      for (const event of toReplay) {
        this.onMouseEvent(event)
      }
    } else {
      this.frozenBuffer = []
    }
  }

  /**
   * Stop recording without a result (manual stop / abort).
   */
  abort(): void {
    this.mouseTracker.stop()
    this.frozen = false
    this.frozenBuffer = []

    if (this.state === 'recording') {
      this.gameEndTime = Math.round(performance.now() - this.gameStartTime)
    }

    this.result = 'unknown'
    this.setState('finished')
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
      // Frozen: board still showing end-game state — buffer events for
      // replay on unfreeze (captures the click that resets the board).
      if (this.frozen) {
        this.frozenBuffer.push(event)
        return
      }

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
        // Use the raw DOM timestamp of the first release as time-zero.
        // mouseTracker.emitEvent() already computes every event's timeMs
        // as `domEvent.timeStamp - gameStartTime`, so by setting
        // gameStartTime to the first release's own domEvent.timeStamp
        // we get purely hardware-level deltas with no JS-scheduling
        // jitter mixed in.
        //
        // Previously this used performance.now() (captured when our
        // handler runs, ~5-15ms after domEvent.timeStamp).  That mixed
        // two timing domains: browser-detected input timestamps for all
        // subsequent events, minus a JS-execution-time origin.  The
        // mismatch inflated total game time by the handler delay (~10ms)
        // because the start was shifted later while the end event still
        // used its raw domEvent.timeStamp.
        //
        // With this approach every timestamp is on the same clock basis
        // (DOMHighResTimeStamp from the browser's input pipeline), so
        // relative timing between events is exact and total game time
        // is as accurate as the browser's input detection allows.
        const gameStartTimestamp = event.rawTimestamp
        this.gameStartTime = gameStartTimestamp
        this.mouseTracker.setGameStartTime(gameStartTimestamp)

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
