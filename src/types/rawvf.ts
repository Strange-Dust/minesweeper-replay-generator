/**
 * Types for RAWVF replay file generation.
 *
 * RAWVF is a plain-text format containing:
 *   - Description: key-value header pairs (board config, player info, etc.)
 *   - Board: mine grid layout (* = mine, 0 = safe)
 *   - Events: mouse events
 *
 * Coordinate conventions:
 *   - Board positions use (row, col) — row always comes first
 *   - Pixel positions use (x, y) — x = horizontal, y = vertical
 *   - RAWVF file format uses 1-indexed (col, row) for cells in the event stream
 */

// ============================================================================
// Board types
// ============================================================================

/**
 * A position on the minesweeper board grid.
 * Row always comes first (see coordinate conventions in project docs).
 */
export interface BoardPosition {
  row: number
  col: number
}

/**
 * Board configuration for a minesweeper game.
 */
export interface BoardConfig {
  /** Number of columns (width) */
  cols: number
  /** Number of rows (height) */
  rows: number
  /** Total number of mines */
  mines: number
  /** Cell size in pixels (default: 16) */
  squareSize: number
}

// ============================================================================
// Event types
// ============================================================================

/**
 * Mouse event codes used in RAWVF format.
 *
 * lc = left click (button down)
 * lr = left release (button up)
 * rc = right click (button down)
 * rr = right release (button up)
 * mc = middle click (button down)
 * mr = middle release (button up)
 * mv = mouse move
 * sc = left click with shift held
 */
export type MouseEventCode = 'lc' | 'lr' | 'rc' | 'rr' | 'mc' | 'mr' | 'mv' | 'sc'

/**
 * A recorded mouse event.
 */
export interface RecordedMouseEvent {
  type: 'mouse'
  /** Time in milliseconds since the game started */
  timeMs: number
  /** Mouse event code */
  event: MouseEventCode
  /** Pixel X coordinate relative to the board */
  x: number
  /** Pixel Y coordinate relative to the board */
  y: number
}

// ============================================================================
// Description / metadata types
// ============================================================================

/**
 * Game result status.
 */
export type GameResult = 'won' | 'lost' | 'unknown'

/**
 * Standard level names determined by board dimensions.
 */
export type LevelName = 'Beginner' | 'Intermediate' | 'Expert' | 'Custom'

/**
 * Metadata for the RAWVF description header.
 */
export interface ReplayMetadata {
  /** Player name (optional) */
  player?: string
  /** Source program / website name */
  program: string
  /** Version of the source program (optional) */
  version?: string
  /** ISO timestamp of when the game was played */
  timestamp?: string
  /** Whether question marks are enabled */
  questionMarks: boolean
}

// ============================================================================
// Recording state
// ============================================================================

/**
 * Current state of the recording system.
 */
export type RecordingState = 'idle' | 'ready' | 'recording' | 'finished'

/**
 * Complete recording data for a single game, sufficient to produce a RAWVF file.
 */
export interface RecordingData {
  /** Board configuration */
  board: BoardConfig
  /** Mine positions (row, col), 0-indexed */
  minePositions: BoardPosition[]
  /** All recorded mouse events in chronological order */
  events: RecordedMouseEvent[]
  /** Metadata for the description header */
  metadata: ReplayMetadata
  /** Game result */
  result: GameResult
  /** Total elapsed time in milliseconds */
  totalTimeMs: number
}
