/**
 * RAWVF file writer.
 *
 * Generates a complete .rawvf replay file from recorded game data.
 *
 * RAWVF format structure:
 *   1. Description — key-value header lines (metadata, board config)
 *   2. Board — mine grid ('*' = mine, '0' = safe)
 *   3. Events — chronological mouse, board, and game events
 *
 * Reference: rawvf spec.md (RawVF Rev6.1)
 */

import type {
  RecordingData,
  RecordedMouseEvent,
  RecordedBoardEvent,
  RecordedGameEvent,
  LevelName,
} from '../types/rawvf'

// ============================================================================
// Public API
// ============================================================================

/**
 * Generate a complete RAWVF file as a string from recording data.
 */
export function generateRawvf(recording: RecordingData): string {
  const description = buildDescription(recording)
  const board = buildBoard(recording)
  const events = buildEvents(recording)

  return `${description}\n${board}\n${events}\n`
}

/**
 * Generate a RAWVF file and return it as a downloadable Blob.
 */
export function generateRawvfBlob(recording: RecordingData): Blob {
  const content = generateRawvf(recording)
  return new Blob([content], { type: 'text/plain' })
}

/**
 * Generate a suggested filename for the RAWVF export.
 * Format: "replay_YYYYMMDD_HHMMSS.rawvf"
 */
export function generateFilename(recording: RecordingData): string {
  const level = getLevelName(
    recording.board.cols,
    recording.board.rows,
    recording.board.mines
  )
  const timeSec = (recording.totalTimeMs / 1000).toFixed(3)
  const dateStr = formatDateForFilename(recording.metadata.timestamp)

  return `${level}_${timeSec}s_${dateStr}.rawvf`
}

// ============================================================================
// Description section
// ============================================================================

/**
 * Build the RAWVF description (header) section.
 *
 * Contains key-value pairs with game metadata, board configuration,
 * and settings. Each line is "Key: Value".
 */
function buildDescription(recording: RecordingData): string {
  const { board, metadata, result, totalTimeMs } = recording
  const lines: string[] = []

  lines.push('RawVF_Version: Rev6.1')
  lines.push(`Program: ${metadata.program}`)

  if (metadata.version) {
    lines.push(`Version: ${metadata.version}`)
  }

  if (metadata.player) {
    lines.push(`Player: ${metadata.player}`)
  }

  if (metadata.timestamp) {
    lines.push(`Timestamp: ${metadata.timestamp}`)
  }

  // Level
  const level = getLevelName(board.cols, board.rows, board.mines)
  lines.push(`Level: ${level}`)

  // Board dimensions
  lines.push(`Width: ${board.cols}`)
  lines.push(`Height: ${board.rows}`)
  lines.push(`Mines: ${board.mines}`)

  // Settings
  lines.push(`Marks: ${metadata.questionMarks ? 'On' : 'Off'}`)

  if (board.squareSize !== 16) {
    lines.push(`SquareSize: ${board.squareSize}`)
  }

  // Time
  lines.push(`Time: ${formatRawvfTime(totalTimeMs)}`)

  // Status
  if (result === 'won') {
    lines.push('Status: won')
  } else if (result === 'lost') {
    lines.push('Status: lost')
  }

  // Mode
  lines.push('Mode: Classic')

  return lines.join('\n')
}

// ============================================================================
// Board section
// ============================================================================

/**
 * Build the RAWVF board section.
 *
 * Creates a text grid where '*' represents mines and '0' represents safe cells.
 * The grid is rows × cols in size.
 */
function buildBoard(recording: RecordingData): string {
  const { board, minePositions } = recording

  // Create a 2D grid initialized to '0' (safe)
  const grid: string[][] = []
  for (let row = 0; row < board.rows; row++) {
    grid.push(new Array(board.cols).fill('0'))
  }

  // Place mines
  for (const mine of minePositions) {
    if (mine.row >= 0 && mine.row < board.rows && mine.col >= 0 && mine.col < board.cols) {
      grid[mine.row]![mine.col] = '*'
    }
  }

  const lines = ['Board:']
  for (const row of grid) {
    lines.push(row.join(''))
  }

  return lines.join('\n')
}

