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
import { mlog, mwarn } from '../utils/log'
import {
  initWebSocketCapture,
  isWebSocketCaptureSupported,
  startCapture,
  stopCapture,
  isCaptureActive,
} from './webSocketCapture'
import type { WsCaptureStatusResponse } from '../types/messages'

/**
 * URL match patterns for all supported minesweeper sites.
 * Keep in sync with manifest.json content_scripts.matches + host_permissions.
 */
const SUPPORTED_SITE_PATTERNS: string[] = [
  'https://minesweeper.online/*',
]

// --------------------------------------------------------------------------
// Extension lifecycle
// --------------------------------------------------------------------------

browser.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    mlog('Minesweeper Replay Generator installed.')
  } else if (details.reason === 'update') {
    mlog(`Minesweeper Replay Generator updated to v${browser.runtime.getManifest().version}`)
  }

  // Inject the content script into any supported minesweeper site tabs that
  // are already open. Normally content_scripts only fire on new page loads,
  // so tabs open before install/update wouldn't have it.
  //
  // This is purely the same passive, read-only content script that
  // content_scripts would inject on the next navigation. The content
  // script has a double-injection guard so it's safe if both fire.
  injectIntoExistingTabs()
})

/**
 * Find all open tabs matching supported minesweeper sites and inject the
 * content script. Best-effort: errors are logged but never thrown (the tab
 * might be discarded, frozen, or on a restricted page like the Chrome Web Store).
 */
async function injectIntoExistingTabs(): Promise<void> {
  try {
    const tabs = await browser.tabs.query({ url: SUPPORTED_SITE_PATTERNS })
    for (const tab of tabs) {
      if (!tab.id) continue
      try {
        await browser.scripting.executeScript({
          target: { tabId: tab.id },
          files: ['content/index.js'],
        })
        mlog(`Injected content script into tab ${tab.id}: ${tab.url}`)
      } catch (err) {
        // Expected for tabs that are frozen, discarded, or already have it
        mwarn(`Could not inject into tab ${tab.id}:`, err)
      }
    }
  } catch (err) {
    mwarn('Could not query tabs:', err)
  }
}

// --------------------------------------------------------------------------
// Message relay (if needed in the future)
// --------------------------------------------------------------------------

browser.runtime.onMessage.addListener((message: unknown, sender: browser.Runtime.MessageSender) => {
  const msg = message as { type: string; state?: string; tabId?: number }

  if (msg.type === 'RECORDING_STATE_CHANGED') {
    // Update the extension badge to show recording state
    updateBadge(msg.state ?? 'idle', sender.tab?.id)
  }

  // --- WebSocket capture messages ---
  // These can come from either the popup (sender.tab is undefined) or
  // the content script (sender.tab.id available). The popup sends an
  // explicit tabId field; the content script uses sender.tab.id.

  if (msg.type === 'START_WS_CAPTURE') {
    const tabId = msg.tabId ?? sender.tab?.id
    if (!tabId) return Promise.resolve({ success: false, error: 'No tab ID' })

    return startCapture(tabId, handleCapturedReplayData)
      .then((success) => ({ success }))
      .catch((err) => ({ success: false, error: String(err) }))
  }

  if (msg.type === 'STOP_WS_CAPTURE') {
    const tabId = msg.tabId ?? sender.tab?.id
    if (!tabId) return Promise.resolve({ success: true })

    return stopCapture(tabId).then(() => ({ success: true }))
  }

  if (msg.type === 'GET_WS_CAPTURE_STATUS') {
    const tabId = msg.tabId ?? sender.tab?.id
    const response: WsCaptureStatusResponse = {
      supported: isWebSocketCaptureSupported(),
      active: tabId != null && isCaptureActive(tabId),
    }
    return Promise.resolve(response)
  }
})

// --------------------------------------------------------------------------
// WebSocket capture: forward replay data to the content script
// --------------------------------------------------------------------------

/**
 * Called by the WebSocket capture module when a 203 replay response is
 * extracted from a WebSocket frame. Forwards the data to the content
 * script in the originating tab for storage/processing.
 */
function handleCapturedReplayData(tabId: number, data: unknown): void {
  mlog('Forwarding captured replay data to tab', tabId)
  browser.tabs.sendMessage(tabId, {
    type: 'WS_REPLAY_DATA',
    data,
  }).catch((err) => {
    mwarn('Could not forward replay data to tab', tabId, err)
  })
}

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

// --------------------------------------------------------------------------
// WebSocket capture initialization
// --------------------------------------------------------------------------
// Register CDP event listeners at the top level of the service worker so
// they persist across MV3 service worker restarts. Safe on all browsers —
// no-ops if chrome.debugger is unavailable.

initWebSocketCapture()
