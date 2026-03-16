/**
 * Content script for Minesweeper Replay Generator.
 *
 * Injected into web pages to detect minesweeper boards and record gameplay.
 *
 * This is the main entry point that:
 *   1. Listens for messages from the popup (start/stop/status)
 *   2. Manages a multi-game recording session
 *   3. Routes recording data back to the popup for download
 *
 * Session lifecycle:
 *   - User clicks "Start" → session begins, first game recorder created
 *   - Game ends → RAWVF stored, watch for board reset → new recorder → repeat
 *   - User clicks "Stop" → session ends, all replays available for download
 *
 * SPA navigation handling:
 *   minesweeper.online and similar sites are SPAs — navigating to a different
 *   page (settings, leaderboard, etc.) destroys the game DOM without triggering
 *   a full page reload. The content script survives, but all MutationObservers
 *   become zombies watching detached elements. A periodic board-presence check
 *   detects this and re-initializes everything when the board reappears.
 *
 * Site-specific board detection is handled by "site adapters" — each adapter
 * knows how to find the board, extract cell states, and detect game results
 * for a particular minesweeper website.
 */

import browser from '../utils/browser'
import type { RecordingState, RecordingData, GameResult, ReplayMetadata } from '../types/rawvf'
import type { GameSettings } from '../types/settings'
import type { StatusResponse } from '../types/messages'
import { GameRecorder } from '../recording/recorder'
import { generateRawvf, generateFilename } from '../rawvf/writer'
import { convertWomReplay } from '../rawvf/womConverter'
import { parseWomReplayPaste } from '../utils/socketIoParser'
import { saveGame } from '../storage/gameStorage'
import { saveAutoDetectedSettings, getEffectiveSettings } from '../storage/settingsStorage'
import { detectSiteAdapter, type SiteAdapter } from './siteAdapters'

// --------------------------------------------------------------------------
// Double-injection guard
// --------------------------------------------------------------------------
// When the extension is installed or updated, the background worker injects
// this script into already-open tabs via scripting.executeScript(). If the
// tab later navigates to a new page, the manifest's content_scripts entry
// also injects it. This guard prevents duplicate initialization.

const GUARD_KEY = '__minesweeper_replay_generator_loaded__'
if ((window as any)[GUARD_KEY]) {
  // Already running in this page context — bail out silently.
  throw new Error('[MSR] Content script already loaded, skipping duplicate.')
}
;(window as any)[GUARD_KEY] = true

import { mlog, mwarn, merr } from '../utils/log'

// --------------------------------------------------------------------------
// Configuration
// --------------------------------------------------------------------------

/**
 * How often (ms) to poll for board presence changes (SPA navigation, element
 * replacement). Lower = more responsive to difficulty switches and page
 * changes, but slightly more CPU. 250–500ms is a reasonable range.
 */
const BOARD_POLL_INTERVAL_MS = 200

/**
 * How often (ms) to poll for URL changes (SPA game-to-game navigation).
 * Lower = faster detection of mid-game resets and new games, at the cost
 * of slightly more frequent string comparisons (trivially cheap).
 * 40ms gives worst-case 40ms latency.
 */
const URL_POLL_INTERVAL_MS = 40

// --------------------------------------------------------------------------
// State
// --------------------------------------------------------------------------

/** Whether a multi-game session is currently active */
let sessionActive = false

/** Adapter for the current session (set once at session start) */
let currentAdapter: SiteAdapter | null = null

/** Number of games completed during the current session (for popup polling) */
let sessionGameCount = 0

/** Current game recorder (one per game, recreated between games) */
let recorder: GameRecorder | null = null

/** State exposed to the popup via GET_STATUS */
let currentState: RecordingState = 'idle'

/** Player name for replay metadata */
let playerName: string | undefined

/** Interval for monitoring board presence (SPA navigation handling) */
let boardPresenceInterval: ReturnType<typeof setInterval> | null = null

/** The last known board DOM element — used to detect element replacement */
let lastKnownBoardElement: HTMLElement | null = null

/** Cached game settings for the current session */
let currentSettings: GameSettings | null = null

/** Interval for SPA navigation monitoring */
let navigationMonitorInterval: ReturnType<typeof setInterval> | null = null