// ============================================================================
// Events section
// ============================================================================

/**
 * Build the RAWVF events section from recorded events.
 *
 * Event format (from spec):
 *   Mouse:  <time> <event_code> <col_1indexed> <row_1indexed> (<pixel_x> <pixel_y>)
 *   Board:  <event_code> <col_1indexed> <row_1indexed>
 *   Game:   <time> <event_code>
 */
function buildEvents(recording: RecordingData): string {
  const lines: string[] = ['Events:']
  const squareSize = recording.board.squareSize

  for (const event of recording.events) {
    switch (event.type) {
      case 'mouse':
        lines.push(formatMouseEvent(event, squareSize))
        break
      case 'board':
        lines.push(formatBoardEvent(event))
        break
      case 'game':
        lines.push(formatGameEvent(event))
        break
    }
  }

  return lines.join('\n')
}

/**
 * Format a mouse event as a RAWVF event line.
 *
 * Format: <time> <code> <col_1indexed> <row_1indexed> (<pixel_x> <pixel_y>)
 *
 * Cell coordinates are 1-indexed in RAWVF (col first, then row).
 */
function formatMouseEvent(event: RecordedMouseEvent, squareSize: number): string {
  const time = formatRawvfTime(event.timeMs)
  const cellCol = pixelToCell1Indexed(event.x, squareSize)
  const cellRow = pixelToCell1Indexed(event.y, squareSize)

  return `${time} ${event.event} ${cellCol} ${cellRow} (${event.x} ${event.y})`
}

/**
 * Format a board event as a RAWVF event line.
 *
 * Format: <event_code> <col_1indexed> <row_1indexed>
 *
 * Board event coordinates are converted from 0-indexed (internal) to 1-indexed (RAWVF).
 */
function formatBoardEvent(event: RecordedBoardEvent): string {
  return `${event.event} ${event.col + 1} ${event.row + 1}`
}

/**
 * Format a game event as a RAWVF event line.
 *
 * Format: <time> <event_code>
 */
function formatGameEvent(event: RecordedGameEvent): string {
  return `${formatRawvfTime(event.timeMs)} ${event.event}`
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Format a millisecond timestamp as a RAWVF time string.
 *
 * RAWVF uses seconds with millisecond precision: "seconds.thousandths"
 * Examples: 5600 → "5.600", 0 → "0.000", 123 → "0.123"
 */
function formatRawvfTime(timeMs: number): string {
  const negative = timeMs < 0
  const absMs = Math.abs(timeMs)
  const seconds = Math.floor(absMs / 1000)
  const millis = absMs % 1000
  const prefix = negative ? '-' : ''
  return `${prefix}${seconds}.${millis.toString().padStart(3, '0')}`
}

/**
 * Convert a pixel coordinate to a 1-indexed cell coordinate.
 *
 * RAWVF cell coordinates are 1-indexed. A pixel at position 0 through
 * (squareSize - 1) maps to cell 1.
 */
function pixelToCell1Indexed(pixel: number, squareSize: number): number {
  if (pixel < 0) return 0
  return Math.floor(pixel / squareSize) + 1
}

/**
 * Determine the standard level name from board dimensions.
 */
function getLevelName(cols: number, rows: number, mines: number): LevelName {
  if (cols === 8 && rows === 8 && mines === 10) return 'Beginner'
  if (cols === 16 && rows === 16 && mines === 40) return 'Intermediate'
  if (cols === 30 && rows === 16 && mines === 99) return 'Expert'
  return 'Custom'
}

/**
 * Format a date string for use in filenames.
 * Returns "YYYYMMDD_HHMMSS" or "unknown" if no timestamp.
 */
function formatDateForFilename(timestamp?: string): string {
  if (!timestamp) {
    const now = new Date()
    return now.toISOString().replace(/[-:T]/g, '').slice(0, 15).replace(/(\d{8})(\d{6})/, '$1_$2')
  }
  try {
    const date = new Date(timestamp)
    return date.toISOString().replace(/[-:T]/g, '').slice(0, 15).replace(/(\d{8})(\d{6})/, '$1_$2')
  } catch {
    return 'unknown'
  }
}
