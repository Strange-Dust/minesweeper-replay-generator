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
import { mlog, minfo, mwarn } from '../utils/log'
import {
  initWebSocketCapture,
  isWebSocketCaptureSupported,
  startCapture,
  stopCapture,
  isCaptureActive,
} from './webSocketCapture'
import type { WsCaptureStatusResponse } from '../types/messages'

/** Analyzer URL — keep in sync with popup.ts ANALYZER_URL and manifest.json host_permissions */
const ANALYZER_URL = 'https://strange-dust.github.io/minesweeper-replay-analyzer/'

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
// Message handler
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

  if (msg.type === 'SEND_TO_ANALYZER') {
    const { rawvf, filename, analyzerUrl } = message as {
      type: string; rawvf: string; filename: string; analyzerUrl: string
    }
    return handleSendToAnalyzer(rawvf, filename, analyzerUrl, true)
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
// Send to Analyzer
// --------------------------------------------------------------------------

/** Storage key for pending replay data to be picked up by the analyzer tab */
const PENDING_REPLAY_KEY = 'pendingAnalyzerReplay'

/** Track the analyzer tab so we can reuse it even if tabs.query fails */
let analyzerTabId: number | null = null

async function handleSendToAnalyzer(
  rawvf: string,
  filename: string,
  analyzerUrl: string,
  focusTab = true,
): Promise<{ success: boolean; error?: string }> {
  try {
    let tabId: number | null = null
    let isNewTab = false

    // 1. Check tracked tab
    if (analyzerTabId != null) {
      try {
        const tab = await browser.tabs.get(analyzerTabId)
        if (tab.url && tab.url.startsWith(analyzerUrl)) {
          tabId = analyzerTabId
          mlog('Send to analyzer: reusing tracked tab', tabId)
        } else {
          analyzerTabId = null
        }
      } catch {
        analyzerTabId = null
      }
    }

    // 2. Search all tabs by URL
    if (tabId == null) {
      const tabs = await browser.tabs.query({ url: analyzerUrl + '*' })
      if (tabs.length > 0 && tabs[0]!.id != null) {
        tabId = tabs[0]!.id
        analyzerTabId = tabId
        mlog('Send to analyzer: found existing tab via query', tabId)
      }
    }

    // 3. Focus existing tab or create new one
    if (tabId != null) {
      if (focusTab) {
        await browser.tabs.update(tabId, { active: true })
        try {
          const tab = await browser.tabs.get(tabId)
          if (tab.windowId != null) {
            await browser.windows.update(tab.windowId, { focused: true })
          }
        } catch { /* window focus is best-effort */ }
      }
    } else {
      isNewTab = true
    }

    // 4. Deliver the replay
    if (isNewTab) {
      // New tab strategy: write replay to extension storage, open the tab,
      // then inject a delivery script (isolated world) that reads from
      // storage and retries postMessage until the SPA picks it up.
      await browser.storage.local.set({
        [PENDING_REPLAY_KEY]: { rawvf, filename, timestamp: Date.now() },
      })

      const newTab = await browser.tabs.create({ url: analyzerUrl, active: focusTab })
      if (!newTab.id) return { success: false, error: 'Failed to create tab' }
      tabId = newTab.id
      analyzerTabId = tabId

      await waitForTabLoad(tabId)

      await browser.scripting.executeScript({
        target: { tabId },
        func: deliverPendingReplay,
        args: [PENDING_REPLAY_KEY],
      })
    } else {
      // Existing tab — SPA is already initialized, send directly via MAIN world
      await browser.scripting.executeScript({
        target: { tabId: tabId! },
        world: 'MAIN',
        func: sendReplayDirect,
        args: [rawvf, filename],
      })
    }

    minfo('Sent replay to analyzer:', filename, isNewTab ? '(new tab)' : '(existing tab)')
    return { success: true }
  } catch (err) {
    mwarn('Send to analyzer failed:', err)
    return { success: false, error: String(err) }
  }
}

/**
 * Wait for a tab to reach the "complete" loaded state.
 * Resolves immediately if the tab is already loaded.
 */
function waitForTabLoad(tabId: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      browser.tabs.onUpdated.removeListener(listener)
      reject(new Error('Tab load timeout (30s)'))
    }, 30_000)

    function done(): void {
      clearTimeout(timeout)
      browser.tabs.onUpdated.removeListener(listener)
      resolve()
    }

    function listener(id: number, changeInfo: { status?: string }): void {
      if (id === tabId && changeInfo.status === 'complete') done()
    }

    browser.tabs.onUpdated.addListener(listener)

    // Check if already loaded (race with the listener)
    browser.tabs.get(tabId).then(tab => {
      if (tab.status === 'complete') done()
    }).catch(() => {
      clearTimeout(timeout)
      browser.tabs.onUpdated.removeListener(listener)
      reject(new Error('Tab not found'))
    })
  })
}

/**
 * Injected into a NEW analyzer tab via scripting.executeScript (isolated world).
 *
 * Reads the pending replay from extension storage, then retries posting
 * it to the page via window.postMessage until the SPA acknowledges receipt.
 *
 * Runs in the isolated content script world so it has access to the
 * extension storage API. window.postMessage crosses into the main world
 * through the shared window object — the SPA receives it normally.
 *
 * Cross-browser: Firefox exposes `browser.storage` (Promise-based),
 * Chrome exposes `chrome.storage` (callback-based). We handle both.
 */
