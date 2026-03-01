/**
 * Shared logging helpers for the Minesweeper Replay Generator.
 *
 * All console output from the extension uses these functions so that
 * timestamp formatting can be changed in one place.
 */

/** Format the current time as an ISO 8601 string with milliseconds. */
function timestamp(): string {
  return new Date().toISOString()
}

const PREFIX = '[MSR'

export const mlog = (...args: unknown[]) =>
  console.debug(`${PREFIX} ${timestamp()}]`, ...args)

export const mwarn = (...args: unknown[]) =>
  console.warn(`${PREFIX} ${timestamp()}]`, ...args)

export const merr = (...args: unknown[]) =>
  console.error(`${PREFIX} ${timestamp()}]`, ...args)