/** Adapter used for the settings bridge (may differ from currentAdapter if no session is active) */
let settingsBridgeAdapter: SiteAdapter | null = null

// --------------------------------------------------------------------------
// Adapter watcher helpers
// --------------------------------------------------------------------------

/**
 * Cancel all adapter DOM watchers (board reset, board change, game end).
 * Extracted because this exact sequence appears in 4+ places.
 */
function cancelAllWatchers(adapter: SiteAdapter | null): void {
  adapter?.cancelBoardReset?.()
  adapter?.cancelBoardChange?.()
  adapter?.cancelGameEnd?.()
}

/**
 * Abort the current recorder, saving the recording if it was in progress.
 * Returns true if a recorder was active. Sets recorder to null.
 */
function abortAndSaveRecorder(): boolean {
  if (!recorder) return false
  const state = recorder.getState()
  if (state === 'recording') {
    recorder.abort()
    const data = recorder.getRecordingData()
    if (data) saveRecordingData(data)
  } else {
    recorder.abort()
  }
  recorder = null
  return true
}

// --------------------------------------------------------------------------
// Extension context validity
// --------------------------------------------------------------------------

/**
 * Check whether the extension context is still valid.
 *
 * When the extension is reloaded or updated, the old content script stays
 * alive in the page but its connection to the extension is severed. Any call
 * to a `browser.*` API will throw "Extension context invalidated". This
 * check lets us detect that and stop gracefully.
 */
function isContextValid(): boolean {
  try {
    return browser.runtime?.id != null
  } catch {
    return false
  }
}

/**
 * Tear down all intervals and state when the extension context is
 * invalidated. This prevents zombie intervals from logging errors
 * repeatedly after an extension reload/update.
 */
function teardownOnInvalidContext(): void {
  mlog('Extension context invalidated, tearing down content script')
  sessionActive = false
  stopBoardPresenceMonitor()
  if (navigationMonitorInterval !== null) {
    clearInterval(navigationMonitorInterval)
    navigationMonitorInterval = null
  }
  cancelAllWatchers(currentAdapter)
  settingsBridgeAdapter?.destroySettingsBridge?.()
  settingsBridgeAdapter = null
  if (recorder) {
    recorder.abort()
    recorder = null
  }
  currentState = 'idle'
  // Allow re-injection by a fresh extension version
  delete (window as any)[GUARD_KEY]
}

// --------------------------------------------------------------------------
// Message handler
// --------------------------------------------------------------------------

browser.runtime.onMessage.addListener((message: unknown, _sender: browser.Runtime.MessageSender) => {
  const msg = message as { type: string; playerName?: string; data?: unknown; rawText?: string }
  switch (msg.type) {
    case 'START_RECORDING':
      playerName = msg.playerName
      return handleStartSession()
        .catch((err) => ({ error: String(err) }))

    case 'STOP_RECORDING':
      handleStopSession()
      return Promise.resolve({ success: true })

    case 'GET_STATUS':
      return Promise.resolve(getStatus())

    case 'GET_SETTINGS':
      return getEffectiveSettings().then(s => ({ settings: s }))

    case 'WS_REPLAY_DATA':
      return Promise.resolve(handleWomReplayData(msg.data))

    case 'PARSE_WS_REPLAY': {
      const rawText = msg.rawText
      if (!rawText) {
        return Promise.resolve({ success: false, error: 'No text provided' })
      }
      const parsed = parseWomReplayPaste(rawText)
      if (parsed === null) {
        return Promise.resolve({ success: false, error: 'Could not parse input. Expected a socket.io frame (42["response",[...]]) or a raw JSON replay array.' })
      }
      return Promise.resolve(handleWomReplayData(parsed))
    }
  }
})

// --------------------------------------------------------------------------
// Session control
// --------------------------------------------------------------------------

/**
 * Start a new recording session.
 * Detects the site adapter, validates the board, and begins recording.
 */
