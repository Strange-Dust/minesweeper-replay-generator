/**
 * Popup script for Minesweeper Replay Generator.
 *
 * Two main sections:
 *   1. Recording controls — start/stop recording on the active tab
 *   2. Game history — list of all stored replays with select/download/delete
 *
 * Recording status is polled from the content script via messaging.
 * Game history is read directly from browser.storage.local (shared with content script).
 */

import browser from '../utils/browser'
import type { StatusResponse } from '../types/messages'
import type { GameSettings, ChordingMode } from '../types/settings'
import { DEFAULT_SETTINGS } from '../types/settings'
import {
  loadSettings,
  saveManualSettings,
  clearManualOverride,
  type StoredSettings,
} from '../storage/settingsStorage'
import {
  loadMeta,
  getGamesContent,
  deleteGames,
  clearAllGames,
  STORAGE_BUDGET_BYTES,
  type StoredGameMeta,
} from '../storage/gameStorage'
import { createZipBlob } from '../utils/zip'

// --------------------------------------------------------------------------
// DOM elements
// --------------------------------------------------------------------------

const statusText = document.getElementById('status-text') as HTMLSpanElement
const liveStats = document.getElementById('live-stats') as HTMLSpanElement
const btnStart = document.getElementById('btn-start') as HTMLButtonElement
const btnStop = document.getElementById('btn-stop') as HTMLButtonElement
const selectAll = document.getElementById('select-all') as HTMLInputElement
const storageInfoEl = document.getElementById('storage-info') as HTMLSpanElement
const gameListEl = document.getElementById('game-list') as HTMLDivElement
const btnDownload = document.getElementById('btn-download') as HTMLButtonElement
const btnDelete = document.getElementById('btn-delete') as HTMLButtonElement
const btnClearAll = document.getElementById('btn-clear-all') as HTMLButtonElement
const playerNameInput = document.getElementById('player-name') as HTMLInputElement
const winsOnlyCheckbox = document.getElementById('wins-only') as HTMLInputElement

// Settings elements
const settingsStatusEl = document.getElementById('settings-status') as HTMLDivElement
const settingsStatusText = document.getElementById('settings-status-text') as HTMLSpanElement
const chordingDisplay = document.getElementById('chording-display') as HTMLDivElement
const keyboardDisplay = document.getElementById('keyboard-display') as HTMLDivElement
const manualOverride = document.getElementById('manual-override') as HTMLInputElement
const manualSettingsEl = document.getElementById('manual-settings') as HTMLDivElement
const chordingSelect = document.getElementById('chording-select') as HTMLSelectElement
const keyboardEnabled = document.getElementById('keyboard-enabled') as HTMLInputElement
const keyboardKeysEl = document.getElementById('keyboard-keys') as HTMLDivElement
const leftKeySelect = document.getElementById('left-key') as HTMLSelectElement
const rightKeySelect = document.getElementById('right-key') as HTMLSelectElement

// --------------------------------------------------------------------------
// State
// --------------------------------------------------------------------------

/** All stored game metadata (oldest first) */
let games: StoredGameMeta[] = []

/** Currently selected game IDs */
let selectedIds = new Set<string>()

/** Session game count from the last status poll (for detecting new games) */
let lastSessionGameCount = 0

/** Status polling interval handle */
let pollingInterval: ReturnType<typeof setInterval> | null = null

// --------------------------------------------------------------------------
// Initialization
// --------------------------------------------------------------------------

