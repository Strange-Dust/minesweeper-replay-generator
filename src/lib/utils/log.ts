/**
 * Shared logging helpers for the Minesweeper Replay Generator library.
 *
 * All console output goes through these functions so consumers can
 * configure the prefix and level (or silence entirely) in one place.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent'

const LEVEL_RANK: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
  silent: 4,
}

let currentLevel: LogLevel = 'debug'
let currentPrefix = '[MSR'

/**
 * Set the minimum log level. Messages below this level are silently dropped.
 * Default: `'debug'` (everything is logged).
 *
 * - `'debug'`: print everything
 * - `'info'`: drop `mlog` (debug)
 * - `'warn'`: drop `mlog`, `minfo`
 * - `'error'`: only `merr`
 * - `'silent'`: drop everything
 */
export function setLogLevel(level: LogLevel): void {
  currentLevel = level
}

/** Set the bracket-prefix that appears at the start of every log line. */
export function setLogPrefix(prefix: string): void {
  currentPrefix = prefix
}

function shouldLog(level: LogLevel): boolean {
  return LEVEL_RANK[level] >= LEVEL_RANK[currentLevel]
}

function timestamp(): string {
  return new Date().toISOString()
}

export const mlog = (...args: unknown[]) => {
  if (shouldLog('debug')) console.debug(`${currentPrefix} ${timestamp()}]`, ...args)
}

export const minfo = (...args: unknown[]) => {
  if (shouldLog('info')) console.info(`${currentPrefix} ${timestamp()}]`, ...args)
}

export const mwarn = (...args: unknown[]) => {
  if (shouldLog('warn')) console.warn(`${currentPrefix} ${timestamp()}]`, ...args)
}

export const merr = (...args: unknown[]) => {
  if (shouldLog('error')) console.error(`${currentPrefix} ${timestamp()}]`, ...args)
}
