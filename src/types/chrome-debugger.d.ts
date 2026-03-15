/**
 * Type declarations for the Chrome Debugger API.
 *
 * Only the subset used by our WebSocket capture module is declared here.
 * We intentionally avoid depending on @types/chrome because it would
 * introduce types for ALL chrome.* APIs and potentially conflict with
 * the webextension-polyfill types used throughout the rest of the project.
 *
 * These types are Chrome-only. Firefox and Safari do not have this API.
 *
 * Note: "debugger" is a reserved keyword in JavaScript/TypeScript, so we
 * cannot use `namespace chrome.debugger` or `const debugger`. The actual
 * API is accessed via bracket notation `(chrome as any)['debugger']` in
 * the webSocketCapture module. These interfaces type the API shape only.
 */

interface ChromeDebuggerDebuggee {
  tabId?: number
  extensionId?: string
  targetId?: string
}

interface ChromeDebuggerEventListener<T extends (...args: any[]) => void> {
  addListener(callback: T): void
  removeListener(callback: T): void
}

type ChromeDebuggerOnEventCallback = (
  source: ChromeDebuggerDebuggee,
  method: string,
  params?: Record<string, unknown>,
) => void

type ChromeDebuggerOnDetachCallback = (
  source: ChromeDebuggerDebuggee,
  reason: string,
) => void

/**
 * Shape of the `chrome.debugger` API.
 * @see https://developer.chrome.com/docs/extensions/reference/api/debugger
 */
interface ChromeDebuggerAPI {
  attach(target: ChromeDebuggerDebuggee, requiredVersion: string): Promise<void>
  detach(target: ChromeDebuggerDebuggee): Promise<void>
  sendCommand(
    target: ChromeDebuggerDebuggee,
    method: string,
    commandParams?: Record<string, unknown>,
  ): Promise<unknown>
  onEvent: ChromeDebuggerEventListener<ChromeDebuggerOnEventCallback>
  onDetach: ChromeDebuggerEventListener<ChromeDebuggerOnDetachCallback>
}

// Declare `chrome` as a global. On Chrome this is the extension API namespace.
// On Firefox it may exist as an alias. We only need it to be indexable so that
// webSocketCapture.ts can do `(chrome as ...)['debugger']`.
// eslint-disable-next-line no-var
declare var chrome: Record<string, unknown> | undefined