async function init(): Promise<void> {
  // Load saved preferences
  const prefs = await browser.storage.local.get(['playerName', 'winsOnly'])
  if (prefs.playerName && typeof prefs.playerName === 'string') {
    playerNameInput.value = prefs.playerName
  }
  winsOnlyCheckbox.checked = prefs.winsOnly === true

  // Event listeners
  playerNameInput.addEventListener('input', () => {
    browser.storage.local.set({ playerName: playerNameInput.value })
  })
  winsOnlyCheckbox.addEventListener('change', () => {
    browser.storage.local.set({ winsOnly: winsOnlyCheckbox.checked })
  })
  btnStart.addEventListener('click', startRecording)
  btnStop.addEventListener('click', stopRecording)
  btnDownload.addEventListener('click', downloadSelected)
  btnDelete.addEventListener('click', deleteSelected)
  btnClearAll.addEventListener('click', clearAll)
  selectAll.addEventListener('change', onSelectAllChange)

  // Settings UI
  populateKeySelects()
  manualOverride.addEventListener('change', onManualOverrideChange)
  chordingSelect.addEventListener('change', onManualSettingChange)
  keyboardEnabled.addEventListener('change', onKeyboardEnabledChange)
  leftKeySelect.addEventListener('change', onManualSettingChange)
  rightKeySelect.addEventListener('change', onManualSettingChange)

  // Initial data load
  await Promise.all([
    refreshGameList(),
    refreshStatus(),
    refreshSettings(),
  ])
}

// --------------------------------------------------------------------------
// Content script communication
// --------------------------------------------------------------------------

/**
 * Send a message to the content script in the active tab.
 * Returns null if the content script is not available (wrong page, etc.).
 */
async function sendToContentScript(message: { type: string; [key: string]: unknown }): Promise<unknown> {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true })
  if (!tab?.id) return null

  try {
    return await browser.tabs.sendMessage(tab.id, message)
  } catch {
    return null
  }
}

// --------------------------------------------------------------------------
// Recording controls
// --------------------------------------------------------------------------

async function startRecording(): Promise<void> {
  const playerName = playerNameInput.value.trim() || undefined
  const response = await sendToContentScript({ type: 'START_RECORDING', playerName }) as { success?: boolean; error?: string } | null
  if (response?.error) {
    console.error('Start failed:', response.error)
  }
  lastSessionGameCount = 0
  startPolling()
  await refreshStatus()
}

async function stopRecording(): Promise<void> {
  await sendToContentScript({ type: 'STOP_RECORDING' })
  stopPolling()
  await refreshStatus()
  // New games may have been saved during the session
  await refreshGameList()
}

async function refreshStatus(): Promise<void> {
  const response = await sendToContentScript({ type: 'GET_STATUS' }) as StatusResponse | null
  updateRecordingUI(response)

  // Show auto-detected player name as placeholder if the user hasn't typed one
  if (response?.detectedPlayerName && !playerNameInput.value.trim()) {
    playerNameInput.placeholder = response.detectedPlayerName
  }

  // If a new game was saved during this session, refresh the game list
  if (response && response.gameCount > lastSessionGameCount) {
    lastSessionGameCount = response.gameCount
    await refreshGameList()
  }
}

// --------------------------------------------------------------------------
// Polling — periodically queries the content script for recording status
// (state, event count, elapsed time) to keep the recording UI current.
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
// Game history
// --------------------------------------------------------------------------

async function refreshGameList(): Promise<void> {
  games = await loadMeta()
  // Prune selections that no longer exist in storage
  const gameIds = new Set(games.map(g => g.id))
  for (const id of selectedIds) {
    if (!gameIds.has(id)) selectedIds.delete(id)
  }
  renderGameList()
  updateStorageInfo()
  updateActionButtons()
}

function renderGameList(): void {
  if (games.length === 0) {
    gameListEl.innerHTML = '<div class="empty-state">No recorded games yet</div>'
    selectAll.disabled = true
    return
  }

  selectAll.disabled = false

  // Show newest first
  const sorted = [...games].reverse()

  gameListEl.innerHTML = sorted.map(game => {
    const checked = selectedIds.has(game.id) ? 'checked' : ''
    const level = getLevelDisplay(game.cols, game.rows, game.mines)
    const result = formatResult(game.result)
    const time = formatGameTime(game.timeMs)
    const size = formatSize(game.sizeBytes)
    const date = formatDate(game.timestamp)

    return `<label class="game-item" data-id="${escapeAttr(game.id)}">
      <input type="checkbox" ${checked} />
      <div class="game-details">
        <div class="game-row-main">
          <span class="game-level">${level}</span>
          <span class="game-result ${game.result}">${result}</span>
          <span class="game-time">${time}</span>
          <span class="game-size">${size}</span>
        </div>
        <div class="game-row-date">${date}</div>
      </div>
    </label>`
  }).join('')

  // Attach checkbox listeners
  gameListEl.querySelectorAll('input[type="checkbox"]').forEach(cb => {
    cb.addEventListener('change', onItemCheckboxChange)
  })
}

