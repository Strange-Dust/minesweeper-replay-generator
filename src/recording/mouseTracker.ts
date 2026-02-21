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

  private gameStartTime: number = 0
  private isTracking: boolean = false
  private lastMoveTime: number = 0

  // Bound handlers (for proper removal)
  private handleMouseDown: (event: MouseEvent) => void
  private handleMouseUp: (event: MouseEvent) => void
  private handleMouseMove: (event: MouseEvent) => void

  constructor(config: MouseTrackerConfig) {
    this.boardElement = config.boardElement
    this.squareSize = config.squareSize
    this.onEvent = config.onEvent
    this.moveThrottleMs = config.moveThrottleMs ?? 0  // TODO: test in case 0ms is too low and causes performance issues

    // Bind event handlers
    this.handleMouseDown = this.onMouseDown.bind(this)
    this.handleMouseUp = this.onMouseUp.bind(this)
    this.handleMouseMove = this.onMouseMove.bind(this)
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

  // --------------------------------------------------------------------------
  // Internal event handlers
  // --------------------------------------------------------------------------

  private onMouseDown(domEvent: MouseEvent): void {
    if (!this.isTracking) return

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

    // Throttle move events if configured
    if (this.moveThrottleMs > 0) {
      const now = performance.now()
      if (now - this.lastMoveTime < this.moveThrottleMs) return
      this.lastMoveTime = now
    }

    this.emitEvent('mv', domEvent)
  }

  // --------------------------------------------------------------------------
  // Helpers
  // --------------------------------------------------------------------------

  /**
   * Convert a DOM MouseEvent to a RecordedMouseEvent and emit it.
   */
  private emitEvent(code: MouseEventCode, domEvent: MouseEvent): void {
    const boardRect = this.boardElement.getBoundingClientRect()

    // Compute pixel position relative to the board top-left
    const x = Math.round(domEvent.clientX - boardRect.left)
    const y = Math.round(domEvent.clientY - boardRect.top)

    // Compute elapsed time since game start
    const timeMs = Math.round(performance.now() - this.gameStartTime)

    const recorded: RecordedMouseEvent = {
      type: 'mouse',
      timeMs,
      event: code,
      x,
      y,
    }

    this.onEvent(recorded)
  }
}
