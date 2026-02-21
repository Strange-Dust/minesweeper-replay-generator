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
 * Site-specific board detection is handled by "site adapters" — each adapter
 * knows how to find the board, extract cell states, and detect game results
 * for a particular minesweeper website.
 */

import browser from '../utils/browser'
import type { RecordingState, GameResult } from '../types/rawvf'
import type { StatusResponse } from '../types/messages'
import { GameRecorder } from '../recording/recorder'
import { generateRawvf, generateFilename } from '../rawvf/writer'
import { detectSiteAdapter, type SiteAdapter } from './siteAdapters'

// --------------------------------------------------------------------------
// Types
// --------------------------------------------------------------------------

export interface CompletedGame {
  rawvf: string
  filename: string
}

// --------------------------------------------------------------------------
// State
// --------------------------------------------------------------------------

/** Whether a multi-game session is currently active */
let sessionActive = false

/** Adapter for the current session (set once at session start) */
let currentAdapter: SiteAdapter | null = null

/** Games completed and finalized during this session */
let completedGames: CompletedGame[] = []

/** Current game recorder (one per game, recreated between games) */
let recorder: GameRecorder | null = null

/** State exposed to the popup via GET_STATUS */
let currentState: RecordingState = 'idle'

/** Player name for replay metadata */
let playerName: string | undefined

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

    case 'GET_RECORDING_DATA':
      return Promise.resolve(getRecordingDataResponse())
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
  completedGames = []

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

  // Cancel any pending board reset watcher
  currentAdapter?.cancelBoardReset?.()

  // If a game is currently in progress, abort it
  if (recorder) {
    const state = recorder.getState()
    if (state === 'recording') {
      // Game was in progress — abort and try to salvage the recording
      recorder.abort()
      finalizeCurrentGame(currentAdapter, 'unknown')
    } else if (state === 'ready') {
      // Game hadn't started yet — just clean up
      recorder.abort()
      recorder = null
    }
  }

  currentState = completedGames.length > 0 ? 'finished' : 'idle'
}

// --------------------------------------------------------------------------
// Per-game lifecycle
// --------------------------------------------------------------------------

/**
 * Set up and start a new game recorder within the active session.
 * Called at session start and after each board reset.
 */
function startNextGame(adapter: SiteAdapter): void {
  // Get fresh board config (user might have changed difficulty between games)
  const boardElement = adapter.findBoardElement()
  const boardConfig = adapter.getBoardConfig()
  if (!boardElement || !boardConfig) {
    // Board disappeared — end the session gracefully
    sessionActive = false
    currentState = completedGames.length > 0 ? 'finished' : 'idle'
    return
  }

  // Create a new recorder for this game
  recorder = new GameRecorder({
    board: boardConfig,
    metadata: {
      program: adapter.getProgramName(),
      version: adapter.getVersion?.(),
      player: playerName,
      timestamp: new Date().toISOString(),
      questionMarks: false,
    },
    mouseTrackerConfig: {
      boardElement,
      squareSize: boardConfig.squareSize,
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
      // Capture mine positions before finishing
      const mines = adapter.getMinePositions?.(result)
      if (mines) {
        recorder.setMinePositions(mines)
      }
      recorder.finish(result)

      // Finalize and store the completed game
      finalizeCurrentGame(adapter, result)

      // If session is still active, prepare for the next game
      if (sessionActive) {
        waitForNextGame(adapter)
      }
    }
  })

  // Start the recorder (enters 'ready' state, waiting for first click)
  recorder.start()
  currentState = 'ready'
}

/**
 * Extract recording data from the current game and add it to completedGames.
 */
function finalizeCurrentGame(adapter: SiteAdapter | null, result: GameResult): void {
  if (!recorder) return

  // Belt-and-suspenders: try to get mine positions if not already set
  if (adapter) {
    const mines = adapter.getMinePositions?.(result)
    if (mines && mines.length > 0) {
      recorder.setMinePositions(mines)
    }
  }

  const data = recorder.getRecordingData()
  if (data) {
    // Derive mine count from the actual mine positions found
    data.board.mines = data.minePositions.length

    const rawvf = generateRawvf(data)
    const filename = generateFilename(data)
    completedGames.push({ rawvf, filename })
  }

  recorder = null
}

/**
 * After a game ends, watch for the board to reset (player starts a new game).
 * When detected, automatically start recording the next game.
 */
function waitForNextGame(adapter: SiteAdapter): void {
  // Show 'ready' while waiting for the next game
  currentState = 'ready'

  adapter.onBoardReset?.(() => {
    if (sessionActive) {
      startNextGame(adapter)
    }
  })
}

// --------------------------------------------------------------------------
// Status / data responses
// --------------------------------------------------------------------------

function getStatus(): StatusResponse {
  return {
    state: currentState,
    gameCount: completedGames.length,
    eventCount: recorder?.getEventCount() ?? 0,
    elapsedMs: recorder?.getElapsedMs() ?? 0,
  }
}

function getRecordingDataResponse(): { games: CompletedGame[] } {
  return { games: completedGames }
}
