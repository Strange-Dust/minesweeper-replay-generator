import type { ChordingMode } from './settings'

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
  /**
   * The raw DOM event timeStamp (DOMHighResTimeStamp).
   * Used internally by the recorder for precise game-start rebasing.
   * Not written to the RAWVF output.
   */
  rawTimestamp: number
}

/**
 * Board event codes used in RAWVF format (see rawvf spec.md §4.2).
 *
 * Board events represent something happening on the board as a result of
 * player actions (or, for PVP local-area resets, server-driven changes).
 * They carry no timestamp of their own — they use the time of the
 * preceding mouse event.
 */
export type BoardEventCode =
  | 'number0' | 'number1' | 'number2' | 'number3' | 'number4'
  | 'number5' | 'number6' | 'number7' | 'number8'
  | 'closed'
  | 'flag'
  | 'pressed'
  | 'questionmark'
  | 'pressedqm'
  | 'blast'
  | 'reset'

/**
 * A recorded board event. Currently only produced by the WoM PVP converter
 * (`womConverter.ts`) to represent explicit reveals/flags/resets — never by
 * the live browser recorder.
 */
export interface RecordedBoardEvent {
  type: 'board'
  /** Column, 0-indexed. Writer converts to 1-indexed on output. */
  col: number
  /** Row, 0-indexed. Writer converts to 1-indexed on output. */
  row: number
  /** Board event code */
  event: BoardEventCode
}

/** A single event in the RAWVF event stream — either a mouse or board event. */
export type RecordedEvent = RecordedMouseEvent | RecordedBoardEvent

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
  | 'Easy' | 'Medium' | 'Hard' | 'Evil'

/**
 * Game mode: Classic, No Guess, or PVP (duel).
 */
export type GameMode = 'Classic' | 'No Guess' | 'PVP'

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
  /** URL of the game (optional, site-specific) */
  url?: string
  /** Opponent's player name/id (PVP only, optional) */
  opponent?: string
  /** URL of the opponent's game (PVP only, optional, site-specific) */
  opponentUrl?: string
  /** ISO timestamp of when the game was played */
  timestamp?: string
  /** Whether question marks are enabled */
  questionMarks: boolean
  /** Chording mode used during the game (for SuperClick field) */
  chordingMode?: ChordingMode
  /**
   * WoM level code (optional). Used to determine level name and game mode.
   * Classic: 1=Beginner, 2=Intermediate, 3=Expert, 4=Custom
   * No Guess: 11=Easy, 12=Medium, 13=Hard, 14=Evil, 15=Custom
   */
  levelCode?: number
  /** Whether this game is a PVP (duel) game. Forces Mode to 'PVP'. */
  isPvp?: boolean
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
  /**
   * All recorded events in chronological order. Board events (PVP only)
   * are interleaved after the mouse events of the click that produced them.
   */
  events: RecordedEvent[]
  /** Metadata for the description header */
  metadata: ReplayMetadata
  /** Game result */
  result: GameResult
  /** Total elapsed time in milliseconds */
  totalTimeMs: number
}
