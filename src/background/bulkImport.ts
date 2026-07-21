/**
 * Bulk Game Recorder (Chrome-only).
 *
 * Lets the user paste a list of minesweeper.online game IDs/URLs and have
 * the extension sequentially navigate a tab through each one, relying on
 * the existing passive WebSocket capture pipeline (see webSocketCapture.ts)
 * to record each replay. No new content-script messaging is introduced —
 * "replay captured" is detected by watching for growth in the existing
 * `replayMeta` storage array that `saveGame()` already writes.
 *
 * This orchestration lives entirely in the background service worker so it
 * keeps running even if the (ephemeral) popup is closed. The popup only
 * starts/cancels the job and displays progress via GET_BULK_IMPORT_STATUS /
 * BULK_IMPORT_PROGRESS messages.
 *
 * Safety/ethics: this reuses the same passive chrome.debugger capture as
 * manual single-game capture — no clicks are simulated and no game state
 * is modified. It only navigates the tab (equivalent to the user pasting
 * URLs into the address bar themselves) and reads storage.
 */

import browser from '../utils/browser'
import { mlog, mwarn } from '../lib/utils/log'
import { startCapture, stopCapture, type ReplayDataCallback } from './webSocketCapture'
import { loadMeta } from '../storage/gameStorage'
import type { BulkImportResultEntry, BulkImportStatusResponse } from '../types/messages'

// -------------------------------------------------------------------------
// Constants
// -------------------------------------------------------------------------

const MAX_LINES = 100
const PER_GAME_TIMEOUT_MS = 10_000
const RATE_LIMIT_DELAY_MS = 300
const KEEPALIVE_ALARM_NAME = 'msr-bulk-keepalive'
/** 0.5 minutes = 30 seconds — the minimum period chrome.alarms allows. */
const KEEPALIVE_PERIOD_MINUTES = 0.5

// -------------------------------------------------------------------------
// Types
// -------------------------------------------------------------------------

interface BulkImportJob {
  tabId: number
  results: BulkImportResultEntry[]
  currentIndex: number
  status: 'running' | 'completed' | 'cancelled'
  /** True only while we've just triggered our own tabs.update() navigation. */
  awaitingOwnNavigation: boolean
  /** Whether "Always record" was on before the job started (to restore it). */
  wasAlwaysRecordEnabled: boolean
  /** Immediately resolves whatever wait (tab load / replay capture) is pending. */
  currentAbort: (() => void) | null
}

// -------------------------------------------------------------------------
// State
// -------------------------------------------------------------------------

/** At most one bulk import job at a time. Kept after completion so the
 *  final results can still be queried, until a new job overwrites it. */
let currentJob: BulkImportJob | null = null

// -------------------------------------------------------------------------
// Public API
// -------------------------------------------------------------------------

/**
 * Parse a single input line into a game ID.
 * Accepts a bare number, or any URL containing `/game/<id>`.
 * Returns null if the line can't be parsed.
 */
function parseGameToken(line: string): number | null {
  const trimmed = line.trim()
  if (!trimmed) return null
  if (/^\d+$/.test(trimmed)) return parseInt(trimmed, 10)
  const match = trimmed.match(/\/game\/(\d+)/)
  if (match) return parseInt(match[1]!, 10)
  return null
}

/**
 * Start a bulk import job on the given tab.
 * `onReplayCaptured` is the same callback used by manual capture
 * (background/index.ts's handleCapturedReplayData) — passed in rather than
 * imported to avoid a circular import between index.ts and this module.
 */
export function startBulkImport(
  tabId: number,
  lines: string[],
  onReplayCaptured: ReplayDataCallback,
): { success: boolean; error?: string } {
  if (currentJob && currentJob.status === 'running') {
    return { success: false, error: 'A bulk import is already running' }
  }

  const nonEmptyLines = lines.map(l => l.trim()).filter(l => l.length > 0)
  if (nonEmptyLines.length === 0) {
    return { success: false, error: 'No input lines provided' }
  }
  if (nonEmptyLines.length > MAX_LINES) {
    return { success: false, error: `Too many lines (${nonEmptyLines.length}) — maximum is ${MAX_LINES}` }
  }

  const results: BulkImportResultEntry[] = nonEmptyLines.map(input => ({
    input,
    gameId: parseGameToken(input),
    status: 'pending',
  }))

  const job: BulkImportJob = {
    tabId,
    results,
    currentIndex: 0,
    status: 'running',
    awaitingOwnNavigation: false,
    wasAlwaysRecordEnabled: false,
    currentAbort: null,
  }
  currentJob = job

  void runJob(job, onReplayCaptured)
  return { success: true }
}

/** Cancel the currently running job, if any. Safe to call when idle. */
export function stopBulkImport(reason = 'cancelled by user'): void {
  if (!currentJob || currentJob.status !== 'running') return
  mlog('Bulk import: stopping —', reason)
  currentJob.status = 'cancelled'
  currentJob.currentAbort?.()
}

/** Get a snapshot of the current (or most recently finished) job. */
export function getBulkImportStatus(): BulkImportStatusResponse {
  if (!currentJob) {
    return { running: false, total: 0, currentIndex: 0, results: [] }
  }
  return {
    running: currentJob.status === 'running',
    total: currentJob.results.length,
    currentIndex: currentJob.currentIndex,
    results: currentJob.results,
  }
}

// -------------------------------------------------------------------------
// F5 / external-navigation + tab-closed detection
// -------------------------------------------------------------------------

browser.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (!currentJob || currentJob.status !== 'running' || currentJob.tabId !== tabId) return
  if (changeInfo.status === 'loading' && !currentJob.awaitingOwnNavigation) {
    mwarn('Bulk import: detected navigation on tracked tab that we did not trigger — cancelling')
    stopBulkImport('tab navigated externally')
  }
})

