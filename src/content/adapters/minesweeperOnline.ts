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
import type { BoardConfig, BoardPosition, GameResult } from '../../types/rawvf'
import type { GameSettings, ChordingMode } from '../../types/settings'
import { DEFAULT_SETTINGS } from '../../types/settings'

/** Known cell state suffixes — used to validate class names extracted from cell elements. */
const VALID_CELL_SUFFIXES = new Set([
  'closed', 'flag', 'pressed',
  'type0', 'type1', 'type2', 'type3', 'type4', 'type5', 'type6', 'type7', 'type8',
  'type10', 'type11', 'type12',
])

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
 * Extract all valid state suffixes from a cell element's classes.
 * Given a skin prefix like "hdd", looks for classes like "hdd_closed", "hdd_type3", etc.
 * Returns an array of suffixes (e.g. ["closed", "flag"]). A cell can have multiple
 * state classes simultaneously (e.g. xp_closed + xp_flag on a flagged cell).
 */
function extractStateSuffixes(cellElement: Element, skinPrefix: string): string[] {
  const prefix = skinPrefix + '_'
  const suffixes: string[] = []
  for (const cls of cellElement.classList) {
    if (cls.startsWith(prefix)) {
      const suffix = cls.slice(prefix.length)
      if (VALID_CELL_SUFFIXES.has(suffix)) {
        suffixes.push(suffix)
      }
    }
  }
  return suffixes
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

  // Different skins may use hyphens or underscores as separators
  // (e.g. "hdd-face-win" vs "hdd_face_win"), so check both patterns.
  for (const cls of face.classList) {
    if (cls.includes('face-win') || cls.includes('face_win')) return 'won'
    if (cls.includes('face-lose') || cls.includes('face_lose')) return 'lost'
  }
  return null
}

/**
 * Extract the (row, col) position from a cell DOM element.
 * data-x = column, data-y = row (0-indexed).
 */
function extractCellPosition(cellElement: Element): { row: number; col: number } | null {
  const xAttr = cellElement.getAttribute('data-x')
  const yAttr = cellElement.getAttribute('data-y')
  if (xAttr === null || yAttr === null) return null
  return {
    col: parseInt(xAttr, 10),
    row: parseInt(yAttr, 10),
  }
}

// ============================================================================
// Settings page parsing
// ============================================================================

/**
 * Map minesweeper.online's chording select values to our ChordingMode type.
 *
 * Select #property_chording:
 *   "1" = Left click (SuperClick)
 *   "2" = Left+right click (traditional chording)
 *   "3" = Disabled
 */
function parseChordingValue(value: string): ChordingMode {
  switch (value) {
    case '1': return 'superclick'
    case '2': return 'both'
    case '3': return 'disabled'
    default: return DEFAULT_SETTINGS.chording
  }
}

/**
 * Read all relevant game settings from the settings page DOM.
 * Returns null if the settings elements are not found (not on settings page).
 * Kept as a fallback — the localStorage bridge is the primary mechanism.
 */
function readSettingsFromDOM(): GameSettings | null {
  const chordingEl = document.querySelector('#property_chording') as HTMLSelectElement | null
  if (!chordingEl) return null  // Not on settings page

  const chording = parseChordingValue(chordingEl.value)

  const keyboardEl = document.querySelector('#property_use_keyboard') as HTMLInputElement | null
  const leftKeyEl = document.querySelector('#property_use_keyboard_left_button') as HTMLSelectElement | null
  const rightKeyEl = document.querySelector('#property_use_keyboard_right_button') as HTMLSelectElement | null

  const keyboardEnabled = keyboardEl?.checked ?? false
  const leftKeyCode = leftKeyEl ? parseInt(leftKeyEl.value, 10) : DEFAULT_SETTINGS.keyboardMouse.leftKeyCode
  const rightKeyCode = rightKeyEl ? parseInt(rightKeyEl.value, 10) : DEFAULT_SETTINGS.keyboardMouse.rightKeyCode

  return {
    chording,
    keyboardMouse: {
      enabled: keyboardEnabled,
      leftKeyCode: isNaN(leftKeyCode) ? DEFAULT_SETTINGS.keyboardMouse.leftKeyCode : leftKeyCode,
      rightKeyCode: isNaN(rightKeyCode) ? DEFAULT_SETTINGS.keyboardMouse.rightKeyCode : rightKeyCode,
    },
  }
}

/**
 * Parse settings from the site's localStorage values.
 *
 * Key mapping (from minesweeper.online localStorage):
 *   _chording:                    "1" = superclick, "2" = both (L+R), "3" = disabled
 *   _use_keyboard:                "0" = disabled, "1" = enabled
 *   _use_keyboard_left_button:    keyCode as string (e.g. "69" for E)
 *   _use_keyboard_right_button:   keyCode as string (e.g. "65" for A)
 */