function onItemCheckboxChange(e: Event): void {
  const checkbox = e.target as HTMLInputElement
  const item = checkbox.closest('.game-item') as HTMLElement
  const id = item?.dataset.id
  if (!id) return

  if (checkbox.checked) {
    selectedIds.add(id)
  } else {
    selectedIds.delete(id)
  }

  updateSelectAllState()
  updateActionButtons()
}

function onSelectAllChange(): void {
  const checked = selectAll.checked
  if (checked) {
    games.forEach(g => selectedIds.add(g.id))
  } else {
    selectedIds.clear()
  }

  gameListEl.querySelectorAll<HTMLInputElement>('input[type="checkbox"]').forEach(cb => {
    cb.checked = checked
  })

  updateActionButtons()
}

function updateSelectAllState(): void {
  if (games.length === 0) {
    selectAll.checked = false
    selectAll.indeterminate = false
    return
  }
  const allSelected = games.every(g => selectedIds.has(g.id))
  const someSelected = games.some(g => selectedIds.has(g.id))
  selectAll.checked = allSelected
  selectAll.indeterminate = someSelected && !allSelected
}

// --------------------------------------------------------------------------
// Actions
// --------------------------------------------------------------------------

async function downloadSelected(): Promise<void> {
  // Download selected, or all if none explicitly selected
  const ids = selectedIds.size > 0
    ? [...selectedIds]
    : games.map(g => g.id)
  if (ids.length === 0) return

  const contents = await getGamesContent(ids, games)
  if (contents.length === 0) return

  if (contents.length === 1) {
    const game = contents[0]!
    const blob = new Blob([game.rawvf], { type: 'text/plain' })
    triggerDownload(blob, game.filename)
  } else {
    const zipBlob = createZipBlob(
      contents.map(g => ({ filename: g.filename, content: g.rawvf }))
    )
    const dateStr = formatDateForFilename()
    triggerDownload(zipBlob, `minesweeper_replays_${dateStr}.zip`)
  }
}

async function deleteSelected(): Promise<void> {
  // Only delete explicitly selected games (never "delete all" by accident)
  if (selectedIds.size === 0) return

  const count = selectedIds.size
  const confirmed = confirm(
    `Delete ${count} replay${count > 1 ? 's' : ''}? This cannot be undone.`
  )
  if (!confirmed) return

  await deleteGames([...selectedIds])
  selectedIds.clear()
  await refreshGameList()
}

async function clearAll(): Promise<void> {
  if (games.length === 0) return

  const confirmed = confirm(
    `Delete ALL ${games.length} replay${games.length > 1 ? 's' : ''}? This cannot be undone.`
  )
  if (!confirmed) return

  await clearAllGames()
  selectedIds.clear()
  await refreshGameList()
}

function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  URL.revokeObjectURL(url)
}

// --------------------------------------------------------------------------
// UI updates
// --------------------------------------------------------------------------

function updateRecordingUI(status: StatusResponse | null): void {
  if (!status) {
    // Content script not available (wrong page or not injected)
    statusText.textContent = 'Unavailable'
    statusText.className = 'status unavailable'
    liveStats.textContent = 'Navigate to a supported minesweeper site'
    btnStart.disabled = true
    btnStop.disabled = true
    return
  }

  statusText.textContent = capitalize(status.state)
  statusText.className = `status ${status.state}`

  // Live stats during recording
  if (status.state === 'recording') {
    const time = formatGameTime(status.elapsedMs ?? 0)
    liveStats.textContent = `${status.eventCount} events · ${time}`
  } else if (status.state === 'ready') {
    liveStats.textContent = status.gameCount > 0
      ? `${status.gameCount} game${status.gameCount > 1 ? 's' : ''} this session`
      : 'Waiting for first click…'
  } else {
    liveStats.textContent = ''
  }

  btnStart.disabled = status.state === 'recording' || status.state === 'ready'
  btnStop.disabled = status.state !== 'recording' && status.state !== 'ready'

  // Auto-start/stop polling based on state
  if (status.state === 'recording' || status.state === 'ready') {
    startPolling()
  } else {
    stopPolling()
  }
}

