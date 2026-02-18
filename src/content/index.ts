/**
 * Content script for Minesweeper Replay Generator.
 *
 * Injected into web pages to detect minesweeper boards and record gameplay.
 *
 * This is the main entry point that:
 *   1. Listens for messages from the popup (start/stop/status)
 *   2. Manages the GameRecorder lifecycle
 *   3. Routes recording data back to the popup for download
 *
 * Site-specific board detection is handled by "site adapters" — each adapter
 * knows how to find the board, extract cell states, and detect game results
 * for a particular minesweeper website.
 */

import type { RecordingState, RecordingData } from '../types/rawvf'
import type { StatusResponse } from '../types/messages'
import { GameRecorder } from '../recording/recorder'
import { generateRawvf, generateFilename } from '../rawvf/writer'
import { detectSiteAdapter, type SiteAdapter } from './siteAdapters'

// --------------------------------------------------------------------------
// State
// --------------------------------------------------------------------------

let recorder: GameRecorder | null = null
let lastRecordingData: RecordingData | null = null
let lastRawvf: string | null = null
let lastFilename: string | null = null
let currentState: RecordingState = 'idle'
let playerName: string | undefined

// --------------------------------------------------------------------------
// Message handler
// --------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  switch (message.type) {
    case 'START_RECORDING':
      playerName = message.playerName
      handleStartRecording()
        .then((result) => sendResponse(result))
        .catch((err) => sendResponse({ error: String(err) }))
      return true // async response

    case 'STOP_RECORDING':
      handleStopRecording()
      sendResponse({ success: true })
      return false

    case 'GET_STATUS':
      sendResponse(getStatus())
      return false

    case 'GET_RECORDING_DATA':
      sendResponse(getRecordingDataResponse())
      return false
  }
})

// --------------------------------------------------------------------------
// Recording control
// --------------------------------------------------------------------------

async function handleStartRecording(): Promise<{ success: boolean; error?: string }> {
  // Detect which minesweeper site we're on
  const adapter = detectSiteAdapter()
  if (!adapter) {
    return {
      success: false,
      error: 'Could not detect a minesweeper board on this page. Make sure you are on a supported minesweeper website.',
    }
  }

  // Find the board element
  const boardElement = adapter.findBoardElement()
  if (!boardElement) {
    return {
      success: false,
      error: 'Minesweeper board element not found on this page.',
    }
  }

  // Get board configuration
  const boardConfig = adapter.getBoardConfig()
  if (!boardConfig) {
    return {
      success: false,
      error: 'Could not determine board configuration (dimensions, mine count).',
    }
  }

  // Reset any previous recording
  lastRecordingData = null
  lastRawvf = null
  lastFilename = null

  // Create the recorder
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
    boardTrackerConfig: {
      boardElement,
      cellSelector: adapter.getCellSelector(),
      extractCellState: adapter.extractCellState,
      extractCellPosition: adapter.extractCellPosition,
    },
    onStateChange: (state) => {
      currentState = state

      if (state === 'finished') {
        finalizeRecording(adapter)
      }
    },
  })

  // Set up game result detection
  adapter.onGameEnd?.((result) => {
    if (recorder && recorder.getState() === 'recording') {
      // Try to get mine positions when game ends
      const mines = adapter.getMinePositions?.()
      if (mines) {
        recorder.setMinePositions(mines)
      }
      recorder.finish(result)
    }
  })

  // Start the recorder
  recorder.start()
  currentState = 'ready'

  return { success: true }
}

function handleStopRecording(): void {
  if (!recorder) return

  const state = recorder.getState()
  if (state === 'recording' || state === 'ready') {
    recorder.abort()
    finalizeRecording(detectSiteAdapter())
  }
}

function finalizeRecording(adapter: SiteAdapter | null): void {
  if (!recorder) return

  // Try to get mine positions if we don't have them yet
  if (adapter) {
    const mines = adapter.getMinePositions?.()
    if (mines && mines.length > 0) {
      recorder.setMinePositions(mines)
    }
  }

  lastRecordingData = recorder.getRecordingData()
  if (lastRecordingData) {
    lastRawvf = generateRawvf(lastRecordingData)
    lastFilename = generateFilename(lastRecordingData)
  }

  currentState = 'finished'
}

// --------------------------------------------------------------------------
// Status / data responses
// --------------------------------------------------------------------------

function getStatus(): StatusResponse {
  return {
    state: currentState,
    eventCount: recorder?.getEventCount() ?? 0,
    elapsedMs: recorder?.getElapsedMs() ?? 0,
  }
}

function getRecordingDataResponse(): { rawvf?: string; filename?: string } {
  if (!lastRawvf) return {}
  return {
    rawvf: lastRawvf,
    filename: lastFilename ?? 'replay.rawvf',
  }
}