function deliverPendingReplay(storageKey: string): void {
  const TAG = '[MSR Analyzer]'
  const originalTitle = document.title

  // Resolve storage API — Firefox: browser.storage, Chrome: chrome.storage
  const storageAPI = (() => {
    const g = globalThis as any
    if (g.browser?.storage?.local) return g.browser.storage.local
    if (g.chrome?.storage?.local) return g.chrome.storage.local
    return null
  })()

  if (!storageAPI) {
    console.warn(TAG, 'No extension storage API available')
    return
  }

  // Normalize to Promise (Firefox returns Promises, Chrome uses callbacks)
  function storageGet(key: string): Promise<Record<string, any>> {
    const result = storageAPI.get(key)
    if (result && typeof result.then === 'function') return result
    return new Promise(resolve => storageAPI.get(key, resolve))
  }

  document.title = '[MSR] Loading replay\u2026'

  storageGet(storageKey).then((result: Record<string, any>) => {
    const pending = result[storageKey]
    if (!pending?.rawvf || !pending?.filename) {
      console.warn(TAG, 'No pending replay found in storage')
      document.title = originalTitle
      return
    }

    const { rawvf, filename } = pending as { rawvf: string; filename: string }
    const encoder = new TextEncoder()
    console.info(TAG, 'Delivering replay:', filename, '(' + rawvf.length + ' chars)')

    // Clear from storage immediately to prevent stale data
    storageAPI.remove(storageKey)

    function send(): void {
      window.postMessage({
        type: 'replay-analyzer-load',
        buffer: encoder.encode(rawvf).buffer,
        filename,
      }, '*')
    }

    let retryInterval: ReturnType<typeof setInterval> | null = null

    function cleanup(): void {
      window.removeEventListener('message', onMessage)
      if (retryInterval != null) clearInterval(retryInterval)
    }

    function onMessage(event: MessageEvent): void {
      if (event.data?.type === 'replay-analyzer-received') {
        console.info(TAG, 'Analyzer confirmed receipt')
        document.title = originalTitle
        cleanup()
      } else if (event.data?.type === 'replay-analyzer-ready') {
        console.info(TAG, 'Analyzer ready, sending replay')
        send()
      }
    }

    window.addEventListener('message', onMessage)

    // Retry every 500ms for up to 30s until the SPA acknowledges receipt.
    // The tab is in the foreground (just created) so timers are not throttled.
    send()
    let retryCount = 0
    const MAX_RETRIES = 60
    retryInterval = setInterval(() => {
      retryCount++
      if (retryCount >= MAX_RETRIES) {
        console.warn(TAG, 'Gave up after', MAX_RETRIES, 'retries')
        document.title = originalTitle
        cleanup()
        return
      }
      send()
    }, 500)
  }).catch((err: unknown) => {
    console.error(TAG, 'Failed to read from storage:', err)
    document.title = originalTitle
  })
}

/**
 * Injected into an EXISTING analyzer tab via scripting.executeScript (main world).
 * SPA is already initialized, so a single postMessage suffices.
 */
function sendReplayDirect(rawvf: string, filename: string): void {
  const TAG = '[MSR Analyzer]'
  const encoder = new TextEncoder()

  console.info(TAG, 'Sending replay:', filename, '(' + rawvf.length + ' chars)')

  window.postMessage({
    type: 'replay-analyzer-load',
    buffer: encoder.encode(rawvf).buffer,
    filename,
  }, '*')
}

// --------------------------------------------------------------------------
// WebSocket capture initialization
// --------------------------------------------------------------------------
// Register CDP event listeners at the top level of the service worker so
// they persist across MV3 service worker restarts. Safe on all browsers —
// no-ops if chrome.debugger is unavailable.

initWebSocketCapture()

// --------------------------------------------------------------------------
// Auto-analyze: send new games to analyzer when preference is enabled
// --------------------------------------------------------------------------
// Lives in the background service worker because the popup is ephemeral and
// will be closed when games are saved.

browser.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.replayMeta) return
  const oldMeta = (changes.replayMeta.oldValue ?? []) as Array<{ id: string }>
  const newMeta = (changes.replayMeta.newValue ?? []) as Array<{ id: string; filename: string }>
  if (newMeta.length <= oldMeta.length) return

  // Find newly added game IDs
  const oldIds = new Set(oldMeta.map(g => g.id))
  const newGames = newMeta.filter(g => !oldIds.has(g.id))
  if (newGames.length === 0) return

  // Check if always-analyze preference is enabled
  browser.storage.local.get('alwaysAnalyze').then(prefs => {
    if (prefs.alwaysAnalyze !== true) return

    for (const game of newGames) {
      const contentKey = `replay_${game.id}`
      browser.storage.local.get(contentKey).then(data => {
        const rawvf = data[contentKey] as string | undefined
        if (!rawvf) return
        minfo('Auto-sending to analyzer:', game.filename)
        handleSendToAnalyzer(rawvf, game.filename, ANALYZER_URL, false)
      })
    }
  })
})