function updateStorageInfo(): void {
  const usedBytes = games.reduce((sum, g) => sum + g.sizeBytes, 0)
  storageInfoEl.textContent = `${formatSize(usedBytes)} / ${formatSize(STORAGE_BUDGET_BYTES)}`
}

function updateActionButtons(): void {
  const selCount = selectedIds.size
  const hasGames = games.length > 0

  btnDownload.disabled = !hasGames
  btnDelete.disabled = selCount === 0
  btnClearAll.disabled = !hasGames

  if (selCount > 0) {
    btnDownload.textContent = `💾 Download (${selCount})`
  } else if (hasGames) {
    btnDownload.textContent = `💾 Download All (${games.length})`
  } else {
    btnDownload.textContent = '💾 Download'
  }
}

// --------------------------------------------------------------------------
// Formatting utilities
// --------------------------------------------------------------------------

function getLevelDisplay(cols: number, rows: number, mines: number): string {
  if (cols === 8 && rows === 8 && mines === 10) return 'Beg'
  if (cols === 16 && rows === 16 && mines === 40) return 'Int'
  if (cols === 30 && rows === 16 && mines === 99) return 'Exp'
  return `${cols}×${rows}`
}

function formatResult(result: string): string {
  if (result === 'won') return 'Won'
  if (result === 'lost') return 'Lost'
  return '—'
}

function formatGameTime(ms: number): string {
  return `${(ms / 1000).toFixed(3)}s`
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function formatDate(isoString: string): string {
  try {
    const date = new Date(isoString)
    const now = new Date()
    const diffMs = now.getTime() - date.getTime()
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24))

    const timeStr = date.toLocaleTimeString(undefined, {
      hour: 'numeric',
      minute: '2-digit',
    })

    if (diffDays === 0) return `Today, ${timeStr}`
    if (diffDays === 1) return `Yesterday, ${timeStr}`

    return date.toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    })
  } catch {
    return 'Unknown date'
  }
}

function formatDateForFilename(): string {
  return new Date().toISOString()
    .replace(/[-:T]/g, '')
    .replace(/\.\d+Z$/, '')
    .replace(/(\d{8})(\d{6})/, '$1_$2')
}

function capitalize(str: string): string {
  return str.charAt(0).toUpperCase() + str.slice(1)
}

function escapeAttr(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/"/g, '&quot;')
}

// --------------------------------------------------------------------------
// Settings UI
// --------------------------------------------------------------------------

/** Common key codes available on minesweeper.online */
const KEY_OPTIONS: { code: number; label: string }[] = [
  { code: 32, label: 'Space' },
  { code: 65, label: 'A' },
  { code: 68, label: 'D' },
  { code: 70, label: 'F' },
  { code: 74, label: 'J' },
  { code: 75, label: 'K' },
  { code: 76, label: 'L' },
  { code: 83, label: 'S' },
  { code: 87, label: 'W' },
  { code: 90, label: 'Z' },
]

function populateKeySelects(): void {
  for (const select of [leftKeySelect, rightKeySelect]) {
    select.innerHTML = KEY_OPTIONS.map(k =>
      `<option value="${k.code}">${k.label}</option>`
    ).join('')
  }
}

async function refreshSettings(): Promise<void> {
  const stored = await loadSettings()
  updateSettingsUI(stored)
}