async function handleStartSession(): Promise<{ success: boolean; error?: string }> {
  // Prevent duplicate sessions (e.g., concurrent calls from navigation monitor
  // and checkAlwaysRecord while the first handleStartSession is still running).
  if (sessionActive) {
    mlog('handleStartSession: session already active, skipping')
    return { success: true }
  }

  const adapter = detectSiteAdapter()
  if (!adapter) {
    return {
      success: false,
      error: 'Could not detect a minesweeper board on this page. Make sure you are on a supported minesweeper website.',
    }
  }

  const boardElement = adapter.findBoardElement()
  if (!boardElement) {
    return {
      success: false,
      error: 'Minesweeper board element not found on this page.',
    }
  }

  const boardConfig = adapter.getBoardConfig()
  if (!boardConfig) {
    return {
      success: false,
      error: 'Could not determine board configuration (dimensions, mine count).',
    }
  }

  // Initialize session
  sessionActive = true
  currentAdapter = adapter
  sessionGameCount = 0

  // Load settings (from storage or auto-detect if on settings page)
  currentSettings = await getEffectiveSettings()
  mlog('Session started, board:', boardConfig.cols, 'x', boardConfig.rows, ', settings:', currentSettings)

  // Watch for board layout changes (difficulty switches) for the entire session.
  setupBoardChangeWatcher(adapter)

  // Monitor board presence to handle SPA navigation.
  startBoardPresenceMonitor(adapter)

  // Start the first game
  startNextGame(adapter)

  return { success: true }
}

/**
 * Stop the current session. Aborts any in-progress game and makes
 * all completed replays available for download.
 */
function handleStopSession(): void {
  mlog('Stopping session')
  sessionActive = false

  // Stop monitoring
  stopBoardPresenceMonitor()

  // Cancel all watchers
  cancelAllWatchers(currentAdapter)

  // If a game is currently in progress, abort it and try to salvage
  if (recorder && recorder.getState() === 'recording') {
    recorder.abort()
    const data = recorder.getRecordingData()
    if (data) {
      // Try to read mines once (best effort during manual stop)
      const mines = currentAdapter?.getMinePositions?.('unknown') ?? []
      if (mines.length > 0) data.minePositions = mines
      saveRecordingData(data)
    }
  } else if (recorder) {
    recorder.abort()
  }
  recorder = null

  currentState = 'idle'
}

// --------------------------------------------------------------------------
// Board presence monitoring (SPA navigation handling)
// --------------------------------------------------------------------------

/**
 * Periodically check whether the board is present in the DOM.
 *
 * Handles SPA-style navigation where the game board element is destroyed
 * and recreated without a full page reload (the content script stays alive
 * but all MutationObservers become zombies watching detached nodes).
 *
 * When the board disappears: abort the current game, clean up observers.
 * When the board reappears: re-attach all observers, start a new game.
 */
function startBoardPresenceMonitor(adapter: SiteAdapter): void {
  stopBoardPresenceMonitor()
  lastKnownBoardElement = adapter.findBoardElement()

  const intervalMS = BOARD_POLL_INTERVAL_MS
  boardPresenceInterval = setInterval(() => {
    if (!isContextValid()) { teardownOnInvalidContext(); return }
    if (!sessionActive) return

    const currentBoardElement = adapter.findBoardElement()
    const hadBoard = lastKnownBoardElement !== null
    const hasBoard = currentBoardElement !== null && adapter.getBoardConfig() !== null

    // Detect element replacement: same selector found a different DOM node.
    // This happens on difficulty changes where #AreaBlock is destroyed and
    // recreated. All MutationObservers on the old node are now zombies.
    const elementReplaced = hadBoard && hasBoard &&
      currentBoardElement !== lastKnownBoardElement &&
      !document.contains(lastKnownBoardElement)

    if (elementReplaced) {
      handleBoardElementReplaced(adapter, currentBoardElement!)
    } else if (!hasBoard && hadBoard) {
      handleBoardDisappeared(adapter)
    } else if (hasBoard && !hadBoard) {
      handleBoardAppeared(adapter, currentBoardElement!)
    }
  }, intervalMS)
}

/** Board element replaced (difficulty change or DOM rebuild). */
function handleBoardElementReplaced(adapter: SiteAdapter, newElement: HTMLElement): void {
  mlog('Board presence: element replaced (difficulty change or page update)')
  lastKnownBoardElement = newElement

  if (recorder) { recorder.abort(); recorder = null }
  cancelAllWatchers(adapter)

  setupBoardChangeWatcher(adapter)
  startNextGame(adapter)
}