function parseLocalStorageSettings(data: Record<string, string | null>): GameSettings {
  const chordingRaw = data['_chording']
  const useKeyboardRaw = data['_use_keyboard']
  const leftKeyRaw = data['_use_keyboard_left_button']
  const rightKeyRaw = data['_use_keyboard_right_button']

  const chording = chordingRaw ? parseChordingValue(chordingRaw) : DEFAULT_SETTINGS.chording
  const keyboardEnabled = useKeyboardRaw === '1'
  const leftKeyCode = leftKeyRaw ? parseInt(leftKeyRaw, 10) : DEFAULT_SETTINGS.keyboardMouse.leftKeyCode
  const rightKeyCode = rightKeyRaw ? parseInt(rightKeyRaw, 10) : DEFAULT_SETTINGS.keyboardMouse.rightKeyCode

  return {
    chording,
    keyboardMouse: {
      enabled: keyboardEnabled,
      leftKeyCode: isNaN(leftKeyCode) ? DEFAULT_SETTINGS.keyboardMouse.leftKeyCode : leftKeyCode,
      rightKeyCode: isNaN(rightKeyCode) ? DEFAULT_SETTINGS.keyboardMouse.rightKeyCode : rightKeyCode,
    },
  }
}

/** localStorage keys that hold game settings on minesweeper.online. */
const SETTINGS_LOCALSTORAGE_KEYS = [
  '_chording',
  '_use_keyboard',
  '_use_keyboard_left_button',
  '_use_keyboard_right_button',
] as const

/**
 * Read settings directly from the page's localStorage.
 *
 * Content scripts share the page's origin, so window.localStorage is the
 * same storage the site's own JS uses — no injection or bridging needed.
 */
function readSettingsFromLocalStorage(): Record<string, string | null> {
  const data: Record<string, string | null> = {}
  for (const key of SETTINGS_LOCALSTORAGE_KEYS) {
    data[key] = localStorage.getItem(key)
  }
  return data
}

/** How often (ms) to re-read localStorage settings. */
const SETTINGS_POLL_INTERVAL_MS = 2000

// ============================================================================
// Adapter implementation
// ============================================================================

