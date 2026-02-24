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
import type { RecordingState, GameResult } from '../types/rawvf'
import type { GameSettings } from '../types/settings'
import type { StatusResponse } from '../types/messages'
import { GameRecorder } from '../recording/recorder'
import { generateRawvf, generateFilename } from '../rawvf/writer'
import { saveGame } from '../storage/gameStorage'
import { saveAutoDetectedSettings, getEffectiveSettings } from '../storage/settingsStorage'
import { detectSiteAdapter, type SiteAdapter } from './siteAdapters'

// --------------------------------------------------------------------------
// Configuration
// --------------------------------------------------------------------------

/**
 * How often (ms) to poll for board presence changes (SPA navigation, element
 * replacement). Lower = more responsive to difficulty switches and page
 * changes, but slightly more CPU. 250–500ms is a reasonable range.
 */
const BOARD_POLL_INTERVAL_MS = 300

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

// --------------------------------------------------------------------------
// Message handler
// --------------------------------------------------------------------------

browser.runtime.onMessage.addListener((message: unknown, _sender: browser.Runtime.MessageSender) => {
  const msg = message as { type: string; playerName?: string }
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
  }
})

// --------------------------------------------------------------------------
// Session control
// --------------------------------------------------------------------------

/**
 * Start a new multi-game recording session.
 * Detects the site adapter, validates the board, and begins recording.
 */
async function handleStartSession(): Promise<{ success: boolean; error?: string }> {
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
  console.debug('[MSR] Session started, board:', boardConfig.cols, 'x', boardConfig.rows, ', settings:', currentSettings)

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
  sessionActive = false

  // Stop monitoring
  stopBoardPresenceMonitor()

  // Cancel all watchers
  currentAdapter?.cancelBoardChange?.()
  currentAdapter?.cancelBoardReset?.()
  currentAdapter?.cancelGameEnd?.()

  // If a game is currently in progress, abort it
  if (recorder) {
    const state = recorder.getState()
    if (state === 'recording') {
      // Game was in progress — abort and try to salvage the recording
      recorder.abort()
      // Try to read mines once (best effort during manual stop)
      if (currentAdapter) {
        const mines = currentAdapter.getMinePositions?.('unknown') ?? []
        if (mines.length > 0) recorder.setMinePositions(mines)
      }
      saveCompletedGame(recorder)
    } else if (state === 'ready') {
      // Game hadn't started yet — just clean up
      recorder.abort()
    }
    recorder = null
  }

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
      console.debug('[MSR] Board element replaced (difficulty change or page update)')
      lastKnownBoardElement = currentBoardElement

      // Clean up everything attached to the old DOM nodes
      if (recorder) {
        recorder.abort()
        recorder = null
      }
      adapter.cancelBoardReset?.()
      adapter.cancelBoardChange?.()
      adapter.cancelGameEnd?.()

      // Re-establish on new DOM
      setupBoardChangeWatcher(adapter)
      startNextGame(adapter)
      return
    }

    if (!hasBoard && hadBoard) {
      // Board disappeared — user navigated away from the game page.
      console.debug('[MSR] Board disappeared (SPA navigation)')
      lastKnownBoardElement = null

      if (recorder) {
        recorder.abort()
        recorder = null
      }
      adapter.cancelBoardReset?.()
      adapter.cancelBoardChange?.()
      adapter.cancelGameEnd?.()

      currentState = 'ready'

    } else if (hasBoard && !hadBoard) {
      // Board appeared — user navigated back to the game page.
      console.debug('[MSR] Board appeared (SPA navigation back)')
      lastKnownBoardElement = currentBoardElement

      setupBoardChangeWatcher(adapter)
      startNextGame(adapter)
    }
  }, intervalMS)
}

function stopBoardPresenceMonitor(): void {
  if (boardPresenceInterval !== null) {
    clearInterval(boardPresenceInterval)
    boardPresenceInterval = null
  }
}

/**
 * Check if the board is present and usable (exists and has cells).
 * A board element might exist but be empty during page transitions.
 */
