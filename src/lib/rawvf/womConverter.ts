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
 *       type: 0 = left click (open), 1 = right click (flag), 2 = wasted
 *         chord, 3 = chord
 *       time: milliseconds since game start
 *       x: column (0-indexed), y: row (0-indexed)
 *       touchCells: flat array of "chunks of 5" [x, y, code, extra, unused]
 *         describing every cell affected by the click. Only parsed for PVP
 *         (duel) games — see "PVP support" below.
 *
 *   - gameMeta.state values: 3 = won, 4 = lost (based on observed data)
 *
 * ## PVP support (local-area resets)
 *
 * PVP duel games (detected via the presence of `gameMeta.duelInfo`) can
 * blast a mine WITHOUT ending the game: instead, a local region of the
 * board is reset — mines in that region are re-randomized and revealed
 * cells return to unrevealed. Because the mine layout can change mid-game,
 * a replay engine can no longer simulate reveals purely from the initial
 * `Board:` mine grid + mouse clicks (as non-PVP conversions do). Instead,
 * for PVP games we parse every click's `touchCells` into explicit RAWVF
 * board events (number reveals, flag/closed, blast, reset) so the replay
 * is unambiguous. Non-PVP conversions are unaffected and remain mouse-only.
 */

import type {
  RecordingData,
  RecordedMouseEvent,
  RecordedBoardEvent,
  RecordedEvent,
  BoardEventCode,
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
  /** Present only for PVP (duel) games. Its presence is how we detect PVP. */
  duelInfo?: WomDuelInfo
}

/**
 * Duel metadata for PVP games (from `gameMeta.duelInfo`).
 *
 * `user1Id`/`user2Id` correlate with `game1Id`/`game2Id` respectively — the
 * player whose `gameMeta.id` matches `game1Id` is `user1Id`, and vice versa.
 * `game1Id`/`game2Id` can be `null` (e.g. a freshly created lobby game with
 * no paired opponent game yet).
 */
interface WomDuelInfo {
  id: number
  user1Id: number
  user2Id: number
  game1Id: number | null
  game2Id: number | null
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
  /** Cells affected by this click. */
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

  // PVP (duel) games can locally reset instead of ending on a mine blast —
  // parse touchCells into explicit board events for these games only.
  const isPvp = gameMeta.duelInfo != null
  const opponentInfo = resolveOpponentInfo(gameMeta)

  // Convert WoM clicks to click groups (mouse + board events), then add simulated movement
  const clickGroups = buildClickGroups(clicks, DEFAULT_SQUARE_SIZE, chordingMode, isPvp)
  const events = buildEventStream(clickGroups)

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
      opponent: opponentInfo ? String(opponentInfo.opponentUserId) : undefined,
      opponentUrl: opponentInfo?.opponentGameId != null
        ? `https://minesweeper.online/game/${opponentInfo.opponentGameId}`
        : undefined,
      levelCode: gameMeta.level,
      isPvp,
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
    duelInfo: parseDuelInfo(meta.duelInfo),
  }
}

/**
 * Parse `gameMeta.duelInfo`, if present. Never throws — a malformed or
 * absent `duelInfo` simply means the game is treated as non-PVP.
 */
