/**
 * Site adapter for minesweeper.online
 *
 * DOM structure (as of 2026):
 *   - Game wrapper: #game (has class skin_{skinName} and style width)
 *   - Board area: #AreaBlock (contains .cell elements and .clear row dividers)
 *   - Cells: .cell elements with id="cell_{x}_{y}", data-x, data-y attributes
 *   - Cell size: .size{N} class on each cell (e.g. size24)
 *   - Cell state: {skinPrefix}_{state} class on each cell
 *   - Face: #top_area_face indicates game state (unpressed, win, lose)
 *   - Mine counter: #top_area_mines_100, #top_area_mines_10, #top_area_mines_1
 *
 * Skin system:
 *   The site supports multiple visual skins (hdd, xp, nn, hd, al, etc.).
 *   The active skin is indicated by a skin_{name} class on #game.
 *   Cell state classes are prefixed with the skin name: {skin}_{state}.
 *   All skins share the same state suffixes, so we extract the suffix only.
 *
 * Cell state suffixes:
 *   closed       — unopened cell
 *   flag         — flagged cell
 *   pressed      — cell being pressed (mouse button held)
 *   type0        — revealed empty (0 adjacent mines)
 *   type1..type8 — revealed number (1–8 adjacent mines)
 *   type10       — mine (revealed after loss)
 *   type11       — mine that was clicked (blast / the losing mine)
 *   type12       — incorrectly flagged cell (revealed after loss)
 *
 * Note: data-x = column, data-y = row (0-indexed).
 */

import type { SiteAdapter } from '../siteAdapters'
import type { BoardConfig, BoardPosition, BoardEventCode, GameResult } from '../../types/rawvf'

// Map of cell state suffixes to RAWVF board event codes
const STATE_MAP: Record<string, BoardEventCode> = {
  closed: 'closed',
  flag: 'flag',
  pressed: 'pressed',
  type0: 'number0',
  type1: 'number1',
  type2: 'number2',
  type3: 'number3',
  type4: 'number4',
  type5: 'number5',
  type6: 'number6',
  type7: 'number7',
  type8: 'number8',
  type10: 'closed',   // mine shown post-game — treat as closed for RAWVF
  type11: 'blast',    // the mine that was clicked
  type12: 'closed',   // wrong flag shown post-game — treat as closed for RAWVF
}

/**
 * Extract the active skin prefix from the #game element.
 * Returns e.g. "hdd" from class "skin_hdd".
 */
function getSkinPrefix(): string | null {
  const game = document.querySelector('#game')
  if (!game) return null

  for (const cls of game.classList) {
    if (cls.startsWith('skin_')) {
      return cls.slice(5) // strip "skin_"
    }
  }
  return null
}

/**
 * Extract the cell state suffix from a cell element's classes.
 * Given a skin prefix like "hdd", looks for classes like "hdd_closed", "hdd_type3", etc.
 * Returns the suffix (e.g. "closed", "type3") or null.
 */
function extractStateSuffix(cellElement: Element, skinPrefix: string): string | null {
  const prefix = skinPrefix + '_'
  for (const cls of cellElement.classList) {
    if (cls.startsWith(prefix)) {
      const suffix = cls.slice(prefix.length)
      // Skip non-state classes (e.g. hdd_closed_flag is a sub-skin class)
      if (suffix in STATE_MAP) {
        return suffix
      }
    }
  }
  return null
}

/**
 * Read the mine counter from the top panel digit elements.
 * Each digit element has a class like {skin}_top-area-num{digit}.
 */
function readMineCounter(skinPrefix: string): number | null {
  const elements = [
    document.querySelector('#top_area_mines_100'),
    document.querySelector('#top_area_mines_10'),
    document.querySelector('#top_area_mines_1'),
  ]

  let total = 0
  const multipliers = [100, 10, 1]

  for (let i = 0; i < elements.length; i++) {
    const el = elements[i]
    if (!el) return null

    let digit: number | null = null
    for (const cls of el.classList) {
      const match = cls.match(/top-area-num(\d)$/)
      if (match) {
        digit = parseInt(match[1], 10)
        break
      }
    }

    if (digit === null) return null
    total += digit * multipliers[i]
  }

  return total
}

/**
 * Get the cell pixel size from the size class on a cell element.
 * Returns e.g. 24 from class "size24".
 */
function getCellSize(): number {
  const cell = document.querySelector('.cell')
  if (!cell) return 24 // default

  for (const cls of cell.classList) {
    const match = cls.match(/^size(\d+)$/)
    if (match) {
      return parseInt(match[1], 10)
    }
  }
  return 24
}

/**
 * Detect game end state from the face element's classes.
 * Returns 'won', 'lost', or null if game is still in progress.
 */
function detectFaceState(): 'won' | 'lost' | null {
  const face = document.querySelector('#top_area_face')
  if (!face) return null

  for (const cls of face.classList) {
    if (cls.endsWith('-face-win')) return 'won'
    if (cls.endsWith('-face-lose')) return 'lost'
  }
  return null
}

