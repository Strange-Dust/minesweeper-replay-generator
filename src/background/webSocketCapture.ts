/**
 * Passive WebSocket frame capture using the Chrome DevTools Protocol.
 *
 * Uses chrome.debugger to observe WebSocket traffic between the browser
 * and minesweeper.online game servers. This module is purely a read-only
 * observer — it does NOT modify, intercept, delay, or inject any data.
 *
 * Security & ethics:
 *   - No page modification: the debugger protocol reads network data at the
 *     browser level. No scripts are injected, no prototypes are modified,
 *     no DOM is touched.
 *   - Transparent to the user: Chrome displays a yellow "debugging" infobar
 *     whenever the debugger is attached, making the capture visible.
 *   - The web page's JavaScript cannot detect debugger attachment — there
 *     is no API for page scripts to query this.
 *   - Functionally equivalent to having the Chrome DevTools Network tab open.
 *
 * Browser support:
 *   - Chrome: Full support via chrome.debugger.
 *   - Firefox/Safari: Not supported (no equivalent API). This module
 *     gracefully no-ops — isWebSocketCaptureSupported() returns false.
 *
 * Service worker lifecycle (MV3):
 *   The chrome.debugger attachment persists even when the service worker
 *   is killed by Chrome. Event listeners registered at the top level
 *   survive restarts. However, in-memory session tracking (activeSessions)
 *   is lost on restart. The content script can re-request capture if needed.
 */

import { mlog, mwarn, merr } from '../utils/log'
import { parseSocketIoReplayFrame } from '../utils/socketIoParser'

// -------------------------------------------------------------------------
// Chrome debugger API access
// -------------------------------------------------------------------------

/**
 * Get a typed reference to the chrome.debugger API.
 *
 * "debugger" is a reserved keyword in JavaScript/TypeScript, so we access
 * it via bracket notation on the `chrome` global. This returns undefined
 * on browsers that don't have the API (Firefox, Safari) or when the
 * "debugger" permission isn't granted.
 */
function getChromeDebugger(): ChromeDebuggerAPI | undefined {
  try {
    if (typeof chrome === 'undefined') return undefined
    // Access via bracket notation because "debugger" is a reserved keyword
    const api = (chrome as Record<string, unknown>)['debugger']
    if (api && typeof (api as ChromeDebuggerAPI).attach === 'function') {
      return api as ChromeDebuggerAPI
    }
    return undefined
  } catch {
    return undefined
  }
}

// -------------------------------------------------------------------------
// Constants
// -------------------------------------------------------------------------

/**
 * URL pattern for minesweeper.online WebSocket game servers.
 * Matches main1, main2, main3, etc.
 */
const WS_URL_PATTERN = /^wss:\/\/main\d*\.minesweeper\.online/

/** Chrome DevTools Protocol version to request. */
const CDP_VERSION = '1.3'

// -------------------------------------------------------------------------
// Types
// -------------------------------------------------------------------------

/** Callback invoked when replay data is captured from a WebSocket frame. */
export type ReplayDataCallback = (tabId: number, data: unknown) => void

/** Internal state for a single tab's capture session. */
interface CaptureSession {
  tabId: number
  /** CDP requestIds for WebSocket connections matching our target URL. */
  trackedRequestIds: Set<string>
  /** Callback to invoke when replay data is extracted from a frame. */
  callback: ReplayDataCallback
}

// -------------------------------------------------------------------------
// State
// -------------------------------------------------------------------------

/** Active capture sessions, keyed by tabId. */
const activeSessions = new Map<number, CaptureSession>()

// -------------------------------------------------------------------------
// Public API
// -------------------------------------------------------------------------

/**
 * Check if the chrome.debugger API is available.
 * Returns false on Firefox, Safari, or if the debugger permission is missing.
 */
export function isWebSocketCaptureSupported(): boolean {
  return getChromeDebugger() !== undefined
}

/**
 * Start capturing WebSocket frames for a tab.
 *
 * Attaches the Chrome debugger to the specified tab and listens for
 * WebSocket frames from minesweeper.online game servers. Chrome will
 * show a yellow "debugging" infobar while attached.
 *
 * If the user dismisses the infobar (clicks ×), the capture stops
 * gracefully via the onDetach handler.
 *
 * @returns true if capture was started (or was already active), false on failure.
 */
