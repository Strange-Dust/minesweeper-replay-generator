/**
 * Mouse event tracker for recording minesweeper gameplay.
 *
 * Listens to mouse events on the board element and converts them to
 * RecordedMouseEvent objects with pixel coordinates relative to the board
 * and timestamps relative to game start.
 *
 * Tracked events:
 *   - mousedown (left/right/middle → lc/rc/mc)
 *   - mouseup (left/right/middle → lr/rr/mr)
 *   - mousemove (→ mv)
 *
 * Shift+left click is recorded as 'sc' (left click with shift).
 */

import type { RecordedMouseEvent, MouseEventCode } from '../types/rawvf'
import type { KeyboardMouseConfig } from '../types/settings'

/**
 * Callback invoked when a mouse event is captured.
 */
export type MouseEventCallback = (event: RecordedMouseEvent) => void

/**
 * Configuration for the mouse tracker.
 */
export interface MouseTrackerConfig {
  /** The board DOM element to listen on */
  boardElement: HTMLElement
  /** Cell size in pixels (for coordinate calculations) */
  squareSize: number
  /** Callback for each captured event */
  onEvent: MouseEventCallback
  /** Optional: minimum time between move events in ms (throttle) */
  moveThrottleMs?: number
  /** Optional: keyboard-as-mouse configuration */
  keyboardMouse?: KeyboardMouseConfig
  /**
   * Optional: the border/wrapper element surrounding the board.
   *
   * On minesweeper.online, players can click in the border area around the
   * board (#game wrapper) and drag into the board with the button held —
   * the site treats this as a valid click.  Without this, the recorder
   * would miss the press event since no mousedown fires on #AreaBlock.
   *
   * When provided, the tracker listens for mousedown on this element and
   * synthesises a press event when the mouse subsequently enters the board.
   * Only clicks originating in the immediate border are handled; clicks
   * from further outside can produce inconsistent site behaviour and are
   * intentionally ignored.
   */
  borderElement?: HTMLElement
}

/**
 * Tracks mouse events on a minesweeper board element.
 *
 * Usage:
 *   const tracker = new MouseTracker({ boardElement, squareSize, onEvent })
 *   tracker.start(gameStartTime)
 *   // ... game plays ...
 *   tracker.stop()
 */
export class MouseTracker {
  private boardElement: HTMLElement
  private squareSize: number
  private onEvent: MouseEventCallback
  private moveThrottleMs: number
  private keyboardMouse: KeyboardMouseConfig | undefined
  private borderElement: HTMLElement | undefined

  private gameStartTime: number = 0
  private isTracking: boolean = false
  private lastMoveTime: number = 0

  /** Last known mouse position relative to the board (for keyboard events) */
  private lastMouseX: number = 0
  private lastMouseY: number = 0

  /**
   * Which mouse button (0=left, 1=middle, 2=right) was pressed in the
   * border area, or -1 if none.  Used to synthesise a press event when
   * the cursor subsequently enters the board with the button still held.
   */
  private borderPressButton: number = -1
  /** Whether shift was held during the border press (for sc detection). */
  private borderPressShift: boolean = false

  // Bound handlers (for proper removal)
  private handleMouseDown: (event: MouseEvent) => void
  private handleMouseUp: (event: MouseEvent) => void
  private handleMouseMove: (event: MouseEvent) => void
  private handleKeyDown: (event: KeyboardEvent) => void
  private handleKeyUp: (event: KeyboardEvent) => void
  private handleBorderMouseDown: (event: MouseEvent) => void
  private handleBorderMouseUp: (event: MouseEvent) => void
  private handleBoardMouseEnter: (event: MouseEvent) => void

