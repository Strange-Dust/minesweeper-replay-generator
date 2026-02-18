/**
 * Board state tracker for minesweeper games.
 *
 * Observes DOM changes on the minesweeper board to detect cell state changes
 * (opens, flags, blasts, etc.) and emits RecordedBoardEvent objects.
 *
 * This module uses a MutationObserver to watch for attribute/class changes on
 * board cells. Different minesweeper websites use different DOM structures,
 * so this tracker is designed to be configured with site-specific selectors
 * and state extraction functions.
 *
 * Coordinate convention: (row, col), 0-indexed internally.
 */

import type { RecordedBoardEvent, BoardEventCode } from '../types/rawvf'

/**
 * Callback invoked when a board cell state change is detected.
 */
export type BoardEventCallback = (event: RecordedBoardEvent) => void

/**
 * A function that extracts the current state of a cell from its DOM element.
 * Returns null if the state cannot be determined.
 *
 * This is site-specific — each minesweeper website represents cell states
 * differently (CSS classes, data attributes, background images, etc.).
 */
export type CellStateExtractor = (cellElement: Element) => BoardEventCode | null

/**
 * A function that extracts the (row, col) position from a cell element.
 * Returns null if the position cannot be determined.
 */
export type CellPositionExtractor = (cellElement: Element) => { row: number; col: number } | null

/**
 * Configuration for the board tracker.
 */
export interface BoardTrackerConfig {
  /** The board container DOM element to observe */
  boardElement: HTMLElement
  /** CSS selector for individual cell elements within the board */
  cellSelector: string
  /** Function to extract cell state from a cell DOM element */
  extractCellState: CellStateExtractor
  /** Function to extract (row, col) from a cell DOM element */
  extractCellPosition: CellPositionExtractor
  /** Callback for each detected board event */
  onEvent: BoardEventCallback
}

/**
 * Tracks minesweeper board state changes via DOM observation.
 *
 * Usage:
 *   const tracker = new BoardTracker({
 *     boardElement,
 *     cellSelector: '.cell',
 *     extractCellState: (el) => { ... },
 *     extractCellPosition: (el) => { ... },
 *     onEvent: (event) => { ... },
 *   })
 *   tracker.start()
 *   // ... game plays, DOM changes are detected ...
 *   tracker.stop()
 */
export class BoardTracker {
  private boardElement: HTMLElement
  private cellSelector: string
  private extractCellState: CellStateExtractor
  private extractCellPosition: CellPositionExtractor
  private onEvent: BoardEventCallback

  private observer: MutationObserver | null = null
  private isTracking: boolean = false

  /**
   * Previous known state for each cell, keyed by "row,col".
   * Used to detect actual state changes vs. redundant mutations.
   */
  private cellStates: Map<string, BoardEventCode> = new Map()

  constructor(config: BoardTrackerConfig) {
    this.boardElement = config.boardElement
    this.cellSelector = config.cellSelector
    this.extractCellState = config.extractCellState
    this.extractCellPosition = config.extractCellPosition
    this.onEvent = config.onEvent
  }

  /**
   * Start observing the board for cell state changes.
   *
   * Takes an initial snapshot of all cell states, then watches for
   * attribute and class mutations on cell elements.
   */
  start(): void {
    if (this.isTracking) return

    this.isTracking = true
    this.cellStates.clear()

    // Take initial snapshot of all cell states
    this.snapshotAllCells()

    // Set up MutationObserver to watch for changes
    this.observer = new MutationObserver((mutations) => {
      this.handleMutations(mutations)
    })

    this.observer.observe(this.boardElement, {
      attributes: true,
      attributeFilter: ['class', 'data-state', 'data-mine', 'style'],
      subtree: true,
      childList: true,
    })
  }

  /**
   * Stop observing the board.
   */
  stop(): void {
    if (!this.isTracking) return

    this.isTracking = false

    if (this.observer) {
      this.observer.disconnect()
      this.observer = null
    }
  }

  /**
   * Manually trigger a full board scan.
   * Useful after a known board reset or when the DOM structure changes.
   */
  rescan(): void {
    this.cellStates.clear()
    this.snapshotAllCells()
  }

  // --------------------------------------------------------------------------
  // Internal
  // --------------------------------------------------------------------------

  /**
   * Take a snapshot of all current cell states without emitting events.
   */
  private snapshotAllCells(): void {
    const cells = this.boardElement.querySelectorAll(this.cellSelector)
    for (const cell of cells) {
      const pos = this.extractCellPosition(cell)
      if (!pos) continue

      const state = this.extractCellState(cell)
      if (!state) continue

      const key = `${pos.row},${pos.col}`
      this.cellStates.set(key, state)
    }
  }

  /**
   * Handle DOM mutations and emit board events for state changes.
   */
  private handleMutations(mutations: MutationRecord[]): void {
    // Collect unique cells that changed (avoid processing same cell multiple times)
    const changedCells = new Set<Element>()

    for (const mutation of mutations) {
      const target = mutation.target as Element

      // Check if the mutated element is a cell
      if (target.matches?.(this.cellSelector)) {
        changedCells.add(target)
      }

      // Check if the mutated element contains cells (e.g., class change on a row)
      const cells = target.querySelectorAll?.(this.cellSelector)
      if (cells) {
        for (const cell of cells) {
          changedCells.add(cell)
        }
      }

      // If childList changed, new cells may have been added
      if (mutation.type === 'childList') {
        for (const node of mutation.addedNodes) {
          if (node instanceof Element) {
            if (node.matches(this.cellSelector)) {
              changedCells.add(node)
            }
            const innerCells = node.querySelectorAll(this.cellSelector)
            for (const cell of innerCells) {
              changedCells.add(cell)
            }
          }
        }
      }
    }

    // Process each changed cell
    for (const cell of changedCells) {
      this.processCell(cell)
    }
  }

  /**
   * Check a single cell for state changes and emit a board event if changed.
   */
  private processCell(cell: Element): void {
    const pos = this.extractCellPosition(cell)
    if (!pos) return

    const newState = this.extractCellState(cell)
    if (!newState) return

    const key = `${pos.row},${pos.col}`
    const prevState = this.cellStates.get(key)

    // Only emit if state actually changed
    if (newState !== prevState) {
      this.cellStates.set(key, newState)

      const event: RecordedBoardEvent = {
        type: 'board',
        event: newState,
        row: pos.row,
        col: pos.col,
      }

      this.onEvent(event)
    }
  }
}
