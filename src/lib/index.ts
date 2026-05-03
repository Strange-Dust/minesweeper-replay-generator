/**
 * Public entry point for the Minesweeper Replay Generator library.
 *
 * This is a stand-alone, dependency-free TypeScript module for recording
 * minesweeper.online games and producing RAWVF replay files. It contains
 * no extension-specific code (no `browser.*`, no `chrome.*`, no
 * `webextension-polyfill`) — it can be dropped into any project that
 * runs in a browser context (extension content script, userscript,
 * Electron renderer, etc.).
 *
 * See README.md in this folder for usage examples.
 */

// --------------------------------------------------------------------------
// Recording (live game capture)
// --------------------------------------------------------------------------
export { GameRecorder } from './recording/recorder'
export type {
  RecorderConfig,
  StateChangeCallback,
} from './recording/recorder'

export { MouseTracker } from './recording/mouseTracker'
export type {
  MouseTrackerConfig,
  MouseEventCallback,
} from './recording/mouseTracker'

// --------------------------------------------------------------------------
// minesweeper.online site reader
// --------------------------------------------------------------------------
export { MinesweeperOnlineSite } from './site/minesweeperOnline'

// --------------------------------------------------------------------------
// RAWVF output
// --------------------------------------------------------------------------
export { generateRawvf, generateFilename } from './rawvf/writer'

// --------------------------------------------------------------------------
// WoM (minesweeper.online server) replay conversion
// --------------------------------------------------------------------------
export { convertWomReplay } from './rawvf/womConverter'
export type { WomConversionResult } from './rawvf/womConverter'

export {
  parseSocketIoReplayFrame,
  parseWomReplayPaste,
} from './utils/socketIoParser'

// --------------------------------------------------------------------------
// Utilities
// --------------------------------------------------------------------------
export { formatDateForFilename } from './utils/format'

export {
  setLogLevel,
  setLogPrefix,
  mlog,
  minfo,
  mwarn,
  merr,
} from './utils/log'
export type { LogLevel } from './utils/log'

// --------------------------------------------------------------------------
// Types
// --------------------------------------------------------------------------
export type {
  BoardConfig,
  BoardPosition,
  RecordedMouseEvent,
  MouseEventCode,
  GameResult,
  LevelName,
  GameMode,
  ReplayMetadata,
  RecordingState,
  RecordingData,
} from './types/rawvf'

export type {
  ChordingMode,
  KeyboardMouseConfig,
  GameSettings,
  StoredSettings,
} from './types/settings'

export { DEFAULT_SETTINGS } from './types/settings'
