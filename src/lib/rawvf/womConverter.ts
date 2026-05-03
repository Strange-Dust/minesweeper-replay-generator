/**
 * Converter from minesweeper.online (WoM) server replay data to RecordingData.
 *
 * WoM's socket.io 203 response provides replay data as a JSON array:
 *   [gameMeta, boardData, clicks, [], [], null, duration, 0]
 *
 * This module parses that structure and produces a RecordingData object
 * that the existing RAWVF writer can render into a .rawvf file.
 *
 * Data format (from WoM WebSocket / replay API):
 *   - gameMeta: { id, sizeX, sizeY, mines, state, duration, nf, bbbv, ... }
 *   - boardData: { t: number[], o: number[], f: number[] }
 *       t = tile values: 0–8 = numbers, 10 = mine (flat array, column-major / x-first)
 *       o = opened state: 1 = opened, 0 = closed
 *       f = flagged state: 1 = flagged, 0 = not
 *   - clicks: Array<{ type, time, x, y, touchCells }>
 *       type: 0 = left click (open), 1 = right click (flag), 3 = chord
 *       time: milliseconds since game start
 *       x: column (0-indexed), y: row (0-indexed)
 *
 *   - gameMeta.state values: 3 = won, 4 = lost (based on observed data)
 */

import type {
  RecordingData,
  RecordedMouseEvent,
  BoardPosition,
  GameResult,
} from '../types/rawvf'
import type { ChordingMode } from '../types/settings'

// ============================================================================
// Types — WoM replay data structures
// ============================================================================

/** Game metadata from WoM 203 response (index 0 of the data array). */
interface WomGameMeta {
  id: number
  sizeX: number  // columns
  sizeY: number  // rows
  mines: number
  state: number  // 3 = won, 4 = lost
  duration: number  // ms
  nf: number  // 1 = no-flag mode
  clickType: number  // chording mode: 1 = superclick (L only), 2 = both (L+R), 3 = disabled
  bbbv?: number
  bbbvs?: number  // 3BV/s * 1_000_000 (integer, divide by 1e6 for actual value)
  eff100?: number  // IOE * 100
  clicks?: number
  mobile?: number  // 0 = desktop, 1 = mobile
  createdAt?: string
  finishedAt?: string
  userId?: number
  level?: number  // 1 = beginner, 2 = intermediate, 3 = expert, 4 = custom
}

/** Board data from WoM 203 response (index 1 of the data array). */
interface WomBoardData {
  /** Tile values: 0–8 = number, 10 = mine. Flat array, row-major order. */
  t: number[]
  /** Opened state: 1 = opened, 0 = closed. */
  o: number[]
  /** Flagged state: 1 = flagged, 0 = not. */
  f: number[]
}

/** A single click from WoM 203 response (index 2 of the data array). */
interface WomClick {
  /** Click type: 0 = left (open), 1 = right (flag), 3 = chord. */
  type: number
  /** Time in milliseconds since game start. */
  time: number
  /** Column (0-indexed). */
  x: number
  /** Row (0-indexed). */
  y: number
  /** Cells affected by this click (not used for RAWVF conversion). */
  touchCells?: number[]
}

// ============================================================================
// Constants
// ============================================================================

/** Default cell pixel size for converted replays. */
const DEFAULT_SQUARE_SIZE = 16

/** WoM game state values. */
const WOM_STATE_WON = 3
const WOM_STATE_LOST = 2

// ============================================================================
// Simulated mouse movement tuning constants
// ============================================================================

/** How long before a click the mouse starts moving toward it (ms). */
const MOVE_LEAD_TIME_MS = 500

/** Interval between simulated mouse move events (ms). */
const MOVE_STEP_INTERVAL_MS = 15

// ============================================================================
// Public API
// ============================================================================

export interface WomConversionResult {
  recording: RecordingData
  gameId: number
}

/**
 * Convert WoM 203 replay data to RecordingData for RAWVF generation.
 *
 * @param data The replay data array from the WoM 203 WebSocket response.
 * @returns Conversion result with the RecordingData and game ID.
 * @throws Error if the data format is invalid or missing required fields.
 */