export async function startCapture(
  tabId: number,
  callback: ReplayDataCallback,
): Promise<boolean> {
  if (!isWebSocketCaptureSupported()) {
    mwarn('WebSocket capture: not supported in this browser')
    return false
  }

  if (activeSessions.has(tabId)) {
    mlog('WebSocket capture: already active for tab', tabId)
    return true
  }

  try {
    const dbg = getChromeDebugger()!

    // Attach the Chrome DevTools Protocol debugger to the tab.
    // This shows the yellow "Extension is debugging this browser" infobar.
    await dbg.attach({ tabId }, CDP_VERSION)

    // Enable the Network domain to receive WebSocket events.
    // We only need WebSocket-related events; the Network domain provides:
    //   - Network.webSocketCreated (new connection opened)
    //   - Network.webSocketFrameReceived (incoming frame)
    //   - Network.webSocketClosed (connection closed)
    await dbg.sendCommand({ tabId }, 'Network.enable')

    const session: CaptureSession = {
      tabId,
      trackedRequestIds: new Set(),
      callback,
    }
    activeSessions.set(tabId, session)

    mlog('WebSocket capture: started for tab', tabId)
    return true
  } catch (err) {
    // Common failure reasons:
    //   - Another debugger is already attached (DevTools open on older Chrome)
    //   - Tab was closed between the request and execution
    //   - Permission not granted
    merr('WebSocket capture: failed to start for tab', tabId, err)
    return false
  }
}

/**
 * Stop capturing WebSocket frames for a tab.
 * Detaches the debugger, removing the yellow infobar.
 */
export async function stopCapture(tabId: number): Promise<void> {
  if (!activeSessions.has(tabId)) return

  activeSessions.delete(tabId)

  try {
    await getChromeDebugger()!.detach({ tabId })
    mlog('WebSocket capture: stopped for tab', tabId)
  } catch {
    // Already detached (user dismissed bar, tab closed, etc.) — that's fine.
  }
}

/**
 * Stop all active capture sessions.
 */
export async function stopAllCaptures(): Promise<void> {
  const tabIds = [...activeSessions.keys()]
  await Promise.all(tabIds.map((id) => stopCapture(id)))
}

/**
 * Check if capture is currently active for a tab.
 */
export function isCaptureActive(tabId: number): boolean {
  return activeSessions.has(tabId)
}

// -------------------------------------------------------------------------
// CDP event handling
// -------------------------------------------------------------------------

/**
 * Handle Chrome DevTools Protocol events from attached debugger sessions.
 *
 * We listen for three Network domain events:
 *   - webSocketCreated: track connection if URL matches our pattern
 *   - webSocketFrameReceived: parse frame data for replay responses
 *   - webSocketClosed: clean up tracking for closed connections
 */
function handleDebuggerEvent(
  source: ChromeDebuggerDebuggee,
  method: string,
  params?: Record<string, unknown>,
): void {
  const tabId = source.tabId
  if (tabId == null) return

  const session = activeSessions.get(tabId)
  if (!session) return

  switch (method) {
    case 'Network.webSocketCreated': {
      const url = params?.url as string | undefined
      const requestId = params?.requestId as string | undefined
      if (url && requestId && WS_URL_PATTERN.test(url)) {
        session.trackedRequestIds.add(requestId)
        mlog('WebSocket capture: tracking connection', url, '(requestId:', requestId + ')')
      }
      break
    }

    case 'Network.webSocketClosed': {
      const requestId = params?.requestId as string | undefined
      if (requestId) {
        session.trackedRequestIds.delete(requestId)
      }
      break
    }

    case 'Network.webSocketFrameReceived': {
      const requestId = params?.requestId as string | undefined
      if (!requestId || !session.trackedRequestIds.has(requestId)) break

      const response = params?.response as { payloadData?: string } | undefined
      const payloadData = response?.payloadData
      if (!payloadData) break

      const replayData = parseSocketIoReplayFrame(payloadData)
      if (replayData !== null) {
        mlog('WebSocket capture: replay data found in frame!')
        session.callback(tabId, replayData)
      }
      break
    }
  }
}

/**
 * Handle debugger detach events.
 *
 * The debugger can be detached by:
 *   - The user dismissing the yellow infobar
 *   - The tab being closed
 *   - Another extension or DevTools taking over the debug session
 *   - An internal Chrome error
 *
 * In all cases, we clean up our session tracking.
 */
function handleDebuggerDetach(
  source: ChromeDebuggerDebuggee,
  reason: string,
): void {
  const tabId = source.tabId
  if (tabId == null) return

  if (activeSessions.has(tabId)) {
    mlog('WebSocket capture: debugger detached for tab', tabId, '— reason:', reason)
    activeSessions.delete(tabId)
  }
}

// -------------------------------------------------------------------------
// Initialization
// -------------------------------------------------------------------------

/**
 * Register Chrome DevTools Protocol event listeners.
 *
 * Must be called once at the top level of the background service worker
 * so that the listeners persist across service worker restarts (MV3).
 *
 * Safe to call on any browser — no-ops if chrome.debugger is unavailable.
 */
export function initWebSocketCapture(): void {
  const dbg = getChromeDebugger()
  if (!dbg) {
    mlog('WebSocket capture: not available (chrome.debugger API not present)')
    return
  }

  dbg.onEvent.addListener(handleDebuggerEvent)
  dbg.onDetach.addListener(handleDebuggerDetach)
  mlog('WebSocket capture: CDP event listeners registered')
}