browser.tabs.onRemoved.addListener((tabId) => {
  if (!currentJob || currentJob.status !== 'running' || currentJob.tabId !== tabId) return
  mwarn('Bulk import: tracked tab was closed — cancelling')
  stopBulkImport('tab closed')
})

browser.alarms?.onAlarm.addListener((alarm) => {
  // Firing alone is enough to reset the service worker's idle timer; no
  // action needed beyond that.
  void alarm
})

// -------------------------------------------------------------------------
// Job execution
// -------------------------------------------------------------------------

async function runJob(job: BulkImportJob, onReplayCaptured: ReplayDataCallback): Promise<void> {
  const prefs = await browser.storage.local.get('alwaysRecord')
  job.wasAlwaysRecordEnabled = prefs.alwaysRecord === true
  if (job.wasAlwaysRecordEnabled) {
    await browser.storage.local.set({ alwaysRecord: false })
  }

  const captureStarted = await startCapture(job.tabId, onReplayCaptured)
  if (!captureStarted) {
    job.status = 'cancelled'
    await finishJob(job)
    return
  }

  try {
    await browser.alarms.create(KEEPALIVE_ALARM_NAME, { periodInMinutes: KEEPALIVE_PERIOD_MINUTES })
  } catch (err) {
    mwarn('Bulk import: failed to create keepalive alarm', err)
  }

  broadcastProgress(job)

  for (let i = 0; i < job.results.length; i++) {
    if (job.status !== 'running') break
    job.currentIndex = i
    const entry = job.results[i]!

    if (entry.gameId == null) {
      entry.status = 'invalid'
      entry.error = 'Could not parse a game ID from this line'
      broadcastProgress(job)
      continue
    }

    try {
      const url = `https://minesweeper.online/game/${entry.gameId}`
      job.awaitingOwnNavigation = true
      await browser.tabs.update(job.tabId, { url })
      const loaded = await waitForTabLoad(job, job.tabId, PER_GAME_TIMEOUT_MS)
      job.awaitingOwnNavigation = false

      if (job.status !== 'running') break

      if (!loaded) {
        entry.status = 'failed'
        entry.error = 'Timed out waiting for the page to load'
      } else {
        const beforeCount = (await loadMeta()).length
        const captured = await waitForReplayCapture(job, beforeCount, PER_GAME_TIMEOUT_MS)
        if (job.status !== 'running') break
        entry.status = captured ? 'success' : 'failed'
        if (!captured) entry.error = 'Timed out waiting for the replay to be captured'
      }
    } catch (err) {
      job.awaitingOwnNavigation = false
      entry.status = 'failed'
      entry.error = String(err)
    }

    broadcastProgress(job)

    if (job.status !== 'running') break
    if (i < job.results.length - 1) {
      await delay(RATE_LIMIT_DELAY_MS)
    }
  }

  job.currentIndex = job.results.length
  if (job.status === 'running') job.status = 'completed'
  await finishJob(job)
}

async function finishJob(job: BulkImportJob): Promise<void> {
  await stopCapture(job.tabId)
  try {
    await browser.alarms.clear(KEEPALIVE_ALARM_NAME)
  } catch { /* best-effort */ }
  if (job.wasAlwaysRecordEnabled) {
    await browser.storage.local.set({ alwaysRecord: true })
  }
  broadcastProgress(job)
}

// -------------------------------------------------------------------------
// Wait helpers
// -------------------------------------------------------------------------

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** Resolves true once the tab reaches "complete", false on timeout/abort. */
function waitForTabLoad(job: BulkImportJob, tabId: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false

    const timer = setTimeout(() => finish(false), timeoutMs)

    function finish(result: boolean): void {
      if (done) return
      done = true
      clearTimeout(timer)
      browser.tabs.onUpdated.removeListener(listener)
      job.currentAbort = null
      resolve(result)
    }

    function listener(id: number, changeInfo: { status?: string }): void {
      if (id === tabId && changeInfo.status === 'complete') finish(true)
    }

    browser.tabs.onUpdated.addListener(listener)
    job.currentAbort = () => finish(false)

    // Race guard: the tab might already be complete by the time we attach.
    browser.tabs.get(tabId).then(tab => {
      if (tab.status === 'complete') finish(true)
    }).catch(() => finish(false))
  })
}

/**
 * Resolves true once `replayMeta`'s length grows past `beforeCount`
 * (meaning saveGame() persisted a newly-captured replay), false on timeout.
 */
function waitForReplayCapture(job: BulkImportJob, beforeCount: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false

    const timer = setTimeout(() => finish(false), timeoutMs)

    function finish(result: boolean): void {
      if (done) return
      done = true
      clearTimeout(timer)
      browser.storage.onChanged.removeListener(listener)
      job.currentAbort = null
      resolve(result)
    }

    function listener(changes: Record<string, { newValue?: unknown }>, area: string): void {
      if (area !== 'local' || !changes.replayMeta) return
      const newMeta = changes.replayMeta.newValue as unknown[] | undefined
      if (newMeta && newMeta.length > beforeCount) finish(true)
    }

    browser.storage.onChanged.addListener(listener)
    job.currentAbort = () => finish(false)
  })
}

// -------------------------------------------------------------------------
// Progress broadcasting
// -------------------------------------------------------------------------

function broadcastProgress(job: BulkImportJob): void {
  browser.runtime.sendMessage({
    type: 'BULK_IMPORT_PROGRESS',
    status: getBulkImportStatus(),
  }).catch(() => {
    // Popup is closed — that's fine, it'll query GET_BULK_IMPORT_STATUS on open.
  })
  void job
}