/** Board disappeared — user navigated away from the game page. */
function handleBoardDisappeared(adapter: SiteAdapter): void {
  mlog('Board presence: board disappeared (SPA navigation away from game)')
  lastKnownBoardElement = null

  abortAndSaveRecorder()
  cancelAllWatchers(adapter)

  currentState = 'ready'
}

/** Board appeared — user navigated back to the game page. */
function handleBoardAppeared(adapter: SiteAdapter, element: HTMLElement): void {
  mlog('Board presence: board appeared (SPA navigation to game)')
  lastKnownBoardElement = element

  setupBoardChangeWatcher(adapter)
  startNextGame(adapter)
}

function stopBoardPresenceMonitor(): void {
  if (boardPresenceInterval !== null) {
    clearInterval(boardPresenceInterval)
    boardPresenceInterval = null
  }
}

// --------------------------------------------------------------------------
// Board change watcher (difficulty switches)
// --------------------------------------------------------------------------

/**
 * Set up a watcher for board layout changes (e.g., user switched difficulty).
 * Aborts any in-progress game and starts fresh with the new board config.
 * Unlike onBoardReset (one-shot, per-game), this persists across games.
 *
 * Note: This is a belt-and-suspenders measure. The board presence monitor
 * also detects element replacement via polling. This fires faster for
 * in-place childList mutations (same element, new children).
 */
function setupBoardChangeWatcher(adapter: SiteAdapter): void {
  adapter.onBoardChange?.(() => {
    if (!sessionActive) return
    mlog('onBoardChange fired (childList mutation on board)')

    // Board layout changed (user switched difficulty mid-game or between games).
    // Abort any in-progress game and start fresh with the new board config.
    if (recorder) {
      recorder.abort()
      recorder = null // Don't save — game was interrupted by difficulty change
    }

    // Cancel any pending per-game watchers from the previous board layout
    adapter.cancelBoardReset?.()
    adapter.cancelGameEnd?.()

    // Update the tracked element reference so the presence monitor doesn't
    // also fire for the same change.
    lastKnownBoardElement = adapter.findBoardElement()

    startNextGame(adapter)
  })
}

// --------------------------------------------------------------------------
// Per-game lifecycle
// --------------------------------------------------------------------------

/**
 * Set up game-end detection for the current recorder.
 *
 * When the game ends (face changes to win/lose), this handler:
 *   1. Calls finishAndReset — snapshots the finished game, resets recorder
 *      to 'ready', mouse tracker stays alive (zero gap)
 *   2. Re-registers itself immediately for the next game's end
 *   3. Defers all heavy work (mine reading, RAWVF, storage) to setTimeout(0)
 *
 * This is extracted as a standalone function so it can be called from both
 * startNextGame and the navigation handler's fast path.
 */
function setupGameEndHandler(adapter: SiteAdapter): void {
  adapter.onGameEnd?.((result) => {
    if (recorder && recorder.getState() === 'recording') {
      mlog('Game end detected:', result)

      const finishedData = recorder.finishAndReset(result, buildReplayMetadata())

      currentState = 'ready'

      // Re-register game-end detection for the next game immediately.
      // The face observer was disconnected before this callback ran, so
      // without this the next game's end would never be detected.
      setupGameEndHandler(adapter)

      // The recorder is frozen (finishAndReset sets frozen=true) to prevent
      // phantom games from clicks on the end-game board. Watch for the face
      // to return to neutral (board reset) and unfreeze at that point.
      adapter.cancelBoardReset?.()
      adapter.onBoardReset?.(() => {
        mlog('Board reset detected → unfreezing recorder')
        if (recorder) {
          recorder.unfreeze()
        }
      })

      // Defer all heavy work (mine reading, RAWVF generation, storage).
      // The recorder is already listening for the next game's first click.
      if (finishedData) {
        setTimeout(() => {
          readMinesAndSave(adapter, finishedData, result, 0)
        }, 0)
      }
    } else {
      // Belt-and-suspenders: the face observer fired but the recorder
      // wasn't recording (e.g., face class flicker the seenNeutral guard
      // didn't catch). The observer already disconnected itself, so
      // re-register to keep watching for the real game end.
      mwarn('Game end callback fired but recorder state is',
        recorder?.getState() ?? 'null', '— re-registering observer')
      setupGameEndHandler(adapter)
    }
  })
}

