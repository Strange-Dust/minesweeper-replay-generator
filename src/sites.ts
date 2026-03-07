/**
 * URL match patterns for all supported minesweeper sites.
 *
 * These patterns use the WebExtension match pattern syntax
 * (https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Match_patterns).
 *
 * Used by;
 *   - Background service worker — to find existing tabs on install/update
 *   - manifest.json — content_scripts.matches + host_permissions (manually kept in sync)
 *
 * When adding a new site adapter, add its URL pattern here AND in manifest.json.
 */
export const SUPPORTED_SITE_PATTERNS: string[] = [
  'https://minesweeper.online/*',
]
