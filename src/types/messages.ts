/**
 * Message types for communication between extension components.
 *
 * Content script ←→ Background service worker ←→ Popup
 */

import type { RecordingState, RecordingData } from './rawvf'

// ============================================================================
// Content script → Background messages
// ============================================================================

export interface RecordingStartedMessage {
  type: 'RECORDING_STARTED'
  /** URL of the page being recorded */
  url: string
}

export interface RecordingStoppedMessage {
  type: 'RECORDING_STOPPED'
  /** The complete recording data */
  data: RecordingData
}

export interface RecordingStateChangedMessage {
  type: 'RECORDING_STATE_CHANGED'
  state: RecordingState
}

// ============================================================================
// Popup → Content script messages
// ============================================================================

export interface StartRecordingMessage {
  type: 'START_RECORDING'
}

export interface StopRecordingMessage {
  type: 'STOP_RECORDING'
}

export interface GetStatusMessage {
  type: 'GET_STATUS'
}

// ============================================================================
// Popup → Background: WebSocket capture control
// ============================================================================

export interface StartWsCaptureMessage {
  type: 'START_WS_CAPTURE'
}

export interface StopWsCaptureMessage {
  type: 'STOP_WS_CAPTURE'
}

export interface GetWsCaptureStatusMessage {
  type: 'GET_WS_CAPTURE_STATUS'
}

export interface WsCaptureStatusResponse {
  supported: boolean
  active: boolean
}

// ============================================================================
// Background → Content script: captured WebSocket data
// ============================================================================

export interface WsReplayDataMessage {
  type: 'WS_REPLAY_DATA'
  /** The raw replay data extracted from the 203 WebSocket response. */
  data: unknown
}

// ============================================================================
// Popup → Content script: manual paste of WS replay data
// ============================================================================

export interface ParseWsReplayMessage {
  type: 'PARSE_WS_REPLAY'
  /** Raw string pasted by the user (e.g. `42["response",[...]]`) */
  rawText: string
}

export interface ParseWsReplayResponse {
  success: boolean
  error?: string
  /** Game ID from the parsed replay, if successful */
  gameId?: number
}

// ============================================================================
// Background → Popup response messages
// ============================================================================

export interface StatusResponse {
  state: RecordingState
  /** Number of completed games in the current session */
  gameCount: number
  /** Number of events recorded in the current game */
  eventCount: number
  /** Elapsed time in ms for the current game */
  elapsedMs?: number
  /** Player name auto-detected from the site (e.g. logged-in username) */
  detectedPlayerName?: string
}

// ============================================================================
// Union types
// ============================================================================

/** Messages sent from popup to content script */
export type PopupToContentMessage =
  | StartRecordingMessage
  | StopRecordingMessage
  | GetStatusMessage
  | ParseWsReplayMessage

/** Messages sent from popup to background */
export type PopupToBackgroundMessage =
  | StartWsCaptureMessage
  | StopWsCaptureMessage
  | GetWsCaptureStatusMessage

/** Messages sent from content script to background */
export type ContentToBackgroundMessage =
  | RecordingStartedMessage
  | RecordingStoppedMessage
  | RecordingStateChangedMessage

/** Messages sent from background to content script */
export type BackgroundToContentMessage =
  | WsReplayDataMessage

/** All extension messages */
export type ExtensionMessage =
  | PopupToContentMessage
  | PopupToBackgroundMessage
  | ContentToBackgroundMessage
  | BackgroundToContentMessage