export function convertWomReplay(data: unknown): WomConversionResult {
  if (!Array.isArray(data) || data.length < 3) {
    throw new Error('Invalid WoM replay data: expected array with at least 3 elements')
  }

  const gameMeta = validateGameMeta(data[0])
  const boardData = validateBoardData(data[1], gameMeta.sizeX, gameMeta.sizeY)
  const clicks = validateClicks(data[2])

  const cols = gameMeta.sizeX
  const rows = gameMeta.sizeY

  // Extract mine positions from the tile array (column-major, needs rows)
  const minePositions = extractMinePositions(boardData.t, rows)

  // Determine chording mode from clickType metadata
  const chordingMode = resolveChordingMode(gameMeta.clickType)

  // Convert WoM clicks to RAWVF mouse events, then add simulated movement
  const clickEvents = convertClicks(clicks, DEFAULT_SQUARE_SIZE, chordingMode)
  const events = generateMouseMovement(clickEvents)

  // Determine game result
  const result = resolveGameResult(gameMeta.state)

  // Use the duration from gameMeta (most reliable source)
  const totalTimeMs = gameMeta.duration

  const recording: RecordingData = {
    board: {
      cols,
      rows,
      mines: gameMeta.mines,
      squareSize: DEFAULT_SQUARE_SIZE,
    },
    minePositions,
    events,
    metadata: {
      program: 'Minesweeper Online',
      timestamp: gameMeta.finishedAt ?? gameMeta.createdAt ?? new Date().toISOString(),
      player: gameMeta.userId != null ? String(gameMeta.userId) : undefined,
      questionMarks: false,
      chordingMode,
      url: `https://minesweeper.online/game/${gameMeta.id}`,
      levelCode: gameMeta.level,
    },
    result,
    totalTimeMs,
  }

  return { recording, gameId: gameMeta.id }
}

// ============================================================================
// Validation
// ============================================================================

function validateGameMeta(raw: unknown): WomGameMeta {
  if (!raw || typeof raw !== 'object') {
    throw new Error('Invalid WoM game metadata: expected an object')
  }

  const meta = raw as Record<string, unknown>

  const id = meta.id
  const sizeX = meta.sizeX
  const sizeY = meta.sizeY
  const mines = meta.mines
  const state = meta.state
  const duration = meta.duration

  if (typeof id !== 'number' || typeof sizeX !== 'number' || typeof sizeY !== 'number' ||
      typeof mines !== 'number' || typeof state !== 'number' || typeof duration !== 'number') {
    throw new Error('Invalid WoM game metadata: missing required numeric fields (id, sizeX, sizeY, mines, state, duration)')
  }

  if (sizeX < 1 || sizeX > 100 || sizeY < 1 || sizeY > 100) {
    throw new Error(`Invalid board dimensions: ${sizeX}x${sizeY}`)
  }

  if (mines < 0 || mines > sizeX * sizeY) {
    throw new Error(`Invalid mine count: ${mines} for ${sizeX}x${sizeY} board`)
  }

  return {
    id,
    sizeX,
    sizeY,
    mines,
    state,
    duration,
    nf: typeof meta.nf === 'number' ? meta.nf : 0,
    clickType: typeof meta.clickType === 'number' ? meta.clickType : 0,
    bbbv: typeof meta.bbbv === 'number' ? meta.bbbv : undefined,
    bbbvs: typeof meta.bbbvs === 'number' ? meta.bbbvs : undefined,
    eff100: typeof meta.eff100 === 'number' ? meta.eff100 : undefined,
    clicks: typeof meta.clicks === 'number' ? meta.clicks : undefined,
    mobile: typeof meta.mobile === 'number' ? meta.mobile : undefined,
    createdAt: typeof meta.createdAt === 'string' ? meta.createdAt : undefined,
    finishedAt: typeof meta.finishedAt === 'string' ? meta.finishedAt : undefined,
    userId: typeof meta.userId === 'number' ? meta.userId : undefined,
    level: typeof meta.level === 'number' ? meta.level : undefined,
  }
}

function validateBoardData(raw: unknown, cols: number, rows: number): WomBoardData {
  if (!raw || typeof raw !== 'object') {
    throw new Error('Invalid WoM board data: expected an object')
  }

  const board = raw as Record<string, unknown>
  const expectedLen = cols * rows

  const t = board.t
  if (!Array.isArray(t) || t.length !== expectedLen) {
    throw new Error(`Invalid tile array: expected length ${expectedLen}, got ${Array.isArray(t) ? t.length : 'non-array'}`)
  }

  // o and f are optional (may not be present for all game states)
  const o = Array.isArray(board.o) ? board.o : []
  const f = Array.isArray(board.f) ? board.f : []

  return { t: t as number[], o: o as number[], f: f as number[] }
}

