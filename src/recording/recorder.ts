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

    this.setState('ready')

    // Start the mouse tracker — will begin collecting events,
    // but we don't set gameStartTime until the first release
    this.mouseTracker.start(performance.now()) // temporary start time
  }

  /**
   * Mark the game as finished with a result.
   * Transitions to 'finished' state and stops all trackers.
   */
  finish(result: GameResult): void {
    if (this.state !== 'recording' && this.state !== 'ready') return

    this.result = result
    this.gameEndTime = this.state === 'recording'
      ? Math.round(performance.now() - this.gameStartTime)
      : 0

    this.mouseTracker.stop()
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
        // Re-base the timer so this moment = time 0.
        this.mouseTracker.stop()
        this.gameStartTime = performance.now()
        this.mouseTracker.start(this.gameStartTime)

        // Emit all buffered press events at time 0
        for (const pending of this.pendingEvents) {
          this.events.push({ ...pending, timeMs: 0 })
        }
        this.pendingEvents = []
        this.waitingForRelease = false

        // Emit this release at time 0
        this.events.push({ ...event, timeMs: 0 })

        this.setState('recording')
        return
      }

      // Move events or other non-press/release events before the first
      // click — discard (not meaningful before game start).
      return
    }

    if (this.state === 'recording') {
      this.events.push(event)
    }
  }

  // --------------------------------------------------------------------------
  // Internal
  // --------------------------------------------------------------------------

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