/**
 * Set up and start a new game recorder within the active session.
 * Called at session start and when board size changes.
 */
function startNextGame(adapter: SiteAdapter): void {
  // Guard: don't start if there's already an active recorder.
  // Multiple code paths (URL change handler, board presence monitor, board
  // change watcher) can all call startNextGame — this prevents races.
  if (recorder) {
    mlog('startNextGame: recorder already active, skipping')
    return
  }

  mlog('startNextGame called')
  // Get fresh board config (user might have changed difficulty between games)
  const boardElement = adapter.findBoardElement()
  const boardConfig = adapter.getBoardConfig()
  if (!boardElement || !boardConfig) {
    mwarn('startNextGame: board not found, waiting for presence monitor')
    // Board not found — don't kill the session.
    // The board presence monitor will detect when the board returns.
    currentState = 'ready'
    return
  }
  mlog('startNextGame: board', boardConfig.cols, 'x', boardConfig.rows, ', squareSize', boardConfig.squareSize)

  // Create a new recorder for this game
  recorder = new GameRecorder({
    board: boardConfig,
    metadata: buildReplayMetadata(),
    mouseTrackerConfig: {
      boardElement,
      squareSize: boardConfig.squareSize,
      keyboardMouse: currentSettings?.keyboardMouse,
      borderElement: adapter.findBorderElement?.() ?? undefined,
    },
    onStateChange: (state) => {
      mlog('Recorder state changed:', state)
      // In multi-game mode, don't expose individual game 'finished' to the popup.
      // The session manages the transition from game-finished → ready-for-next.
      if (sessionActive && state === 'finished') return
      currentState = state
    },
  })

  // Set up game end detection — uses finishAndReset for zero-gap transitions
  // and re-registers itself for the next game automatically.
  setupGameEndHandler(adapter)

  // Start the recorder (enters 'ready' state, waiting for first click)
  recorder.start()
  currentState = 'ready'
  mlog('Recorder started, state = ready, waiting for first click')
}

// --------------------------------------------------------------------------
// Mine reading with retries
// --------------------------------------------------------------------------

const MINE_READ_MAX_RETRIES = 4
const MINE_READ_DELAY_MS = 150

/**
 * Attempt to read mine positions from the DOM and save the completed game.
 *
 * Mines may not be visible immediately when the game ends — some sites
 * animate mine reveals after the face/status indicator changes. This
 * function retries a few times with short delays before giving up.
 *
 * Operates on a detached RecordingData snapshot so it cannot interfere
 * with the already-running next game recorder.
 */
function readMinesAndSave(
  adapter: SiteAdapter,
  data: RecordingData,
  result: GameResult,
  attempt: number,
): void {
  const mines = adapter.getMinePositions?.(result) ?? []

  if (mines.length > 0) {
    mlog(`Found ${mines.length} mines (attempt ${attempt + 1})`)
    data.minePositions = mines
    saveRecordingData(data)
    return
  }

  if (attempt < MINE_READ_MAX_RETRIES) {
    setTimeout(
      () => readMinesAndSave(adapter, data, result, attempt + 1),
      MINE_READ_DELAY_MS,
    )
    return
  }

  // All retries exhausted — save without mine data.
  mwarn(`Could not read mine positions after ${attempt + 1} attempts`)
  saveRecordingData(data)
}

// --------------------------------------------------------------------------
// Game saving
// --------------------------------------------------------------------------

/**
 * Generate RAWVF from recording data and persist to storage.
 * Respects the "Only save wins" preference — losses are silently skipped
 * when enabled, but the session game count still increments.
 */
async function saveRecordingData(data: RecordingData): Promise<void> {
  // Check "Only save wins" preference
  let prefs: Record<string, unknown>
  try {
    prefs = await browser.storage.local.get('winsOnly')
  } catch {
    // Extension context invalidated (extension reloaded/updated)
    teardownOnInvalidContext()
    return
  }
  if (prefs.winsOnly === true && data.result !== 'won') {
    mlog(`Skipping save (result=${data.result}, winsOnly=true)`)
    sessionGameCount++
    return
  }

  // Derive mine count from the actual mine positions found
  data.board.mines = data.minePositions.length

  const rawvf = generateRawvf(data)
  const filename = generateFilename(data)
  sessionGameCount++

  mlog(`Saved: ${filename} (${data.board.mines} mines, ${data.result})`)

  // Persist to storage. Fire-and-forget: the popup polls and will pick it up.
  saveGame({
    filename,
    timestamp: data.metadata.timestamp ?? new Date().toISOString(),
    cols: data.board.cols,
    rows: data.board.rows,
    mines: data.board.mines,
    result: data.result,
    timeMs: data.totalTimeMs,
  }, rawvf).catch(err => merr('Failed to save replay:', err))
}

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