  constructor(config: MouseTrackerConfig) {
    this.boardElement = config.boardElement
    this.squareSize = config.squareSize
    this.onEvent = config.onEvent
    this.moveThrottleMs = config.moveThrottleMs ?? 0
    this.keyboardMouse = config.keyboardMouse
    this.borderElement = config.borderElement

    // Bind event handlers
    this.handleMouseDown = this.onMouseDown.bind(this)
    this.handleMouseUp = this.onMouseUp.bind(this)
    this.handleMouseMove = this.onMouseMove.bind(this)
    this.handleKeyDown = this.onKeyDown.bind(this)
    this.handleKeyUp = this.onKeyUp.bind(this)
    this.handleBorderMouseDown = this.onBorderMouseDown.bind(this)
    this.handleBorderMouseUp = this.onBorderMouseUp.bind(this)
    this.handleBoardMouseEnter = this.onBoardMouseEnter.bind(this)
  }

  /**
   * Start tracking mouse events.
   * @param gameStartTime - performance.now() timestamp of game start
   */
  start(gameStartTime: number): void {
    if (this.isTracking) return

    this.gameStartTime = gameStartTime
    this.isTracking = true
    this.lastMoveTime = 0

    // { passive: true } signals we will never call preventDefault(),
    // documenting our passive-observation intent and causing a runtime
    // error if someone accidentally adds preventDefault() in the future.
    this.boardElement.addEventListener('mousedown', this.handleMouseDown, { passive: true })
    this.boardElement.addEventListener('mouseup', this.handleMouseUp, { passive: true })
    this.boardElement.addEventListener('mousemove', this.handleMouseMove, { passive: true })

    // Keyboard-as-mouse: listen on the document since key events don't
    // fire on the board element. The cursor position at the time of the
    // key press determines the cell coordinates.
    if (this.keyboardMouse?.enabled) {
      document.addEventListener('keydown', this.handleKeyDown, { passive: true })
      document.addEventListener('keyup', this.handleKeyUp, { passive: true })
    }

    // Border-click handling: detect clicks that originate in the border
    // area around the board and drag into it.  See MouseTrackerConfig.
    if (this.borderElement) {
      this.borderPressButton = -1
      this.borderElement.addEventListener('mousedown', this.handleBorderMouseDown, { passive: true })
      // Listen on document for mouseup so we catch releases anywhere
      // (user might release outside the border/board entirely).
      document.addEventListener('mouseup', this.handleBorderMouseUp, { passive: true })
      this.boardElement.addEventListener('mouseenter', this.handleBoardMouseEnter, { passive: true })
    }
  }

  /**
   * Stop tracking mouse events and remove all listeners.
   */
  stop(): void {
    if (!this.isTracking) return

    this.isTracking = false

    this.boardElement.removeEventListener('mousedown', this.handleMouseDown)
    this.boardElement.removeEventListener('mouseup', this.handleMouseUp)
    this.boardElement.removeEventListener('mousemove', this.handleMouseMove)

    document.removeEventListener('keydown', this.handleKeyDown)
    document.removeEventListener('keyup', this.handleKeyUp)

    if (this.borderElement) {
      this.borderElement.removeEventListener('mousedown', this.handleBorderMouseDown)
      document.removeEventListener('mouseup', this.handleBorderMouseUp)
      this.boardElement.removeEventListener('mouseenter', this.handleBoardMouseEnter)
      this.borderPressButton = -1
    }
  }

  /**
   * Update the board element reference (e.g., if the DOM changes).
   */
  updateBoardElement(element: HTMLElement): void {
    const wasTracking = this.isTracking
    if (wasTracking) this.stop()
    this.boardElement = element
    if (wasTracking) this.start(this.gameStartTime)
  }

  /**
   * Update the game start time without removing/re-adding event listeners.
   *
   * Used by the recorder when transitioning from 'ready' to 'recording'.
   * Avoids the stop()/start() cycle which briefly detaches all listeners
   * — a window during which rapid back-to-back events could be lost.
   */
  setGameStartTime(gameStartTime: number): void {
    this.gameStartTime = gameStartTime
  }

  // --------------------------------------------------------------------------
  // Internal event handlers
  // --------------------------------------------------------------------------

