/**
 * Settings storage — persists game settings to browser.storage.local.
 *
 * Settings can come from two sources:
 *   1. Auto-detected by parsing the site's settings page
 *   2. Manually configured by the user in the extension popup
 *
 * Both are stored independently. Manual overrides take priority when active,
 * but auto-detected settings are always saved so they're available as a
 * fallback when the user disables the override.
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

  if (stored) {
    return stored
  }

  return {
    autoDetectedSettings: null,
    manualSettings: null,
    manualOverride: false,
    lastUpdated: '',
  }
}

/**
 * Save auto-detected settings from the site's settings page.
 * Always saves, even when manual override is active — the auto-detected
 * values are stored separately and used as a fallback when the user
 * disables the override.
 */
export async function saveAutoDetectedSettings(settings: GameSettings): Promise<void> {
  const current = await loadSettings()

  const stored: StoredSettings = {
    ...current,
    autoDetectedSettings: settings,
    lastUpdated: new Date().toISOString(),
  }
  await browser.storage.local.set({ [SETTINGS_KEY]: stored })
}

/**
 * Save manually configured settings from the popup.
 */
export async function saveManualSettings(settings: GameSettings): Promise<void> {
  const current = await loadSettings()

  const stored: StoredSettings = {
    ...current,
    manualSettings: settings,
    manualOverride: true,
    lastUpdated: new Date().toISOString(),
  }
  await browser.storage.local.set({ [SETTINGS_KEY]: stored })
}

/**
 * Clear manual override — revert to auto-detected settings if available.
 */
export async function clearManualOverride(): Promise<void> {
  const current = await loadSettings()
  const stored: StoredSettings = {
    ...current,
    manualOverride: false,
    lastUpdated: new Date().toISOString(),
  }
  await browser.storage.local.set({ [SETTINGS_KEY]: stored })
}

/**
 * Get the effective GameSettings — manual override if active,
 * otherwise auto-detected, otherwise defaults.
 */
export async function getEffectiveSettings(): Promise<GameSettings> {
  const stored = await loadSettings()
  if (stored.manualOverride && stored.manualSettings) {
    return stored.manualSettings
  }
  return stored.autoDetectedSettings ?? { ...DEFAULT_SETTINGS }
}