function validateClicks(raw: unknown): WomClick[] {
  if (!Array.isArray(raw)) {
    throw new Error('Invalid WoM clicks: expected an array')
  }

  return raw.map((click, i) => {
    if (!click || typeof click !== 'object') {
      throw new Error(`Invalid click at index ${i}: expected an object`)
    }
    const c = click as Record<string, unknown>
    if (typeof c.type !== 'number' || typeof c.time !== 'number' ||
        typeof c.x !== 'number' || typeof c.y !== 'number') {
      throw new Error(`Invalid click at index ${i}: missing required fields (type, time, x, y)`)
    }
    return {
      type: c.type as number,
      time: c.time as number,
      x: c.x as number,
      y: c.y as number,
    }
  })
}

// ============================================================================
// Coordinate conversion
//
// WoM uses (x, y) where x = column, y = row. This matches standard screen
// coordinates and also matches our pixel convention (x = horizontal, y = vertical).
// Our BoardPosition uses { row, col }, so the mapping is:
//   WoM x → col,  WoM y → row
//
// The tile array is flat and COLUMN-MAJOR (x-first):
//   index = x * sizeY + y = col * rows + row
// This means columns are stored contiguously, not rows.
//
// These helpers are the ONLY place coordinate mapping should happen.
// ============================================================================

/**
 * Convert a flat tile array index to a BoardPosition.
 * The tile array is column-major: index = col * rows + row.
 */
function tileIndexToPosition(index: number, numRows: number): BoardPosition {
  return {
    row: index % numRows,
    col: Math.floor(index / numRows),
  }
}

/**
 * Convert WoM click (x, y) to pixel coordinates (center of the cell).
 * WoM x = column → pixel x (horizontal), WoM y = row → pixel y (vertical).
 */
function womXYToPixel(x: number, y: number, squareSize: number): { px: number; py: number } {
  return {
    px: x * squareSize + Math.floor(squareSize / 2),
    py: y * squareSize + Math.floor(squareSize / 2),
  }
}

// ============================================================================
// Conversion helpers
// ============================================================================

/**
 * Extract mine positions from the WoM tile array.
 * Tile value 10 = mine. Array is column-major (x-first).
 */
function extractMinePositions(tiles: number[], numRows: number): BoardPosition[] {
  const mines: BoardPosition[] = []
  for (let i = 0; i < tiles.length; i++) {
    if (tiles[i] === 10 || tiles[i] === 11) {
      mines.push(tileIndexToPosition(i, numRows))
    }
  }
  return mines
}

/**
 * Map WoM game state to RAWVF game result.
 */
function resolveGameResult(state: number): GameResult {
  if (state === WOM_STATE_WON) return 'won'
  if (state === WOM_STATE_LOST) return 'lost'
  return 'unknown'
}

/**
 * Map WoM clickType metadata to a ChordingMode.
 *
 * clickType matches the site's settings (see parseChordingValue in the adapter):
 *   1 = superclick (left-click-only chord on opened numbered cells)
 *   2 = both (traditional left+right chord)
 *   3 = disabled (no chording)
 */
function resolveChordingMode(clickType: number): ChordingMode {
  if (clickType === 1) return 'superclick'
  if (clickType === 2) return 'both'
  if (clickType === 3) return 'disabled'
  return 'disabled'
}

/**
 * Convert WoM click events to RAWVF mouse events.
 *
 * For each WoM click, generates a press + release pair at the same timestamp.
 * Pixel coordinates are calculated as cell center positions.
 *
 * WoM click types:
 *   0 = left click (open cell) → lc + lr
 *   1 = right click (flag/unflag) → rc + rr
 *   3 = chord → depends on chording mode:
 *       'both': lc + rc + rr + lr (traditional left+right chord)
 *       'superclick': lc + lr (left-click-only chord on opened cell)
 *       'disabled': lc + rc + rr + lr (fallback to traditional)
 */
