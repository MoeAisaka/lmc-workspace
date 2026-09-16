/**
 * Console logging bootstrap for React Native
 *
 * Control flow:
 *
 * console.log("msg", obj)
 * │
 * ├─ consoleOutputEnabled = false? (default for prod)
 * │  └─ return immediately ⛔  (zero cost, args untouched)
 * │
 * ├─ consoleOutputEnabled = true? (default for dev/preview, or toggled on)
 * │  ├─ call original console method ✅
 * │  ├─ capture to in-app buffer ✅
 * │  └─ send to remote log server (if configured) ✅
 * │
 * └─ console.error / console.warn (always, regardless of flag)
 *    ├─ call original console method ✅
 *    ├─ capture to in-app buffer ✅
 *    └─ send to remote log server (if configured) ✅
 */

import { log } from '@/log';
import { getLogServerUrl } from '@/sync/serverConfig';
import { loadLocalSettings } from '@/sync/persistence';
import { loadAppConfig } from '@/sync/appConfig';
import { Platform } from 'react-native';
import { serializeForLogs } from '@/utils/truncateForLogs';

let isConsolePatched = false
let remoteLogServerUrl: string | null = null
let consoleOutputEnabled = false
let originalConsole: {
  log: typeof console.log,
  info: typeof console.info,
  warn: typeof console.warn,
  error: typeof console.error,
  debug: typeof console.debug,
} | null = null

/**
 * Toggle console output at runtime (e.g. from Dev screen toggle).
 */
export function setConsoleOutputEnabled(enabled: boolean) {
  consoleOutputEnabled = enabled
}

export function initConsoleLogging() {
  if (isConsolePatched) {
    return
  }

  remoteLogServerUrl = getLogServerUrl();

  // Determine initial state: user setting > build variant default > off
  try {
    const settings = loadLocalSettings();
    const config = loadAppConfig();
    consoleOutputEnabled = settings.consoleLoggingEnabled || config.consoleLoggingDefault || false;
  } catch {
    consoleOutputEnabled = false;
  }

  originalConsole = {
    log: console.log,
    info: console.info,
    warn: console.warn,
    error: console.error,
    debug: console.debug,
  }

  log.setConsoleCaptureEnabled(true)

  function formatArgs(args: any[]): string {
    return args.map(a => {
      if (a === null || a === undefined) return String(a)
      if (typeof a !== 'object') return serializeForLogs(a)
      try { return serializeForLogs(a) } catch { return String(a) }
    }).join(' ')
  }

  function sendLog(level: string, formatted: string) {
    if (!remoteLogServerUrl) {
      return
    }

    void fetch(remoteLogServerUrl + '/logs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        timestamp: new Date().toISOString(),
        level,
        message: formatted,
        source: 'mobile',
        platform: Platform.OS,
      })
    }).catch(() => {})
  }

  // Patch console methods
  ;(['log', 'info', 'warn', 'error', 'debug'] as const).forEach(level => {
    const alwaysPassThrough = level === 'error' || level === 'warn'

    console[level] = (...args: any[]) => {
      // Full short-circuit: when off, skip everything for log/info/debug
      if (!consoleOutputEnabled && !alwaysPassThrough) {
        return
      }

      // Pass raw args to native console (preserves interactive object inspection,
      // clickable stack traces, and multi-arg formatting in dev tools)
      originalConsole![level](...args)

      // Serialize once for buffer + remote (but NOT for native console)
      // One ring buffer only. A second copy of every line used to be kept here
      // for a dev-settings reader that no longer exists, doubling what the tab
      // holds for logs; `log` already keeps the last MAX_APP_LOG_ENTRIES.
      const formatted = formatArgs(args)
      log.captureFormatted(level, formatted)

      sendLog(level, formatted)
    }
  })

  isConsolePatched = true

  originalConsole.log('[ConsoleLogging] Initialized', consoleOutputEnabled ? '(output enabled)' : '(output suppressed)')
}