  private onMouseDown(domEvent: MouseEvent): void {
    if (!this.isTracking) return

    // Update position on every click too (user might click without moving)
    this.updateMousePosition(domEvent)

    let code: MouseEventCode
    switch (domEvent.button) {
      case 0: // Left button
        code = domEvent.shiftKey ? 'sc' : 'lc'
        break
      case 1: // Middle button
        code = 'mc'
        break
      case 2: // Right button
        code = 'rc'
        break
      default:
        return // Ignore other buttons
    }

    this.emitEvent(code, domEvent)
  }

  private onMouseUp(domEvent: MouseEvent): void {
    if (!this.isTracking) return

    let code: MouseEventCode
    switch (domEvent.button) {
      case 0:
        code = 'lr'
        break
      case 1:
        code = 'mr'
        break
      case 2:
        code = 'rr'
        break
      default:
        return
    }

    this.emitEvent(code, domEvent)
  }

  private onMouseMove(domEvent: MouseEvent): void {
    if (!this.isTracking) return

    // Always update last known mouse position (used by keyboard events)
    this.updateMousePosition(domEvent)

    // Throttle move events if configured
    if (this.moveThrottleMs > 0) {
      const now = performance.now()
      if (now - this.lastMoveTime < this.moveThrottleMs) return
      this.lastMoveTime = now
    }

    this.emitEvent('mv', domEvent)
  }

  // --------------------------------------------------------------------------
  // Border-click handlers
  // --------------------------------------------------------------------------

  /**
   * Track mousedown events on the border/wrapper element.
   *
   * On minesweeper.online the #game wrapper includes a visible border
   * around #AreaBlock.  Clicking this border and dragging into the board
   * is treated by the site as a valid click — cells depress and reveal
   * on release just like a normal click.  However, no mousedown fires on
   * #AreaBlock itself, so we would miss the press event.
   *
   * We only record the button here; the actual press event is synthesised
   * in onBoardMouseEnter when the cursor crosses into the board.
   *
   * Clicks that originate on the board itself are ignored (those are
   * already handled by onMouseDown).  Clicks from outside #game entirely
   * are never seen here, which is intentional — the site's behaviour for
   * those is inconsistent and we don't attempt to handle them.
   */
  private onBorderMouseDown(domEvent: MouseEvent): void {
    if (!this.isTracking) return
    // Ignore clicks that land on the board — already handled by onMouseDown
    if (this.boardElement.contains(domEvent.target as Node)) return
    this.borderPressButton = domEvent.button
    this.borderPressShift = domEvent.shiftKey
  }

  /**
   * Clear border-press tracking on any mouseup (listens on document so
   * we catch releases regardless of where the cursor is).
   */
  private onBorderMouseUp(_domEvent: MouseEvent): void {
    this.borderPressButton = -1
  }

  /**
   * When the cursor enters the board with a border-pressed button held,
   * synthesise the press event at the board entry point.
   *
   * The mouseenter event's clientX/clientY give us the exact position
   * where the cursor crossed the board boundary, which is the correct
   * coordinate for the synthesised press.
   */
  private onBoardMouseEnter(domEvent: MouseEvent): void {
    if (!this.isTracking) return
    if (this.borderPressButton < 0) return

    let code: MouseEventCode
    switch (this.borderPressButton) {
      case 0: // Left button
        code = (this.borderPressShift || domEvent.shiftKey) ? 'sc' : 'lc'
        break
      case 1: // Middle button
        code = 'mc'
        break
      case 2: // Right button
        code = 'rc'
        break
      default:
        this.borderPressButton = -1
        return
    }

    // Clear — only synthesise one press per border click
    this.borderPressButton = -1
    this.borderPressShift = false

    this.emitEvent(code, domEvent)
  }

  // --------------------------------------------------------------------------
  // Keyboard-as-mouse handlers
  // --------------------------------------------------------------------------

