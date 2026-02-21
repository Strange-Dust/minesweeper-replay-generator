/**
 * Popup script for Minesweeper Replay Generator.
 *
 * Communicates with the content script in the active tab to:
 *   - Start/stop a multi-game recording session
 *   - Display recording status (state, game count, events, time)
 *   - Download recorded replays (.rawvf or .zip for multiple)
 */

import browser from '../utils/browser'
import type { StatusResponse } from '../types/messages'
import { createZipBlob } from '../utils/zip'

// --------------------------------------------------------------------------
// Types
// --------------------------------------------------------------------------

interface CompletedGame {
  rawvf: string
  filename: string
}

// --------------------------------------------------------------------------
// DOM elements
// --------------------------------------------------------------------------

const statusText = document.getElementById('status-text') as HTMLSpanElement
const gameCount = document.getElementById('game-count') as HTMLSpanElement
const eventCount = document.getElementById('event-count') as HTMLSpanElement
const elapsedTime = document.getElementById('elapsed-time') as HTMLSpanElement
const btnStart = document.getElementById('btn-start') as HTMLButtonElement
const btnStop = document.getElementById('btn-stop') as HTMLButtonElement
const btnDownload = document.getElementById('btn-download') as HTMLButtonElement
const playerNameInput = document.getElementById('player-name') as HTMLInputElement

// State
let currentState: string = 'idle'
let pollingInterval: ReturnType<typeof setInterval> | null = null

// --------------------------------------------------------------------------
// Initialization
// --------------------------------------------------------------------------

async function init(): Promise<void> {
  // Load saved player name
  const stored = await browser.storage.local.get('playerName')
  if (stored.playerName && typeof stored.playerName === 'string') {
    playerNameInput.value = stored.playerName
  }

  // Save player name on change
  playerNameInput.addEventListener('input', () => {
    browser.storage.local.set({ playerName: playerNameInput.value })
  })

  // Button handlers
  btnStart.addEventListener('click', startRecording)
  btnStop.addEventListener('click', stopRecording)
  btnDownload.addEventListener('click', downloadReplays)

  // Get initial status
  await refreshStatus()
}

// --------------------------------------------------------------------------
// Communication with content script
// --------------------------------------------------------------------------

/**
 * Send a message to the content script in the active tab.
 */
async function sendToContentScript(message: { type: string; [key: string]: unknown }): Promise<unknown> {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true })
  if (!tab?.id) {
    console.error('No active tab found')
    return null
  }

  try {
    return await browser.tabs.sendMessage(tab.id, message)
  } catch (err) {
    console.error('Failed to communicate with content script:', err)
    return null
  }
}

// --------------------------------------------------------------------------
// Actions
// --------------------------------------------------------------------------

async function startRecording(): Promise<void> {
  const playerName = playerNameInput.value.trim() || undefined
  await sendToContentScript({ type: 'START_RECORDING', playerName })
  startPolling()
  await refreshStatus()
}

async function stopRecording(): Promise<void> {
  await sendToContentScript({ type: 'STOP_RECORDING' })
  stopPolling()
  await refreshStatus()
}

async function downloadReplays(): Promise<void> {
  const response = await sendToContentScript({ type: 'GET_RECORDING_DATA' }) as { games?: CompletedGame[] } | null
  if (!response?.games?.length) {
    console.error('No recording data available')
    return
  }

  const games = response.games

  if (games.length === 1) {
    // Single game — download as .rawvf directly
    const game = games[0]!
    const blob = new Blob([game.rawvf], { type: 'text/plain' })
    triggerDownload(blob, game.filename)
  } else {
    // Multiple games — bundle into a .zip
    const zipBlob = createZipBlob(
      games.map(g => ({ filename: g.filename, content: g.rawvf }))
    )
    const dateStr = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 15).replace(/(\d{8})(\d{6})/, '$1_$2')
    triggerDownload(zipBlob, `minesweeper_replays_${dateStr}.zip`)
  }
}

function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  URL.revokeObjectURL(url)
}

async function refreshStatus(): Promise<void> {
  const response = await sendToContentScript({ type: 'GET_STATUS' }) as StatusResponse | null
  if (response) {
    updateUI(response)
  }
}

// --------------------------------------------------------------------------
// Polling — periodically queries the content script for recording status
// (state, game count, event count, elapsed time) to keep the popup UI current.
// Win/loss detection is NOT done here — it's handled by MutationObservers
// in the site adapter. This only refreshes the popup display.
// --------------------------------------------------------------------------

const POLL_INTERVAL_MS = 500

function startPolling(): void {
  if (pollingInterval) return
  pollingInterval = setInterval(refreshStatus, POLL_INTERVAL_MS)
}

function stopPolling(): void {
  if (pollingInterval) {
    clearInterval(pollingInterval)
    pollingInterval = null
  }
}

// --------------------------------------------------------------------------
// UI updates
// --------------------------------------------------------------------------

function updateUI(status: StatusResponse): void {
  currentState = status.state

  // Update status badge
  statusText.textContent = capitalize(status.state)
  statusText.className = `status ${status.state}`

  // Update counters
  gameCount.textContent = String(status.gameCount)
  eventCount.textContent = String(status.eventCount)
  elapsedTime.textContent = formatTime(status.elapsedMs ?? 0)

  // Update button states
  btnStart.disabled = status.state === 'recording' || status.state === 'ready'
  btnStop.disabled = status.state !== 'recording' && status.state !== 'ready'
  btnDownload.disabled = status.state !== 'finished' || status.gameCount === 0

  // Dynamic download button text
  if (status.gameCount <= 1) {
    btnDownload.textContent = '\uD83D\uDCBE Download .rawvf'
  } else {
    btnDownload.textContent = `\uD83D\uDCBE Download ${status.gameCount} replays (.zip)`
  }

  // Auto-start/stop polling based on state
  if (status.state === 'recording' || status.state === 'ready') {
    startPolling()
  } else {
    stopPolling()
  }
}

function formatTime(ms: number): string {
  const seconds = (ms / 1000).toFixed(3)
  return `${seconds}s`
}

function capitalize(str: string): string {
  return str.charAt(0).toUpperCase() + str.slice(1)
}

// --------------------------------------------------------------------------
// Start
// --------------------------------------------------------------------------

init()