/**
 * Get the effective player name: explicit override from popup takes priority,
 * then auto-detected from the site adapter, then undefined.
 */
function getEffectivePlayerName(): string | undefined {
  return playerName || currentAdapter?.getPlayerName?.() || undefined
}

/**
 * Build a fresh ReplayMetadata object using the current adapter and settings.
 * Called at game start and on finishAndReset transitions.
 */
function buildReplayMetadata(): ReplayMetadata {
  return {
    program: currentAdapter!.getProgramName(),
    version: currentAdapter!.getVersion?.(),
    url: currentAdapter!.getGameURL?.() ?? undefined,
    player: getEffectivePlayerName(),
    timestamp: new Date().toISOString(),
    questionMarks: false,
    chordingMode: currentSettings?.chording,
  }
}

// --------------------------------------------------------------------------
// Status / data responses
// --------------------------------------------------------------------------

function getStatus(): StatusResponse {
  // Read player name from adapter even outside an active session
  const adapter = currentAdapter || detectSiteAdapter()
  const detectedName = adapter?.getPlayerName?.() || undefined

  return {
    state: currentState,
    gameCount: sessionGameCount,
    eventCount: recorder?.getEventCount() ?? 0,
    elapsedMs: recorder?.getElapsedMs() ?? 0,
    detectedPlayerName: detectedName,
  }
}

// --------------------------------------------------------------------------
// SPA navigation handling (URL change during active session)
// --------------------------------------------------------------------------

/**
 * Generation counter to cancel stale retry chains from previous navigations.
 * Each call to handleNavigationDuringSession increments this; retries check
 * it to bail out if a newer navigation has superseded them.
 */
let navigationGeneration = 0

/**
 * Handle SPA navigation during an active recording session.
 *
 * The face observer + finishAndReset + freeze/unfreeze mechanism handles
 * game-to-game transitions entirely. The navigation handler only needs to
 * intervene when the board DOM element is actually destroyed or replaced
 * (navigating away from the game page, or difficulty change that recreates
 * the board element).
 *
 * When the board is the SAME DOM node, we no-op — the URL change is just
 * the SPA updating the address bar to reflect a game that's already in
 * progress or about to start.
 */