  /**
   * Translate a keydown event to a mouse click event if the key matches
   * the configured keyboard-as-mouse keys. Uses the last known mouse
   * position to determine board coordinates.
   */
  private onKeyDown(domEvent: KeyboardEvent): void {
    if (!this.isTracking || !this.keyboardMouse?.enabled) return
    // Ignore key repeat (held down)
    if (domEvent.repeat) return

    const code = this.keyCodeToMouseCode(domEvent.keyCode, true)
    if (!code) return

    this.emitKeyboardEvent(code, domEvent)
  }

  /**
   * Translate a keyup event to a mouse release event.
   */
  private onKeyUp(domEvent: KeyboardEvent): void {
    if (!this.isTracking || !this.keyboardMouse?.enabled) return

    const code = this.keyCodeToMouseCode(domEvent.keyCode, false)
    if (!code) return

    this.emitKeyboardEvent(code, domEvent)
  }

  /**
   * Map a keyboard key code to a mouse event code based on configuration.
   *
   * If the same key is mapped to both left and right, it acts as left click
   * (matching minesweeper.online behavior where a single key maps to one action).
   */
  private keyCodeToMouseCode(keyCode: number, isDown: boolean): MouseEventCode | null {
    if (!this.keyboardMouse) return null

    const isLeft = keyCode === this.keyboardMouse.leftKeyCode
    const isRight = keyCode === this.keyboardMouse.rightKeyCode

    if (isLeft && isRight) {
      // Same key for both — treat as left click (site's behavior)
      return isDown ? 'lc' : 'lr'
    }
    if (isLeft) return isDown ? 'lc' : 'lr'
    if (isRight) return isDown ? 'rc' : 'rr'
    return null
  }

  // --------------------------------------------------------------------------
  // Helpers
  // --------------------------------------------------------------------------

  /**
   * Convert a DOM MouseEvent to a RecordedMouseEvent and emit it.
   * Uses domEvent.timeStamp (the actual moment the browser detected the
   * input) rather than performance.now() (when the JS callback runs).
   * This eliminates event-loop latency from the recorded timestamps.
   */
  private emitEvent(code: MouseEventCode, domEvent: MouseEvent): void {
    const boardRect = this.boardElement.getBoundingClientRect()

    // Compute pixel position relative to the board top-left
    const x = Math.round(domEvent.clientX - boardRect.left)
    const y = Math.round(domEvent.clientY - boardRect.top)

    // Compute elapsed time since game start using DOM event timestamps.
    // domEvent.timeStamp is a DOMHighResTimeStamp on the same time origin
    // as performance.now(), but reflects when the event actually occurred
    // rather than when the callback runs (~5-30ms difference under load).
    const timeMs = Math.max(0, Math.round(domEvent.timeStamp - this.gameStartTime))

    const recorded: RecordedMouseEvent = {
      type: 'mouse',
      timeMs,
      event: code,
      x,
      y,
      rawTimestamp: domEvent.timeStamp,
    }

    this.onEvent(recorded)
  }

  /**
   * Update the last known mouse position from a mouse event.
   * Called on every mousemove (before throttling) so keyboard events
   * always have an up-to-date position.
   */
  private updateMousePosition(domEvent: MouseEvent): void {
    const boardRect = this.boardElement.getBoundingClientRect()
    this.lastMouseX = Math.round(domEvent.clientX - boardRect.left)
    this.lastMouseY = Math.round(domEvent.clientY - boardRect.top)
  }

  /**
   * Emit a RecordedMouseEvent from a keyboard event using the last
   * known mouse position on the board.
   * Uses domEvent.timeStamp for precise timing (same as emitEvent).
   */
  private emitKeyboardEvent(code: MouseEventCode, domEvent: KeyboardEvent): void {
    const timeMs = Math.max(0, Math.round(domEvent.timeStamp - this.gameStartTime))

    const recorded: RecordedMouseEvent = {
      type: 'mouse',
      timeMs,
      event: code,
      x: this.lastMouseX,
      y: this.lastMouseY,
      rawTimestamp: domEvent.timeStamp,
    }

    this.onEvent(recorded)
  }
}