function isBoardUsable(adapter: SiteAdapter): boolean {
  return !!adapter.findBoardElement() && !!adapter.getBoardConfig()
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
    console.debug('[MSR] onBoardChange fired (childList mutation on board)')

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
 * Set up and start a new game recorder within the active session.
 * Called at session start and after each board reset.
 */
function startNextGame(adapter: SiteAdapter): void {
  console.debug('[MSR] startNextGame called')
  // Get fresh board config (user might have changed difficulty between games)
  const boardElement = adapter.findBoardElement()
  const boardConfig = adapter.getBoardConfig()
  if (!boardElement || !boardConfig) {
    console.warn('[MSR] startNextGame: board not found, waiting for presence monitor')
    // Board not found — don't kill the session.
    // The board presence monitor will detect when the board returns.
    currentState = 'ready'
    return
  }
  console.debug('[MSR] startNextGame: board', boardConfig.cols, 'x', boardConfig.rows, ', squareSize', boardConfig.squareSize)

  // Create a new recorder for this game
  // Player name priority: explicit override from popup > auto-detected from site
  const effectivePlayerName = playerName || adapter.getPlayerName?.() || undefined
  recorder = new GameRecorder({
    board: boardConfig,
    metadata: {
      program: adapter.getProgramName(),
      version: adapter.getVersion?.(),
      player: effectivePlayerName,
      timestamp: new Date().toISOString(),
      questionMarks: false,
      chordingMode: currentSettings?.chording,
    },
    mouseTrackerConfig: {
      boardElement,
      squareSize: boardConfig.squareSize,
      keyboardMouse: currentSettings?.keyboardMouse,
    },
    onStateChange: (state) => {
      // In multi-game mode, don't expose individual game 'finished' to the popup.
      // The session manages the transition from game-finished → ready-for-next.
      if (sessionActive && state === 'finished') return
      currentState = state
    },
  })

  // Set up game end detection
  adapter.onGameEnd?.((result) => {
    if (recorder && recorder.getState() === 'recording') {
      console.debug('[MSR] Game end detected:', result)
      recorder.finish(result)
      const finishedRecorder = recorder
      recorder = null  // Detach from global immediately

      // Read mines and save. Uses immediate read + retries in case the
      // site animates mine reveals after the face/status indicator changes.
      readMinesAndFinalize(adapter, finishedRecorder, result, 0)

      // Start waiting for the next game immediately (don't delay behind
      // mine reading — the board reset watcher must be active right away).
      if (sessionActive) {
        waitForNextGame(adapter)
      }
    }
  })

  // Start the recorder (enters 'ready' state, waiting for first click)
  recorder.start()
  currentState = 'ready'
  console.debug('[MSR] Recorder started, state = ready, waiting for first click')
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
 * Uses a saved recorder reference (not the global) so that a new game
 * starting during retries doesn't corrupt the old game's data.
 */
function readMinesAndFinalize(
  adapter: SiteAdapter,
  gameRecorder: GameRecorder,
  result: GameResult,
  attempt: number,
): void {
  const mines = adapter.getMinePositions?.(result) ?? []

  if (mines.length > 0) {
    console.debug(`[MSR] Found ${mines.length} mines (attempt ${attempt + 1})`)
    gameRecorder.setMinePositions(mines)
    saveCompletedGame(gameRecorder)
    return
  }

  if (attempt < MINE_READ_MAX_RETRIES) {
    setTimeout(
      () => readMinesAndFinalize(adapter, gameRecorder, result, attempt + 1),
      MINE_READ_DELAY_MS,
    )
    return
  }

  // All retries exhausted — save without mine data.
  console.warn(`[MSR] Could not read mine positions after ${attempt + 1} attempts`)
  saveCompletedGame(gameRecorder)
}

// --------------------------------------------------------------------------
// Game saving
// --------------------------------------------------------------------------

/**
 * Generate RAWVF from a finished recorder and persist to storage.
 */
function saveCompletedGame(gameRecorder: GameRecorder): void {
  const data = gameRecorder.getRecordingData()
  if (!data) return

  // Derive mine count from the actual mine positions found
  data.board.mines = data.minePositions.length

  const rawvf = generateRawvf(data)
  const filename = generateFilename(data)
  sessionGameCount++

  console.debug(`[MSR] Saved: ${filename} (${data.board.mines} mines, ${data.result})`)

  // Persist to storage. Fire-and-forget: the popup polls and will pick it up.
  saveGame({
    filename,
    timestamp: data.metadata.timestamp ?? new Date().toISOString(),
    cols: data.board.cols,
    rows: data.board.rows,
    mines: data.board.mines,
    result: data.result,
    timeMs: data.totalTimeMs,
  }, rawvf).catch(err => console.error('[MSR] Failed to save replay:', err))
}

/**
 * After a game ends, watch for the board to reset (player starts a new game).
 * When detected, automatically start recording the next game.
 */
function waitForNextGame(adapter: SiteAdapter): void {
  // Show 'ready' while waiting for the next game
  currentState = 'ready'

  adapter.onBoardReset?.(() => {
    if (sessionActive && !recorder) {
      startNextGame(adapter)
    }
  })
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
// Settings auto-detection
// --------------------------------------------------------------------------

// --------------------------------------------------------------------------
// SPA navigation monitor — settings auto-detection
// --------------------------------------------------------------------------

/**
 * minesweeper.online is a single-page app. The content script loads once and
 * survives all in-app navigation. To detect when the user visits the settings
 * page (so we can read their chording / keyboard config), we poll for URL
 * changes. This is more reliable than intercepting history.pushState (which
 * would require page-world script injection).
 */
let lastPathname = window.location.pathname

/**
 * Try to read settings from the current page's DOM.
 * Called when we detect the user is on the settings page.
 */
function tryReadSettings(adapter: SiteAdapter): void {
  const settings = adapter.readSettings?.()
  if (settings) {
    console.debug('[MSR] Auto-detected settings from settings page:', settings)
    saveAutoDetectedSettings(settings)
    currentSettings = settings
  }

  // Watch for live changes while on the settings page
  adapter.watchSettings?.((updatedSettings) => {
    console.debug('[MSR] Settings changed on settings page:', updatedSettings)
    saveAutoDetectedSettings(updatedSettings)
    currentSettings = updatedSettings
  })
}

function startNavigationMonitor(): void {
  const adapter = detectSiteAdapter()
  if (!adapter) return

  // Check immediately on load
  if (adapter.isSettingsPage?.()) {
    tryReadSettings(adapter)
  }

  // Poll for SPA navigation changes
  setInterval(() => {
    const currentPath = window.location.pathname
    if (currentPath === lastPathname) return

    const previousPath = lastPathname
    lastPathname = currentPath
    console.debug(`[MSR] SPA navigation: ${previousPath} → ${currentPath}`)

    if (adapter.isSettingsPage?.()) {
      // Just arrived on the settings page. The DOM may not be fully populated
      // yet (SPA content loads asynchronously), so retry a few times.
      adapter.cancelWatchSettings?.()
      let attempts = 0
      const tryRead = () => {
        const settings = adapter.readSettings?.()
        if (settings) {
          console.debug('[MSR] Auto-detected settings after navigation:', settings)
          saveAutoDetectedSettings(settings)
          currentSettings = settings
          // Now watch for live changes
          adapter.watchSettings?.((updated) => {
            console.debug('[MSR] Settings changed on settings page:', updated)
            saveAutoDetectedSettings(updated)
            currentSettings = updated
          })
        } else if (attempts < 5) {
          attempts++
          setTimeout(tryRead, 300)
        }
      }
      tryRead()
    } else if (previousPath === '/settings') {
      // Left the settings page — stop watching for changes
      adapter.cancelWatchSettings?.()
    }
  }, 500)
}

// Start on content script load
startNavigationMonitor()
