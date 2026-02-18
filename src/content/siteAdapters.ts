/**
 * Site adapter system for minesweeper website detection.
 *
 * Each site adapter knows how to interact with a specific minesweeper website:
 *   - Find the board element in the DOM
 *   - Extract board configuration (dimensions, mine count, cell size)
 *   - Read cell states from DOM elements
 *   - Detect game results (win/loss)
 *   - Extract mine positions (when revealed)
 *
 * To add support for a new minesweeper website:
 *   1. Create a new adapter implementing the SiteAdapter interface
 *   2. Register it in the SITE_ADAPTERS array below
 *
 * Coordinate convention: all positions are (row, col), 0-indexed.
 */

import type { BoardConfig, BoardPosition, BoardEventCode, GameResult } from '../types/rawvf'

// ============================================================================
// Site adapter interface
// ============================================================================

/**
 * Interface for site-specific minesweeper board interaction.
 *
 * Implement this for each minesweeper website you want to support.
 */
export interface SiteAdapter {
  /** Human-readable name of the minesweeper program/website */
  getProgramName(): string

  /** Optional version string */
  getVersion?(): string

  /**
   * Check if this adapter matches the current page.
   * Should return true if this page is the minesweeper site this adapter supports.
   */
  matches(): boolean

  /**
   * Find the board container element in the DOM.
   * Returns null if the board is not found.
   */
  findBoardElement(): HTMLElement | null

  /**
   * Get the board configuration (dimensions, mine count, cell size).
   * Returns null if the configuration cannot be determined.
   */
  getBoardConfig(): BoardConfig | null

  /**
   * CSS selector for individual cell elements within the board.
   * Used by the BoardTracker to find and observe cells.
   */
  getCellSelector(): string

  /**
   * Extract the current state of a cell from its DOM element.
   * Maps site-specific CSS classes/attributes to RAWVF board event codes.
   */
  extractCellState(cellElement: Element): BoardEventCode | null

  /**
   * Extract the (row, col) position from a cell DOM element.
   * Coordinates should be 0-indexed.
   */
  extractCellPosition(cellElement: Element): { row: number; col: number } | null

  /**
   * Get mine positions from the DOM (if available).
   * Usually only available after the game ends and mines are revealed.
   * Returns empty array if mine positions cannot be determined.
   */
  getMinePositions?(): BoardPosition[]

  /**
   * Register a callback for game end detection.
   * The callback should be called with the game result when the game ends.
   */
  onGameEnd?(callback: (result: GameResult) => void): void
}

// ============================================================================
// Adapter registry
// ============================================================================

/**
 * All registered site adapters, checked in order.
 * More specific adapters should come before generic ones.
 */
const SITE_ADAPTERS: SiteAdapter[] = [
  // Adapters will be added here as we implement support for specific sites.
  // Example: new MinesweeperOnlineAdapter(),
  // Example: new MinesweeperGGAdapter(),
]

/**
 * Detect which site adapter matches the current page.
 * Returns the first matching adapter, or null if none match.
 */
export function detectSiteAdapter(): SiteAdapter | null {
  for (const adapter of SITE_ADAPTERS) {
    if (adapter.matches()) {
      return adapter
    }
  }
  return null
}

/**
 * Register a new site adapter.
 * Adapters registered later take lower priority (checked after existing ones).
 */
export function registerSiteAdapter(adapter: SiteAdapter): void {
  SITE_ADAPTERS.push(adapter)
}