function handleNavigationDuringSession(adapter: SiteAdapter): void {
  const generation = ++navigationGeneration

  mlog('Navigation handler: URL changed during active session, generation =', generation)

  const boardElement = adapter.findBoardElement()

  // --- Fast path: board is the same DOM node ---
  // The face observer, finishAndReset, freeze/unfreeze, and onBoardReset
  // handle the entire game lifecycle. The URL change is the SPA catching up.
  //
  // Exception: if the recorder is in 'recording' state, the URL change means
  // the player reset mid-game (face click, F2, spacebar) without winning or
  // losing. The face observer correctly ignores these (pressed→unpressed =
  // null, not win/lose), but the recorder keeps accumulating events from the
  // abandoned game. Fix: use finishAndReset to discard the old events and
  // immediately unfreeze — the board is already showing the new game.
  //
  // This does NOT touch the face observer, board reset watcher, or board
  // change watcher. They are all still valid and watching the same DOM nodes.
  if (boardElement && boardElement === lastKnownBoardElement && document.contains(boardElement)) {
    if (recorder && recorder.getState() === 'recording') {
      mlog('Navigation handler: URL changed while recording → mid-game reset, discarding replay')

      // finishAndReset keeps the mouse tracker alive (zero gap). We discard
      // the returned data — no mine positions for incomplete games.
      recorder.finishAndReset('unknown', buildReplayMetadata())

      // finishAndReset sets frozen=true (normal for post-game-end). But
      // after a mid-game reset, the board is already in the new-game state
      // — there's no end-game display to wait through. Unfreeze immediately
      // so the first click of the new game is captured without delay.
      recorder.unfreeze()

      currentState = 'ready'
      return
    }

    mlog('Navigation handler: same board element → no-op (lifecycle handled by face observer)')
    return
  }

  // --- Board element changed or disappeared → full teardown and re-init ---
  mlog('Navigation handler: board element changed or gone → full re-init')

  abortAndSaveRecorder()
  cancelAllWatchers(adapter)

  // Mark board as unknown so the board presence monitor doesn't race us
  lastKnownBoardElement = null
  currentState = 'ready'

  // If the adapter knows this URL can't have a board, skip the retry loop.
  // The board presence monitor will pick things up when the user navigates
  // back to a game page.
  if (adapter.isGamePage && !adapter.isGamePage()) {
    mlog('Navigation handler: non-game page, skipping board search')
    return
  }

  // Wait for the SPA to finish rendering the new page, then re-initialize.
  // Use retries because SPA content loading is asynchronous.
  let attempts = 0
  const MAX_ATTEMPTS = 6
  const RETRY_DELAY_MS = 250

  const tryReInitialize = () => {
    // Bail if a newer navigation has happened or session ended
    if (generation !== navigationGeneration) return
    if (!sessionActive || !currentAdapter) return

    const boardElement = currentAdapter.findBoardElement()
    const boardConfig = currentAdapter.getBoardConfig()

    if (boardElement && boardConfig) {
      mlog('Navigation handler: board found after URL change, re-initializing',
        boardConfig.cols, 'x', boardConfig.rows)
      lastKnownBoardElement = boardElement
      setupBoardChangeWatcher(currentAdapter)
      startNextGame(currentAdapter)
    } else if (attempts < MAX_ATTEMPTS) {
      attempts++
      mlog('Navigation handler: board not found yet, retry', attempts, '/', MAX_ATTEMPTS)
      setTimeout(tryReInitialize, RETRY_DELAY_MS)
    } else {
      mlog('Navigation handler: no board found after', MAX_ATTEMPTS, 'retries (navigated away from game?)')
      lastKnownBoardElement = null
      currentState = 'ready'
    }
  }

  // Small initial delay for the SPA to start rendering
  setTimeout(tryReInitialize, 150)
}

// --------------------------------------------------------------------------
// SPA navigation monitor — settings bridge + game URL changes
// --------------------------------------------------------------------------

/**
 * minesweeper.online is a single-page app. The content script loads once and
 * survives all in-app navigation. We poll for URL changes to handle:
 *   1. Game URL changes during active recording sessions (observers may be zombies)
 *   2. Always-record retries when the user navigates to a page with a board
 *
 * Settings detection is handled separately by the localStorage bridge
 * (initSettingsBridge), which works on any page without requiring the user
 * to visit the settings page.
 */
let lastPathname = window.location.pathname

/**
 * Save auto-detected settings to storage and update the in-memory
 * currentSettings to the correct effective value (manual override
 * takes priority if active).
 */
async function persistAutoDetectedSettings(settings: GameSettings): Promise<void> {
  try {
    await saveAutoDetectedSettings(settings)
    // Always re-derive the effective settings so manual override is respected
    currentSettings = await getEffectiveSettings()
  } catch {
    // Extension context invalidated (extension reloaded/updated)
    teardownOnInvalidContext()
  }
}

