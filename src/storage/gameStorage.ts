/**
 * Persistent game replay storage.
 *
 * Uses browser.storage.local to persist completed RAWVF replays across sessions.
 * Metadata is stored in a lightweight array for fast list loading; RAWVF content
 * is stored under individual keys and loaded only for download.
 *
 * Storage layout:
 *   - "replayMeta": StoredGameMeta[]     — compact array for the game list UI
 *   - "replay_<id>": string              — individual RAWVF content per game
 *
 * Budget: 50 MB for replay data. This fits roughly 1,000–2,500 expert-level replays
 * or tens of thousands of beginner games — enough for months of play without
 * abusing the user's storage. When the budget is exceeded, the oldest replays
 * are evicted automatically (FIFO).
 */

import browser from '../utils/browser'
import type { GameResult } from '../types/rawvf'

// ============================================================================
// Constants
// ============================================================================

const META_KEY = 'replayMeta'
const CONTENT_KEY_PREFIX = 'replay_'

/** Maximum total bytes of RAWVF content to store. Oldest games evicted when exceeded. */
export const STORAGE_BUDGET_BYTES = 50 * 1024 * 1024 // 50 MB

// ============================================================================
// Types
// ============================================================================

/**
 * Lightweight metadata for a stored game replay.
 * Does NOT include the RAWVF content — that's stored under a separate key.
 */
export interface StoredGameMeta {
  /** Unique identifier */
  id: string
  /** Suggested filename for download */
  filename: string
  /** ISO 8601 timestamp of when the game was played */
  timestamp: string
  /** Board columns (width) */
  cols: number
  /** Board rows (height) */
  rows: number
  /** Mine count */
  mines: number
  /** Game result */
  result: GameResult
  /** Game duration in milliseconds */
  timeMs: number
  /** RAWVF content size in bytes */
  sizeBytes: number
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Save a completed game replay to persistent storage.
 * Automatically evicts the oldest replays if the storage budget is exceeded.
 */
export async function saveGame(
  meta: Omit<StoredGameMeta, 'id' | 'sizeBytes'>,
  rawvf: string,
): Promise<void> {
  const id = generateId()
  const sizeBytes = new TextEncoder().encode(rawvf).byteLength

  const allMeta = await loadMeta()
  const newMeta: StoredGameMeta = { ...meta, id, sizeBytes }
  allMeta.push(newMeta)

  // Evict oldest replays until total size fits within budget
  let totalSize = allMeta.reduce((sum, g) => sum + g.sizeBytes, 0)
  const evictIds: string[] = []
  while (totalSize > STORAGE_BUDGET_BYTES && allMeta.length > 1) {
    const oldest = allMeta.shift()!
    totalSize -= oldest.sizeBytes
    evictIds.push(oldest.id)
  }

  // Write new content + updated meta in one call
  await browser.storage.local.set({
    [META_KEY]: allMeta,
    [`${CONTENT_KEY_PREFIX}${id}`]: rawvf,
  })

  // Remove evicted content keys
  if (evictIds.length > 0) {
    await browser.storage.local.remove(
      evictIds.map(eid => `${CONTENT_KEY_PREFIX}${eid}`)
    )
  }
}

/**
 * Load metadata for all stored replays (oldest first).
 * Does not load RAWVF content — use getGamesContent() for that.
 */
export async function loadMeta(): Promise<StoredGameMeta[]> {
  const data = await browser.storage.local.get(META_KEY)
  return (data[META_KEY] as StoredGameMeta[] | undefined) ?? []
}

/**
 * Load RAWVF content and filenames for specific game IDs.
 * Only loads the content needed for download, not the entire store.
 */
export async function getGamesContent(
  ids: string[],
  allMeta?: StoredGameMeta[],
): Promise<Array<{ filename: string; rawvf: string }>> {
  const keys = ids.map(id => `${CONTENT_KEY_PREFIX}${id}`)
  const data = await browser.storage.local.get(keys)

  const meta = allMeta ?? await loadMeta()
  const metaById = new Map(meta.map(m => [m.id, m]))

  const results: Array<{ filename: string; rawvf: string }> = []
  for (const id of ids) {
    const rawvf = data[`${CONTENT_KEY_PREFIX}${id}`] as string | undefined
    const gameMeta = metaById.get(id)
    if (rawvf && gameMeta) {
      results.push({ filename: gameMeta.filename, rawvf })
    }
  }
  return results
}

/**
 * Delete specific games from storage (metadata + content).
 */
export async function deleteGames(ids: string[]): Promise<void> {
  const idSet = new Set(ids)
  const allMeta = await loadMeta()
  const remaining = allMeta.filter(g => !idSet.has(g.id))

  await browser.storage.local.set({ [META_KEY]: remaining })
  await browser.storage.local.remove(
    ids.map(id => `${CONTENT_KEY_PREFIX}${id}`)
  )
}

/**
 * Delete all stored games.
 */
export async function clearAllGames(): Promise<void> {
  const allMeta = await loadMeta()
  const contentKeys = allMeta.map(g => `${CONTENT_KEY_PREFIX}${g.id}`)
  await browser.storage.local.remove([META_KEY, ...contentKeys])
}

// ============================================================================
// Internal
// ============================================================================

function generateId(): string {
  return `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}