function updateSettingsUI(stored: StoredSettings): void {
  const isManual = stored.manualOverride
  const hasAutoDetected = stored.autoDetectedSettings !== null

  // Effective settings: manual if override active, otherwise auto-detected, otherwise defaults
  const effectiveSettings = (isManual && stored.manualSettings)
    ? stored.manualSettings
    : (stored.autoDetectedSettings ?? DEFAULT_SETTINGS)

  // Status line
  if (isManual) {
    settingsStatusEl.className = 'settings-status detected'
    settingsStatusText.textContent = hasAutoDetected
      ? 'Manual override active (auto-detected settings saved)'
      : 'Manual override active'
  } else if (hasAutoDetected) {
    settingsStatusEl.className = 'settings-status detected'
    settingsStatusText.textContent = 'Auto-detected from settings page'
  } else {
    settingsStatusEl.className = 'settings-status'
    settingsStatusText.textContent = '⚠️ Not detected — visit the game\'s settings page'
  }

  // Show/hide warning icon on the collapsed summary
  const summaryEl = document.getElementById('settings-summary')
  if (summaryEl) {
    summaryEl.textContent = (hasAutoDetected || isManual) ? 'Settings' : '⚠️ Settings'
  }

  // Current values display (shows effective settings)
  chordingDisplay.textContent = formatChordingMode(effectiveSettings.chording)
  keyboardDisplay.textContent = formatKeyboardConfig(effectiveSettings.keyboardMouse)

  // Manual override checkbox
  manualOverride.checked = isManual

  // Manual controls visibility
  if (isManual) {
    manualSettingsEl.classList.remove('hidden')
    const manualValues = stored.manualSettings ?? effectiveSettings
    chordingSelect.value = manualValues.chording
    keyboardEnabled.checked = manualValues.keyboardMouse.enabled
    leftKeySelect.value = String(manualValues.keyboardMouse.leftKeyCode)
    rightKeySelect.value = String(manualValues.keyboardMouse.rightKeyCode)
    keyboardKeysEl.classList.toggle('hidden', !manualValues.keyboardMouse.enabled)
  } else {
    manualSettingsEl.classList.add('hidden')
  }
}

function formatChordingMode(mode: ChordingMode): string {
  switch (mode) {
    case 'superclick': return 'Left click (SuperClick)'
    case 'both': return 'Left+Right click'
    case 'disabled': return 'Disabled'
  }
}

function formatKeyboardConfig(config: { enabled: boolean; leftKeyCode: number; rightKeyCode: number }): string {
  if (!config.enabled) return 'Disabled'
  const left = KEY_OPTIONS.find(k => k.code === config.leftKeyCode)?.label ?? `Key ${config.leftKeyCode}`
  const right = KEY_OPTIONS.find(k => k.code === config.rightKeyCode)?.label ?? `Key ${config.rightKeyCode}`
  return `Enabled (L: ${left}, R: ${right})`
}

async function onManualOverrideChange(): Promise<void> {
  if (manualOverride.checked) {
    // Enable manual override — seed with current effective settings as starting values
    const stored = await loadSettings()
    const seedSettings = stored.autoDetectedSettings ?? DEFAULT_SETTINGS
    await saveManualSettings(seedSettings)
  } else {
    await clearManualOverride()
  }
  await refreshSettings()
}

async function onManualSettingChange(): Promise<void> {
  if (!manualOverride.checked) return
  await saveManualSettings(getManualSettingsFromUI())
  await refreshSettings()
}

function onKeyboardEnabledChange(): void {
  keyboardKeysEl.classList.toggle('hidden', !keyboardEnabled.checked)
  onManualSettingChange()
}

function getManualSettingsFromUI(): GameSettings {
  return {
    chording: chordingSelect.value as ChordingMode,
    keyboardMouse: {
      enabled: keyboardEnabled.checked,
      leftKeyCode: parseInt(leftKeySelect.value, 10) || DEFAULT_SETTINGS.keyboardMouse.leftKeyCode,
      rightKeyCode: parseInt(rightKeySelect.value, 10) || DEFAULT_SETTINGS.keyboardMouse.rightKeyCode,
    },
  }
}

// --------------------------------------------------------------------------
// Start
// --------------------------------------------------------------------------

init()
