/**
 * Shared formatting utilities.
 */

/**
 * Format a date as "YYYYMMDD_HHMMSS" for use in filenames.
 *
 * @param timestamp Optional ISO 8601 string. If omitted, uses the current time.
 * @returns Formatted date string, or "unknown" if the timestamp is invalid.
 */
export function formatDateForFilename(timestamp?: string): string {
  try {
    const date = timestamp ? new Date(timestamp) : new Date()
    return date.toISOString()
      .replace(/[-:T]/g, '')
      .replace(/\.\d+Z$/, '')
      .replace(/(\d{8})(\d{6})/, '$1_$2')
  } catch {
    return 'unknown'
  }
}
