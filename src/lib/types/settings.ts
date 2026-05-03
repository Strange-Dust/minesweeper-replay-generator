/**
 * Site-specific game settings that affect replay recording.
 *
 * These are read from the minesweeper site's settings page when available,
 * or can be manually configured by the user in the extension popup.
 */

// ============================================================================
// Chording mode
// ============================================================================

/**
 * How chording (opening multiple cells at once) is triggered.
 *
 * - 'superclick': Left-clicking an opened number performs a chord (SuperClick)
 * - 'both': Left+right clicking together on a number performs a chord
 * - 'disabled': Chording is turned off entirely
 */
export type ChordingMode = 'superclick' | 'both' | 'disabled'

// ============================================================================
// Keyboard-as-mouse
// ============================================================================

/**
 * Configuration for using keyboard keys as mouse buttons.
 * When enabled, pressing the configured keys acts as left/right mouse buttons.
 */
export interface KeyboardMouseConfig {
  /** Whether keyboard-as-mouse is enabled */
  enabled: boolean
  /** Key code for left click (e.g. 32 = Space, 65 = A) */
  leftKeyCode: number
  /** Key code for right click (e.g. 32 = Space, 68 = D) */
  rightKeyCode: number
}

// ============================================================================
// Combined settings
// ============================================================================

/**
 * All game settings relevant to replay recording.
 */
export interface GameSettings {
  /** How chording is triggered */
  chording: ChordingMode
  /** Keyboard-as-mouse configuration */
  keyboardMouse: KeyboardMouseConfig
}

/**
 * Stored settings with metadata about source and manual override.
 *
 * Auto-detected and manual settings are stored independently so that:
 *   - Auto-detection always saves, even when manual override is active
 *   - Disabling manual override correctly reverts to the last auto-detected values
 *   - The popup can show both the active and auto-detected values
 */
export interface StoredSettings {
  /** Auto-detected settings from the site's settings page (always updated) */
  autoDetectedSettings: GameSettings | null
  /** Manually configured settings from the popup (set when user enables override) */
  manualSettings: GameSettings | null
  /** Whether the user has chosen to manually override auto-detected settings */
  manualOverride: boolean
  /** ISO timestamp of when settings were last updated */
  lastUpdated: string
}

/**
 * Default settings (conservative defaults before detection).
 */
export const DEFAULT_SETTINGS: GameSettings = {
  chording: 'both',
  keyboardMouse: {
    enabled: false,
    leftKeyCode: 32,   // Space
    rightKeyCode: 32,   // Space
  },
}
