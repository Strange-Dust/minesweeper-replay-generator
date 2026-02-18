/**
 * Background service worker for Minesweeper Replay Generator.
 *
 * Handles:
 *   - Extension lifecycle events (install, update)
 *   - Optional: relay messages between popup and content scripts
 *     (currently popup communicates directly with content script via browser.tabs)
 *
 * This is intentionally minimal — most logic lives in the content script
 * and popup. The service worker is mainly here for future expansion
 * (e.g., badge updates, notifications, cross-tab state).
 */

import browser from '../utils/browser'

// --------------------------------------------------------------------------
// Extension lifecycle
// --------------------------------------------------------------------------

browser.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    console.log('Minesweeper Replay Generator installed.')
  } else if (details.reason === 'update') {
    console.log(`Minesweeper Replay Generator updated to v${browser.runtime.getManifest().version}`)
  }
})

// --------------------------------------------------------------------------
// Message relay (if needed in the future)
// --------------------------------------------------------------------------

browser.runtime.onMessage.addListener((message, sender) => {
  // Currently, popup talks directly to content script.
  // This handler is here for potential future use (e.g., badge updates).

  if (message.type === 'RECORDING_STATE_CHANGED') {
    // Update the extension badge to show recording state
    updateBadge(message.state, sender.tab?.id)
  }
})

// --------------------------------------------------------------------------
// Badge updates
// --------------------------------------------------------------------------

function updateBadge(state: string, tabId?: number): void {
  const badgeConfig: Record<string, { text: string; color: string }> = {
    idle: { text: '', color: '#6c757d' },
    ready: { text: '⏳', color: '#ffc107' },
    recording: { text: 'REC', color: '#dc3545' },
    finished: { text: '✓', color: '#198754' },
  }

  const config = badgeConfig[state] ?? badgeConfig['idle']!

  browser.action.setBadgeText({ text: config.text, tabId })
  browser.action.setBadgeBackgroundColor({ color: config.color, tabId })
}