// ============================================================================
// Adapter implementation
// ============================================================================

export function createMinesweeperOnlineAdapter(): SiteAdapter {
  // Cache the skin prefix to avoid re-querying on every cell state extraction
  let cachedSkinPrefix: string | null = null
  let faceObserver: MutationObserver | null = null
  let resetObserver: MutationObserver | null = null

  function skinPrefix(): string {
    if (!cachedSkinPrefix) {
      cachedSkinPrefix = getSkinPrefix()
    }
    return cachedSkinPrefix ?? 'hdd'
  }

  const adapter: SiteAdapter = {
    getProgramName() {
      return 'Minesweeper Online'
    },

    getVersion() {
      // No reliable version string available from the DOM
      return ''
    },

    matches() {
      return window.location.hostname === 'minesweeper.online'
    },

    findBoardElement() {
      return document.querySelector('#AreaBlock') as HTMLElement | null
    },

    getBoardConfig(): BoardConfig | null {
      const cells = document.querySelectorAll('#AreaBlock .cell')
      if (cells.length === 0) return null

      const lastCell = cells[cells.length - 1]
      const cols = parseInt(lastCell.getAttribute('data-x') ?? '0', 10) + 1
      const rows = parseInt(lastCell.getAttribute('data-y') ?? '0', 10) + 1
      const mines = readMineCounter(skinPrefix()) ?? 0
      const squareSize = getCellSize()

      return { cols, rows, mines, squareSize }
    },

    getCellSelector() {
      return '.cell'
    },

    extractCellState(cellElement: Element): BoardEventCode | null {
      const suffix = extractStateSuffix(cellElement, skinPrefix())
      if (!suffix) return null
      return STATE_MAP[suffix] ?? null
    },

    extractCellPosition(cellElement: Element): { row: number; col: number } | null {
      const xAttr = cellElement.getAttribute('data-x')
      const yAttr = cellElement.getAttribute('data-y')
      if (xAttr === null || yAttr === null) return null

      // data-x = column, data-y = row
      return {
        col: parseInt(xAttr, 10),
        row: parseInt(yAttr, 10),
      }
    },

    getMinePositions(result?: GameResult): BoardPosition[] {
      // Guard: only read mine positions after a game has ended.
      // During gameplay, cell classes don't reliably indicate mine locations.
      if (!result || detectFaceState() === null) {
        return []
      }

      // After a loss: type10 = mine, type11 = blast mine, flag = player-flagged mine
      // After a win: all non-mine cells are opened, so any cell still 'closed'
      //   or 'flag' is a mine. We must include 'closed' because the site's
      //   auto-flag animation may not have run yet when this is called.
      const prefix = skinPrefix()
      const mines: BoardPosition[] = []

      const cells = document.querySelectorAll('#AreaBlock .cell')
      for (const cell of cells) {
        const suffix = extractStateSuffix(cell, prefix)
        const isMine =
          suffix === 'type10' || suffix === 'type11' || suffix === 'flag' ||
          (result === 'won' && suffix === 'closed')
        if (isMine) {
          const pos = adapter.extractCellPosition(cell)
          if (pos) {
            mines.push(pos)
          }
        }
      }

      return mines
    },

    onGameEnd(callback) {
      // Watch the face element for class changes that indicate win/loss
      const face = document.querySelector('#top_area_face')
      if (!face) return

      // Clean up any previous observer
      if (faceObserver) {
        faceObserver.disconnect()
      }

      faceObserver = new MutationObserver(() => {
        const result = detectFaceState()
        if (result) {
          callback(result)
          // Stop observing after game ends
          faceObserver?.disconnect()
          faceObserver = null
        }
      })

      faceObserver.observe(face, {
        attributes: true,
        attributeFilter: ['class'],
      })
    },

    onBoardReset(callback) {
      // Watch the face element for the win/lose class to DISAPPEAR,
      // which indicates the player has started a new game.
      // After a game ends, the face shows win/lose. When the user clicks
      // the face or a cell to start a new game, the face returns to neutral.
      const face = document.querySelector('#top_area_face')
      if (!face) return

      if (resetObserver) {
        resetObserver.disconnect()
      }

      resetObserver = new MutationObserver(() => {
        const state = detectFaceState()
        if (!state) {
          // Face no longer shows win/lose — board is resetting
          resetObserver?.disconnect()
          resetObserver = null
          // Wait a frame for the DOM to fully settle (cells reset too)
          requestAnimationFrame(() => callback())
        }
      })

      resetObserver.observe(face, {
        attributes: true,
        attributeFilter: ['class'],
      })
    },

    cancelBoardReset() {
      if (resetObserver) {
        resetObserver.disconnect()
        resetObserver = null
      }
    },
  }

  return adapter
}
