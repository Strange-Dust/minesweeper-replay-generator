/**
 * Socket.io / Engine.io frame parser.
 *
 * Parses text WebSocket frames from minesweeper.online's socket.io transport
 * to extract game replay data from 203 responses.
 *
 * This module is shared between:
 *   - Background service worker (for chrome.debugger auto-capture)
 *   - Content script (for manual paste conversion)
 *
 * Protocol layers:
 *   Engine.io: packet type prefix (1 char)
 *     0=open, 1=close, 2=ping, 3=pong, 4=message, 5=upgrade, 6=noop
 *   Socket.io: packet type prefix (1 char, within engine.io messages)
 *     0=CONNECT, 1=DISCONNECT, 2=EVENT, 3=ACK, 4=CONNECT_ERROR,
 *     5=BINARY_EVENT, 6=BINARY_ACK
 *
 * An EVENT message has the combined prefix "42" followed by JSON:
 *   42["eventName", arg1, arg2, ...]
 *
 * We look for:
 *   42["response", [<requestId>, 203, <replayData>]]
 */

/** Socket.io over engine.io text frame prefix for EVENT messages. */
const SOCKETIO_EVENT_PREFIX = '42'

/** The socket.io event name that carries server responses. */
const TARGET_EVENT_NAME = 'response'

/** The response code that indicates replay/game data. */
const REPLAY_RESPONSE_CODE = 203

/**
 * Parse a socket.io/engine.io WebSocket text frame and extract replay
 * data if present.
 *
 * @param payload The raw text frame content (e.g. `42["response",[null,203,[...]]]`)
 * @returns The extracted replay data, or null if this frame doesn't match.
 */
export function parseSocketIoReplayFrame(payload: string): unknown | null {
  // Quick rejection: must start with "42" (engine.io MESSAGE + socket.io EVENT)
  if (!payload.startsWith(SOCKETIO_EVENT_PREFIX)) return null

  // Extract the JSON part (everything after the "42" prefix)
  const jsonStr = payload.slice(SOCKETIO_EVENT_PREFIX.length)

  let parsed: unknown
  try {
    parsed = JSON.parse(jsonStr)
  } catch {
    return null
  }

  // Expected structure: ["response", [requestId, 203, data]]
  if (!Array.isArray(parsed)) return null
  if (parsed[0] !== TARGET_EVENT_NAME) return null

  const responseArgs = parsed[1]
  if (!Array.isArray(responseArgs)) return null
  if (responseArgs[1] !== REPLAY_RESPONSE_CODE) return null

  const replayData = responseArgs[2]
  if (replayData == null) return null

  return replayData
}

/**
 * Try to extract replay data from a raw string that may be:
 *   1. A socket.io frame: `42["response",[null,203,[...]]]`
 *   2. The response array without 42 prefix: `["response",[null,203,[...]]]`
 *   3. Just the inner JSON array: `[{gameMeta}, {boardData}, [...clicks], ...]`
 *
 * This is used for manual paste input where the user might copy any of these formats.
 *
 * @returns The replay data array, or null if parsing fails.
 */
export function parseWomReplayPaste(rawText: string): unknown | null {
  const trimmed = rawText.trim()

  // Try socket.io frame format first (with 42 prefix)
  const fromFrame = parseSocketIoReplayFrame(trimmed)
  if (fromFrame !== null) return fromFrame

  // Try parsing as plain JSON
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return null
  }

  if (!Array.isArray(parsed)) return null

  // Format 2: ["response", [requestId, 203, data]] — response array without 42 prefix
  if (parsed[0] === TARGET_EVENT_NAME) {
    const responseArgs = parsed[1]
    if (Array.isArray(responseArgs) && responseArgs[1] === REPLAY_RESPONSE_CODE) {
      const replayData = responseArgs[2]
      if (replayData != null) return replayData
    }
  }

  // Format 3: raw replay data array [{gameMeta}, {boardData}, [...clicks], ...]
  if (parsed.length >= 3 && parsed[0] && typeof parsed[0] === 'object' && !Array.isArray(parsed[0])) {
    return parsed
  }

  return null
}