function convertClicks(clicks: WomClick[], squareSize: number, chordingMode: ChordingMode): RecordedMouseEvent[] {
  const events: RecordedMouseEvent[] = []

  for (const click of clicks) {
    const { px, py } = womXYToPixel(click.x, click.y, squareSize)

    if (click.type === 1) {
      // Right click (flag)
      events.push(makeEvent(click.time, 'rc', px, py))
      events.push(makeEvent(click.time, 'rr', px, py))
    } else if (click.type === 3) {
      // Chord
      if (chordingMode === 'superclick') {
        // SuperClick: left-click on an already-opened numbered cell
        events.push(makeEvent(click.time, 'lc', px, py))
        events.push(makeEvent(click.time, 'lr', px, py))
      } else {
        // Traditional chord: simultaneous left+right press/release
        events.push(makeEvent(click.time, 'lc', px, py))
        events.push(makeEvent(click.time, 'rc', px, py))
        events.push(makeEvent(click.time, 'rr', px, py))
        events.push(makeEvent(click.time, 'lr', px, py))
      }
    } else {
      // Left click (open) — type 0 or default
      events.push(makeEvent(click.time, 'lc', px, py))
      events.push(makeEvent(click.time, 'lr', px, py))
    }
  }

  return events
}

function makeEvent(
  timeMs: number,
  event: RecordedMouseEvent['event'],
  x: number,
  y: number,
): RecordedMouseEvent {
  return { type: 'mouse', timeMs, event, x, y, rawTimestamp: 0 }
}

// ============================================================================
// Simulated mouse movement
//
// WoM data only has click positions and times — no mouse movement.
// To produce a more natural-looking replay, we synthesize straight-line
// mouse movement between clicks. Movement ends when the click lands and
// begins MOVE_LEAD_TIME_MS before it (or immediately after the previous
// click if the gap is shorter).
// ============================================================================

/**
 * Insert simulated mouse movement ('mv') events between click groups.
 *
 * Click groups are sequences of events sharing the same timestamp
 * (e.g. lc+lr for a left click, or lc+rc+rr+lr for a chord).
 * Between each pair of consecutive groups, a straight-line movement
 * is generated from the previous click position to the next.
 */
function generateMouseMovement(events: RecordedMouseEvent[]): RecordedMouseEvent[] {
  // Split events into groups by timestamp
  const groups = groupByTimestamp(events)
  if (groups.length <= 1) return events

  const result: RecordedMouseEvent[] = []

  // Emit first group as-is
  result.push(...groups[0])

  for (let i = 1; i < groups.length; i++) {
    const prevGroup = groups[i - 1]
    const currGroup = groups[i]

    const fromX = prevGroup[0].x
    const fromY = prevGroup[0].y
    const toX = currGroup[0].x
    const toY = currGroup[0].y

    const prevTime = prevGroup[0].timeMs
    const clickTime = currGroup[0].timeMs
    const gap = clickTime - prevTime

    // Movement starts MOVE_LEAD_TIME_MS before the click,
    // but no earlier than immediately after the previous click
    const moveDuration = Math.min(MOVE_LEAD_TIME_MS, gap)
    const moveStart = clickTime - moveDuration

    // Only generate movement if there's a position change and enough time for at least one step
    if ((fromX !== toX || fromY !== toY) && moveDuration >= MOVE_STEP_INTERVAL_MS) {
      const numSteps = Math.floor(moveDuration / MOVE_STEP_INTERVAL_MS)

      for (let step = 1; step <= numSteps; step++) {
        const t = step / numSteps // 0..1 progress
        const mx = Math.round(fromX + (toX - fromX) * t)
        const my = Math.round(fromY + (toY - fromY) * t)
        const mt = Math.round(moveStart + moveDuration * (step / numSteps))

        // Don't emit a move event at the exact click time — the click events handle that
        if (mt < clickTime) {
          result.push(makeEvent(mt, 'mv', mx, my))
        }
      }
    }

    result.push(...currGroup)
  }

  return result
}

/**
 * Group consecutive events that share the same timestamp.
 * Each group represents one logical click action (press + release pair(s)).
 */
function groupByTimestamp(events: RecordedMouseEvent[]): RecordedMouseEvent[][] {
  const groups: RecordedMouseEvent[][] = []
  let current: RecordedMouseEvent[] = []

  for (const event of events) {
    if (current.length > 0 && event.timeMs !== current[0].timeMs) {
      groups.push(current)
      current = []
    }
    current.push(event)
  }

  if (current.length > 0) {
    groups.push(current)
  }

  return groups
}
