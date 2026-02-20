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

export interface GetRecordingDataMessage {
  type: 'GET_RECORDING_DATA'
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
}

// ============================================================================
// Union types
// ============================================================================

/** Messages sent from popup to content script */
export type PopupToContentMessage =
  | StartRecordingMessage
  | StopRecordingMessage
  | GetStatusMessage
  | GetRecordingDataMessage

/** Messages sent from content script to background */
export type ContentToBackgroundMessage =
  | RecordingStartedMessage
  | RecordingStoppedMessage
  | RecordingStateChangedMessage

/** All extension messages */
export type ExtensionMessage = PopupToContentMessage | ContentToBackgroundMessage