export function createMinesweeperOnlineAdapter(): SiteAdapter {
  let faceObserver: MutationObserver | null = null
  let resetObserver: MutationObserver | null = null
  let boardChangeObserver: MutationObserver | null = null

  // Settings polling state
  let settingsPollInterval: ReturnType<typeof setInterval> | null = null
  let cachedLocalStorageSettings: GameSettings | null = null

  const adapter: SiteAdapter = {
    getProgramName() {
      return 'Minesweeper Online'
    },

    getVersion() {
      // No reliable version string available from the DOM
      return ''
    },

    getPlayerName() {
      const el = document.querySelector('.header_username')
      return el?.textContent?.trim() || null
    },

    matches() {
      return window.location.hostname === 'minesweeper.online'
    },

    findBoardElement() {
      return document.querySelector('#AreaBlock') as HTMLElement | null
    },

    findBorderElement() {
      // The #game wrapper includes a visible border/padding around the board
      // (#AreaBlock). Clicks on this border that drag into the board are
      // treated by the site as valid clicks. The wrapper has class "noselect"
      // which prevents text selection and allows the drag behaviour.
      return document.querySelector('#game') as HTMLElement | null
    },

    getBoardConfig(): BoardConfig | null {
      const cells = document.querySelectorAll('#AreaBlock .cell')
      if (cells.length === 0) return null

      const lastCell = cells[cells.length - 1]
      const cols = parseInt(lastCell.getAttribute('data-x') ?? '0', 10) + 1
      const rows = parseInt(lastCell.getAttribute('data-y') ?? '0', 10) + 1
      const squareSize = getCellSize()

      // Mine count is not read here — it is derived from mine positions
      // after the game ends, keeping pre-game DOM reads to a minimum.
      return { cols, rows, mines: 0, squareSize }
    },

    getMinePositions(result?: GameResult): BoardPosition[] {
      // Guard: only read mine positions after a game has ended.
      // During gameplay, cell classes don't reliably indicate mine locations.
      const faceState = detectFaceState()
      console.debug('[MSR] getMinePositions called: result =', result, ', faceState =', faceState)
      if (!result || faceState === null) {
        console.debug('[MSR] getMinePositions: guard failed, returning []')
        return []
      }

      // After a loss: type10 = mine, type11 = blast mine, flag = player-flagged mine
      // After a win: all non-mine cells are opened, so any cell still 'closed'
      //   or 'flag' is a mine. We must include 'closed' because the site's
      //   auto-flag animation may not have run yet when this is called.
      // Always re-read the skin prefix from the DOM. This is called once
      // per game end, so the trivial DOM query cost avoids stale-cache bugs
      // after SPA navigation or skin changes.
      const prefix = getSkinPrefix() ?? 'hdd'
      const mines: BoardPosition[] = []

      const cells = document.querySelectorAll('#AreaBlock .cell')
      for (const cell of cells) {
        const suffixes = extractStateSuffixes(cell, prefix)
        const isMine =
          suffixes.includes('type10') || suffixes.includes('type11') || suffixes.includes('flag') ||
          (result === 'won' && suffixes.includes('closed'))
        if (isMine) {
          const pos = extractCellPosition(cell)
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
      if (!face) {
        console.warn('[MSR] onGameEnd: #top_area_face not found in DOM')
        return
      }

      console.debug('[MSR] onGameEnd: setting up face observer on', face.className)

      // Clean up any previous observer
      if (faceObserver) {
        faceObserver.disconnect()
      }

      faceObserver = new MutationObserver(() => {
        console.debug('[MSR] Face class changed:', face.className)
        const result = detectFaceState()
        console.debug('[MSR] detectFaceState() =', result)
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

    cancelGameEnd() {
      if (faceObserver) {
        faceObserver.disconnect()
        faceObserver = null
      }
    },

    onBoardReset(callback) {
      // Watch the face element for the win/lose class to DISAPPEAR,
      // which indicates the player has started a new game.
      // After a game ends, the face shows win/lose. When the user clicks
      // the face or a cell to start a new game, the face returns to neutral.
      const face = document.querySelector('#top_area_face')
      if (!face) {
        console.warn('[MSR] onBoardReset: #top_area_face not found')
        return
      }

      console.debug('[MSR] onBoardReset: watching for face to return to neutral')

      if (resetObserver) {
        resetObserver.disconnect()
      }

      resetObserver = new MutationObserver(() => {
        const state = detectFaceState()
        console.debug('[MSR] onBoardReset: face changed, detectFaceState() =', state)
        if (!state) {
          // Face no longer shows win/lose — board is resetting
          console.debug('[MSR] Board reset detected')
          resetObserver?.disconnect()
          resetObserver = null
          // Read-only: wait one frame for cells to reset in the DOM
          // before the callback reads fresh board config. No DOM writes.
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

    onBoardChange(callback) {
      // Watch #AreaBlock for child additions/removals. On minesweeper.online,
      // changing difficulty replaces all .cell elements (childList mutation),
      // while same-size restarts only change cell classes (no childList mutation).
      // This distinguishes difficulty switches from normal game restarts.
      const board = document.querySelector('#AreaBlock')
      if (!board) return

      if (boardChangeObserver) {
        boardChangeObserver.disconnect()
      }

      boardChangeObserver = new MutationObserver(() => {
        // Read-only: wait one frame for new cells to fully render. No DOM writes.
        requestAnimationFrame(() => callback())
      })

      boardChangeObserver.observe(board, { childList: true })
    },

    cancelBoardChange() {
      if (boardChangeObserver) {
        boardChangeObserver.disconnect()
        boardChangeObserver = null
      }
    },

    // ------------------------------------------------------------------
    // Settings detection
    // ------------------------------------------------------------------

    isSettingsPage() {
      return window.location.pathname === '/settings'
    },

    readSettings(): GameSettings | null {
      // Prefer cached localStorage values (available on any page)
      if (cachedLocalStorageSettings) return cachedLocalStorageSettings
      // Fall back to DOM parsing if on settings page
      return readSettingsFromDOM()
    },

    initSettingsBridge(callback) {
      // Already running — don't double-init
      if (settingsPollInterval) return

      /**
       * Read settings directly from localStorage and notify if changed.
       * Content scripts share the page's origin, so localStorage is
       * the same storage the site's own JS uses — zero injection needed.
       */
      const pollSettings = () => {
        const data = readSettingsFromLocalStorage()
        const settings = parseLocalStorageSettings(data)
        const changed = JSON.stringify(settings) !== JSON.stringify(cachedLocalStorageSettings)
        cachedLocalStorageSettings = settings

        if (changed) {
          console.debug('[MSR] Settings from localStorage:', settings)
          callback(settings)
        }
      }

      // Initial read
      pollSettings()

      // Re-read periodically to pick up changes
      settingsPollInterval = setInterval(pollSettings, SETTINGS_POLL_INTERVAL_MS)
      console.debug('[MSR] localStorage settings polling started')
    },

    destroySettingsBridge() {
      if (settingsPollInterval) {
        clearInterval(settingsPollInterval)
        settingsPollInterval = null
      }
      cachedLocalStorageSettings = null
    },
  }

  return adapter
}
