/**
 * Settings storage — persists game settings to browser.storage.local.
 *
 * Settings can come from two sources:
 *   1. Auto-detected by parsing the site's settings page
 *   2. Manually configured by the user in the extension popup
 *
 * Manual overrides take priority over auto-detected settings.
 */

import browser from '../utils/browser'
import type { GameSettings, StoredSettings } from '../types/settings'
import { DEFAULT_SETTINGS } from '../types/settings'

export type { StoredSettings } from '../types/settings'

const SETTINGS_KEY = 'gameSettings'

/**
 * Load stored settings, or return defaults if none are saved.
 */
export async function loadSettings(): Promise<StoredSettings> {
  const data = await browser.storage.local.get(SETTINGS_KEY)
  const stored = data[SETTINGS_KEY] as StoredSettings | undefined

  if (stored?.settings) {
    return stored
  }

  return {
    settings: { ...DEFAULT_SETTINGS },
    autoDetected: false,
    manualOverride: false,
    lastUpdated: '',
  }
}

/**
 * Save auto-detected settings from the site's settings page.
 * Only updates if the user hasn't enabled manual override.
 */
export async function saveAutoDetectedSettings(settings: GameSettings): Promise<void> {
  const current = await loadSettings()

  // Don't overwrite manual overrides
  if (current.manualOverride) return

  const stored: StoredSettings = {
    settings,
    autoDetected: true,
    manualOverride: false,
    lastUpdated: new Date().toISOString(),
  }
  await browser.storage.local.set({ [SETTINGS_KEY]: stored })
}

/**
 * Save manually configured settings from the popup.
 */
export async function saveManualSettings(settings: GameSettings): Promise<void> {
  const stored: StoredSettings = {
    settings,
    autoDetected: false,
    manualOverride: true,
    lastUpdated: new Date().toISOString(),
  }
  await browser.storage.local.set({ [SETTINGS_KEY]: stored })
}

/**
 * Clear manual override — revert to auto-detected settings if available.
 * If no auto-detected settings exist, reverts to defaults.
 */
export async function clearManualOverride(): Promise<void> {
  const current = await loadSettings()
  const stored: StoredSettings = {
    settings: current.autoDetected ? current.settings : { ...DEFAULT_SETTINGS },
    autoDetected: current.autoDetected,
    manualOverride: false,
    lastUpdated: new Date().toISOString(),
  }
  await browser.storage.local.set({ [SETTINGS_KEY]: stored })
}

/**
 * Get just the effective GameSettings (convenience for callers
 * that don't need the metadata).
 */
export async function getEffectiveSettings(): Promise<GameSettings> {
  const stored = await loadSettings()
  return stored.settings
}
