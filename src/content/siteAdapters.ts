/**
 * Site adapter system for minesweeper website detection.
 *
 * Each site adapter knows how to interact with a specific minesweeper website:
 *   - Find the board element in the DOM
 *   - Extract board configuration (dimensions, mine count, cell size)
 *   - Detect game results (win/loss)
 *   - Extract mine positions (when revealed)
 *
 * To add support for a new minesweeper website:
 *   1. Create a new adapter implementing the SiteAdapter interface
 *   2. Register it in the SITE_ADAPTERS array below
 *
 * Coordinate convention: all positions are (row, col), 0-indexed.
 */

import type { BoardConfig, BoardPosition, GameResult } from '../types/rawvf'
import type { GameSettings } from '../types/settings'
import { createMinesweeperOnlineAdapter } from './adapters/minesweeperOnline'

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
   * Detect the current player's name from the site (e.g. logged-in username).
   * Returns null/undefined if not available or not logged in.
   */
  getPlayerName?(): string | null

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
   * Find the border/wrapper element surrounding the board.
   * Used to detect clicks that start in the border and drag into the board.
   * Returns null if not applicable or not found.
   */
  findBorderElement?(): HTMLElement | null

  /**
   * Get the board configuration (dimensions, mine count, cell size).
   * Returns null if the configuration cannot be determined.
   */
  getBoardConfig(): BoardConfig | null

  /**
   * Get mine positions from the DOM (if available).
   * Usually only available after the game ends and mines are revealed.
   * Returns empty array if mine positions cannot be determined.
   *
   * @param result — The game result. On a win, cells still in 'closed' state
   *   are guaranteed to be mines (all non-mines have been opened), so adapters
   *   should include them even if the site hasn't animated them to flags yet.
   */
  getMinePositions?(result?: GameResult): BoardPosition[]

  /**
   * Register a callback for game end detection.
   * The callback should be called with the game result when the game ends.
   */
  onGameEnd?(callback: (result: GameResult) => void): void

  /**
   * Watch for the board to reset to a fresh game state after a game has ended.
   * Used in multi-game sessions to detect when the player starts a new game.
   * The callback fires once when the board resets, then the watcher is cleaned up.
   */
  onBoardReset?(callback: () => void): void

  /**
   * Cancel a pending board reset watcher set up by onBoardReset.
   */
  cancelBoardReset?(): void

  /**
   * Cancel the game end watcher set up by onGameEnd.
   */
  cancelGameEnd?(): void

  /**
   * Watch for the board layout to change (e.g., user switched difficulty).
   * Fires when cells are added/removed from the board, indicating a different
   * board configuration. Does NOT fire for same-size restarts where cells
   * only have their classes changed.
   *
   * Unlike onBoardReset (one-shot, per-game), this persists for the session.
   */
  onBoardChange?(callback: () => void): void

  /**
   * Cancel the board change watcher set up by onBoardChange.
   */
  cancelBoardChange?(): void

  // --------------------------------------------------------------------------
  // Settings detection
  // --------------------------------------------------------------------------

  /**
   * Whether the current page is the site's settings/configuration page.
   * Used by the content script to know when to parse settings.
   */
  isSettingsPage?(): boolean

  /**
   * Read game settings from the current page's DOM.
   * Only meaningful when isSettingsPage() returns true.
   * Returns null if settings cannot be read.
   */
  readSettings?(): GameSettings | null

  /**
   * Watch for settings changes on the settings page (e.g., user changes a dropdown).
   * Calls back whenever a relevant setting changes.
   */
  watchSettings?(callback: (settings: GameSettings) => void): void

  /**
   * Stop watching for settings changes (cleanup).
   */
  cancelWatchSettings?(): void
}

// ============================================================================
// Adapter registry
// ============================================================================

/**
 * All registered site adapters, checked in order.
 * More specific adapters should come before generic ones.
 */
const SITE_ADAPTERS: SiteAdapter[] = [
  createMinesweeperOnlineAdapter(),
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