function parseDuelInfo(raw: unknown): WomDuelInfo | undefined {
  if (!raw || typeof raw !== 'object') return undefined

  const d = raw as Record<string, unknown>
  if (typeof d.id !== 'number' || typeof d.user1Id !== 'number' || typeof d.user2Id !== 'number') {
    return undefined
  }

  return {
    id: d.id,
    user1Id: d.user1Id,
    user2Id: d.user2Id,
    game1Id: typeof d.game1Id === 'number' ? d.game1Id : null,
    game2Id: typeof d.game2Id === 'number' ? d.game2Id : null,
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

    let touchCells: number[] | undefined
    if (c.touchCells !== undefined) {
      if (!Array.isArray(c.touchCells) || c.touchCells.length % 5 !== 0) {
        throw new Error(`Invalid click at index ${i}: touchCells must be an array with length divisible by 5`)
      }
      touchCells = c.touchCells as number[]
    }

    return {
      type: c.type as number,
      time: c.time as number,
      x: c.x as number,
      y: c.y as number,
      touchCells,
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

/** The opponent's user ID and game ID, resolved from `gameMeta.duelInfo`. */
interface OpponentInfo {
  opponentUserId: number
  opponentGameId: number | null
}

/**
 * Resolve the opponent's user/game IDs for a PVP game by matching this
 * game's `id` against `duelInfo.game1Id`/`game2Id`.
 *
 * Returns undefined for non-PVP games, or if `duelInfo` doesn't reference
 * this game's ID (shouldn't normally happen, but data is treated as
 * untrusted).
 */
function resolveOpponentInfo(gameMeta: WomGameMeta): OpponentInfo | undefined {
  const duelInfo = gameMeta.duelInfo
  if (!duelInfo) return undefined

  if (duelInfo.game1Id === gameMeta.id) {
    return { opponentUserId: duelInfo.user2Id, opponentGameId: duelInfo.game2Id }
  }
  if (duelInfo.game2Id === gameMeta.id) {
    return { opponentUserId: duelInfo.user1Id, opponentGameId: duelInfo.game1Id }
  }
  return undefined
}

/**
 * Convert a single WoM click to RAWVF mouse events (press + release pair(s)).
 *
 * WoM click types:
 *   0 = left click (open cell) → lc + lr
 *   1 = right click (flag/unflag) → rc + rr
 *   2 = wasted chord (no effect) → mc + mr
 *   3 = chord → depends on chording mode:
 *       'both': mc + mr (traditional left+right chord, using middle click for simplicity)
 *       'superclick': lc + lr (left-click-only chord on opened cell)
 *       'disabled': mc + mr (fallback to traditional)
 */
function mouseEventsForClick(click: WomClick, squareSize: number, chordingMode: ChordingMode): RecordedMouseEvent[] {
  const { px, py } = womXYToPixel(click.x, click.y, squareSize)

  if (click.type === 1) {
    // Right click (flag)
    return [makeEvent(click.time, 'rc', px, py), makeEvent(click.time, 'rr', px, py)]
  } else if (click.type === 2) {
    // Wasted chord
    return [makeEvent(click.time, 'mc', px, py), makeEvent(click.time, 'mr', px, py)]
  } else if (click.type === 3) {
    // Chord
    if (chordingMode === 'superclick') {
      // SuperClick: left-click on an already-opened numbered cell
      return [makeEvent(click.time, 'lc', px, py), makeEvent(click.time, 'lr', px, py)]
    }
    // Standard chord: simultaneous left+right press/release, but we can use middle click for simplicity
    return [makeEvent(click.time, 'mc', px, py), makeEvent(click.time, 'mr', px, py)]
  } else {
    // Left click (open) — type 0 or default
    return [makeEvent(click.time, 'lc', px, py), makeEvent(click.time, 'lr', px, py)]
  }
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
// PVP local-area resets — touchCells → board events
//
// touchCells is a flat array of "chunks of 5": [x, y, code, index3, index4].
// Only parsed for PVP games (see module docs). Semantics of `code` depend
// on the click type that produced it:
//
//   Click type 0 (left) / 3 (chord):
//     0-8  = number revealed
//     10   = mine revealed at end-of-game (auto-shown, not player-placed —
//            same rationale as the ignored mine-presence info below), skipped
//     11   = actual blasted mine → 'blast'
//     12   = bad flag revealed → no corresponding RAWVF event, skipped
//     13   = local-reset "blast origin" cell (index3 always 0) →
//            'local_blast' then 'reset', always ordered before any other
//            reset-derived events (code 14/15) produced by the same click
//     14   = local-reset, cell revealed after reset (index3 = new number)
//     15   = local-reset, cell left unrevealed after reset (index3 always 0)
//
//   Click type 1 (right):
//     only `index4` (the flag bit: 0 = removed, 1 = placed) matters —
//     `code` ("mine presence") is intentionally ignored, see module docs.
//
//   Click type 2 (wasted chord):
//     touchCells is always empty.
// ============================================================================


/**
 * Convert a WoM click's `touchCells` into RAWVF board events.
 *
 * The code-13 "blast origin" cell's events are always placed first in the
 * returned array, ahead of any other reset-derived events from the same
 * click — this is enforced by construction (two-buffer partition below),
 * not by assuming touchCells array order.
 */
function chunksToBoardEvents(touchCells: number[] | undefined, clickType: number): RecordedBoardEvent[] {
  if (!touchCells || touchCells.length === 0) return []

  if (touchCells.length % 5 !== 0) {
    console.error(`[MSR] Malformed touchCells array: length ${touchCells.length} is not a multiple of 5.`)
    return []
  }

  const originEvents: RecordedBoardEvent[] = []
  const otherEvents: RecordedBoardEvent[] = []

  for (let i = 0; i < touchCells.length; i += 5) {
    const col = touchCells[i]!
    const row = touchCells[i + 1]!
    const code = touchCells[i + 2]!
    const index3 = touchCells[i + 3]!
    const index4 = touchCells[i + 4]!

    if (clickType === 1) {
      // Right click: only the flag bit (`index4`) matters. Mine-presence
      // info (`code`) is intentionally ignored — see module docs.
      // index4: 0 = flag removed, 1 = flag placed.
      otherEvents.push({ type: 'board', col, row, event: index4 === 1 ? 'flag' : 'closed' })
      continue
    }

    const target = code === 13 ? originEvents : otherEvents
    target.push(...chunkCodeToEvents(col, row, code, index3))
  }

  return [...originEvents, ...otherEvents]
}

/**
 * Map a single reveal/reset chunk code to its board event(s).
 *
 * `index3` is only meaningful for code 14 (the newly-revealed number).
 */
function chunkCodeToEvents(col: number, row: number, code: number, index3: number): RecordedBoardEvent[] {
  if (code >= 0 && code <= 8) {
    return [{ type: 'board', col, row, event: numberEventCode(code) }]
  }
  if (code === 10) {
    // Mine revealed at end-of-game (the auto-shown "this was a mine"
    // reveal, not a flag the player actually placed) — omit, same as the
    // ignored mine-presence info on click type 1.
    return []
  }
  if (code === 11) {
    // Actual blasted mine.
    return [{ type: 'board', col, row, event: 'blast' }]
  }
  if (code === 12) {
    // Bad flag revealed — no corresponding RAWVF board event.
    return []
  }
  if (code === 13) {
    return getBlastOriginEvents().map((event) => ({ type: 'board', col, row, event }))
  }
  if (code === 14) {
    return [
      { type: 'board', col, row, event: 'reset' },
      { type: 'board', col, row, event: numberEventCode(index3) },
    ]
  }
  if (code === 15) {
    return [{ type: 'board', col, row, event: 'reset' }]
  }

  console.error(`[MSR] Unknown touchCells change code: ${code} at (${col}, ${row}).`)
  return []
}

/**
 * Board event(s) for the PVP local-reset "blast origin" cell (touchCells
 * change code 13 — the mine that was actually blasted, triggering the reset).
 *
 * Per RawVF Rev7, this is `local_blast` ("a blast that only resets some of
 * the board, instead of ending the game") followed by `reset` (the cell's
 * mine presence is re-randomized and it becomes unrevealed, same as every
 * other cell in the reset region). Kept isolated here in case this mapping
 * needs to change again.
 */
function getBlastOriginEvents(): BoardEventCode[] {
  return ['local_blast', 'reset']
}

/** Convert a 0-8 revealed number to its RAWVF board event code. */
function numberEventCode(n: number): BoardEventCode {
  if (n < 0 || n > 8) {
    console.error(`[MSR] Unexpected revealed number value: ${n}, defaulting to number0.`)
    return 'number0'
  }
  return `number${n}` as BoardEventCode
}

// ============================================================================
// Click groups
//
// Each WoM click becomes a "group": the mouse events it produces, plus
// (for PVP games) the board events derived from its touchCells. Grouping
// keeps a click's mouse+board events together so movement synthesis can
// treat each click as a single atomic unit.
// ============================================================================

interface ClickGroup {
  timeMs: number
  mouseEvents: RecordedMouseEvent[]
  boardEvents: RecordedBoardEvent[]
}

function buildClickGroups(
  clicks: WomClick[],
  squareSize: number,
  chordingMode: ChordingMode,
  isPvp: boolean,
): ClickGroup[] {
  return clicks.map((click) => ({
    timeMs: click.time,
    mouseEvents: mouseEventsForClick(click, squareSize, chordingMode),
    boardEvents: isPvp ? chunksToBoardEvents(click.touchCells, click.type) : [],
  }))
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
 * Interleave click groups into a final RecordedEvent stream, inserting
 * simulated mouse movement ('mv') events between click groups.
 *
 * Each group's mouse events are emitted first (in the same order as
 * before), followed by any board events derived from that click.
 */
function buildEventStream(groups: ClickGroup[]): RecordedEvent[] {
  if (groups.length === 0) return []

  const result: RecordedEvent[] = []

  // Emit first group as-is
  result.push(...groups[0].mouseEvents, ...groups[0].boardEvents)

  for (let i = 1; i < groups.length; i++) {
    const prevGroup = groups[i - 1]
    const currGroup = groups[i]

    const fromX = prevGroup.mouseEvents[0].x
    const fromY = prevGroup.mouseEvents[0].y
    const toX = currGroup.mouseEvents[0].x
    const toY = currGroup.mouseEvents[0].y

    const prevTime = prevGroup.timeMs
    const clickTime = currGroup.timeMs
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

    result.push(...currGroup.mouseEvents, ...currGroup.boardEvents)
  }

  return result
}
