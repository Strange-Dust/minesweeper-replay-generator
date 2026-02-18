/**
 * Background service worker for Minesweeper Replay Generator.
 *
 * Handles:
 *   - Extension lifecycle events (install, update)
 *   - Optional: relay messages between popup and content scripts
 *     (currently popup communicates directly with content script via chrome.tabs)
 *
 * This is intentionally minimal — most logic lives in the content script
 * and popup. The service worker is mainly here for future expansion
 * (e.g., badge updates, notifications, cross-tab state).
 */

// --------------------------------------------------------------------------
// Extension lifecycle
// --------------------------------------------------------------------------

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    console.log('Minesweeper Replay Generator installed.')
  } else if (details.reason === 'update') {
    console.log(`Minesweeper Replay Generator updated to v${chrome.runtime.getManifest().version}`)
  }
})

// --------------------------------------------------------------------------
// Message relay (if needed in the future)
// --------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Currently, popup talks directly to content script.
  // This handler is here for potential future use (e.g., badge updates).

  if (message.type === 'RECORDING_STATE_CHANGED') {
    // Update the extension badge to show recording state
    updateBadge(message.state, sender.tab?.id)
  }

  // Return false to indicate synchronous (no async response needed)
  return false
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

  chrome.action.setBadgeText({ text: config.text, tabId })
  chrome.action.setBadgeBackgroundColor({ color: config.color, tabId })
}