function startNavigationMonitor(): void {
  const adapter = detectSiteAdapter()
  if (!adapter) return

  // Initialize localStorage settings polling.
  // Reads chording mode, keyboard-as-mouse config, etc. from the site's
  // localStorage directly (content scripts share the page's origin). Works
  // on any page — no need to visit /settings.
  settingsBridgeAdapter = adapter
  adapter.initSettingsBridge?.((settings) => {
    mlog('Settings from localStorage bridge:', settings)
    persistAutoDetectedSettings(settings)
  })

  // Poll for SPA navigation changes
  navigationMonitorInterval = setInterval(() => {
    if (!isContextValid()) { teardownOnInvalidContext(); return }

    const currentPath = window.location.pathname
    if (currentPath === lastPathname) return

    const previousPath = lastPathname
    lastPathname = currentPath
    mlog(`SPA navigation: ${previousPath} → ${currentPath}`)

    // Handle any URL change during an active recording session.
    // SPA navigation may destroy or recreate game DOM elements, making
    // existing MutationObservers into zombies. The board presence monitor
    // catches element replacement, but can miss cases where #AreaBlock
    // stays as the same DOM node (same difficulty, game-to-game nav).
    // The URL change is the most reliable signal for these transitions.
    if (sessionActive && currentAdapter) {
      handleNavigationDuringSession(currentAdapter)
    } else if (!sessionActive) {
      // Always-record may have failed to start on the initial page load
      // (e.g., user was on /my-games or /settings with no board present).
      // Retry on every URL change until a session starts successfully.
      // checkAlwaysRecord reads the alwaysRecord flag from storage and
      // calls handleStartSession if appropriate — it's a no-op if the
      // flag is off or if no board is found on the new page either.
      checkAlwaysRecord()
    }
  }, URL_POLL_INTERVAL_MS)
}

// Start on content script load
startNavigationMonitor()
checkAlwaysRecord()

// --------------------------------------------------------------------------
// Always-record auto-start
// --------------------------------------------------------------------------

/**
 * If the user has enabled "Always record", automatically start a session
 * when the content script loads (page load, extension install/update, or
 * SPA navigation that injects the script into an already-open tab).
 *
 * Also listens for storage changes so that toggling the option in the popup
 * takes effect immediately without a page reload.
 */
async function checkAlwaysRecord(): Promise<void> {
  let prefs: Record<string, unknown>
  try {
    prefs = await browser.storage.local.get(['alwaysRecord', 'playerName'])
  } catch {
    // Extension context invalidated (extension reloaded/updated)
    teardownOnInvalidContext()
    return
  }
  if (prefs.alwaysRecord === true && !sessionActive) {
    playerName = (typeof prefs.playerName === 'string' && prefs.playerName.trim())
      ? prefs.playerName.trim()
      : undefined
    mlog('Always-record enabled, auto-starting session')
    const result = await handleStartSession()
    if (!result.success) {
      mlog('Always-record: session start failed:', result.error,
        '— will retry on next SPA navigation')
    }
  }
}

// React to storage changes from the popup while the page is open
browser.storage.onChanged.addListener((changes, area) => {
  if (!isContextValid()) { teardownOnInvalidContext(); return }
  if (area !== 'local') return

  // Keep playerName in sync — the user may type a name in the popup at any
  // time, including mid-session. The next game recorder will pick it up.
  if (changes.playerName) {
    const newName = typeof changes.playerName.newValue === 'string' && changes.playerName.newValue.trim()
      ? changes.playerName.newValue.trim()
      : undefined
    playerName = newName
  }

  if (changes.alwaysRecord?.newValue === true && !sessionActive) {
    mlog('Always-record toggled on, auto-starting session')
    checkAlwaysRecord()
  }
})

// --------------------------------------------------------------------------
// WebSocket replay converter
// --------------------------------------------------------------------------

/**
 * Handle replay data from a WoM 203 WebSocket response.
 *
 * Called either from:
 *   - Background service worker forwarding chrome.debugger-captured data
 *   - PARSE_WS_REPLAY message from the popup (manual paste)
 *
 * Converts the WoM data to RAWVF format and saves to storage.
 */
function handleWomReplayData(data: unknown): { success: boolean; error?: string; gameId?: number } {
  try {
    const { recording, gameId } = convertWomReplay(data)

    // Use player name from popup override, or adapter-detected name
    recording.metadata.player = getEffectivePlayerName()

    const rawvf = generateRawvf(recording)
    const filename = generateFilename(recording)

    mlog(`WoM converter: saved game ${gameId} as ${filename}`)

    // Persist to storage (same path as normal recordings)
    saveGame({
      filename,
      timestamp: recording.metadata.timestamp ?? new Date().toISOString(),
      cols: recording.board.cols,
      rows: recording.board.rows,
      mines: recording.board.mines,
      result: recording.result,
      timeMs: recording.totalTimeMs,
    }, rawvf).catch(err => merr('Failed to save converted replay:', err))

    return { success: true, gameId }
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err)
    mwarn('WoM converter error:', errorMsg)
    return { success: false, error: errorMsg }
  }
}
