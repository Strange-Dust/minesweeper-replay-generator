/**
 * Re-export the webextension-polyfill browser API.
 *
 * Import this module instead of using `chrome.*` directly — it provides
 * a unified, promise-based `browser.*` API that works across Chrome,
 * Firefox, and Safari.
 */
import browser from 'webextension-polyfill'
export default browser
