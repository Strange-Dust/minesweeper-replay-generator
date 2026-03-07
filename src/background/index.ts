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
import { SUPPORTED_SITE_PATTERNS } from '../sites'

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
  const msg = message as { type: string; state?: string }
  // Currently, popup talks directly to content script.
  // This handler is here for potential future use (e.g., badge updates).

  if (msg.type === 'RECORDING_STATE_CHANGED') {
    // Update the extension badge to show recording state
    updateBadge(msg.state ?? 'idle', sender.tab?.id)
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
