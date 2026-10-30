/**
 * Agy (Antigravity CLI) Constants
 *
 * Centralized constants for the agy integration: the binary name, the available
 * native-default selection and print timeout. LMC uses the official CLI's
 * account authentication and structured headless output, not an API proxy.
 */

import os from 'node:os';
import { join, win32, isAbsolute } from 'node:path';
import { existsSync } from 'node:fs';
import { execSync } from 'node:child_process';

/** Default command name for the agy binary (looked up on PATH). */
export const AGY_BIN = 'agy';

/**
 * Find the installed agy executable.
 *
 * agy installs to `~/.local/bin`, which is frequently absent from a daemon's
 * PATH (launchd, or `lmc daemon start` from a non-login shell), so spawning
 * the bare name fails with ENOENT even though agy is installed. Resolution order:
 * Explicit LMC_AGY_PATH/HAPPY_AGY_PATH wins and fails closed when invalid.
 * Otherwise resolve an executable on PATH, then the official per-user directory
 * (~/.local/bin on POSIX; LocalAppData/agy/bin on Windows).
 *
 */
export function findAgyBin(context: { platform?: NodeJS.Platform; home?: string; localAppData?: string } = {}): string | undefined {
  const platform = context.platform ?? process.platform;
  const home = context.home ?? os.homedir();
  const override = process.env.LMC_AGY_PATH || process.env.HAPPY_AGY_PATH;
  if (override) return (platform === 'win32' ? win32.isAbsolute(override) : isAbsolute(override)) && existsSync(override) ? override : undefined;

  // Already on PATH? Then the bare name is enough (and respects PATH ordering).
  try {
    const probe = platform === 'win32'
      ? `where ${AGY_BIN}`
      : `command -v ${AGY_BIN}`;
    const output = execSync(probe, { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, encoding: 'utf8' }).toString();
    const binary = output.split(/\r?\n/).map(p => p.trim()).find(p =>
      (platform === 'win32' ? win32.isAbsolute(p) && /\.exe$/i.test(p) : isAbsolute(p)) && existsSync(p));
    if (binary) return binary;
  } catch {
    // not on PATH — fall through to the known install location
  }

  const candidates = platform === 'win32'
    ? [win32.join(context.localAppData ?? process.env.LOCALAPPDATA ?? win32.join(home, 'AppData', 'Local'), 'agy', 'bin', 'agy.exe'), win32.join(home, '.local', 'bin', 'agy.exe')]
    : [join(home, '.local', 'bin', AGY_BIN)];
  return candidates.find(p => existsSync(p));
}

/**
 * Resolve the agy executable to a spawnable command.
 *
 * Falls back to the bare command name when nothing matches, so the caller still
 * spawns and surfaces a clear ENOENT instead of silently doing nothing.
 */
export function resolveAgyBin(): string {
  if ((process.env.LMC_AGY_PATH || process.env.HAPPY_AGY_PATH) && !findAgyBin()) throw new Error('The configured Antigravity executable path is missing or not absolute. Correct LMC_AGY_PATH/HAPPY_AGY_PATH; no other executable was selected.');
  return findAgyBin() ?? AGY_BIN;
}

/**
 * Safe fallback before a signed-in model catalog is available. Do not guess
 * account-specific model IDs from a public product page.
 */
export const AGY_MODELS = ['default'] as const;

/**
 * Omitted at the CLI boundary so the user's native Antigravity choice is used.
 */
export const DEFAULT_AGY_MODEL = 'default';

/** Timeout passed to `agy --print-timeout` for a single print turn (0 = wait until turn completes). */
export const AGY_PRINT_TIMEOUT = '0';

/**
 * Path to agy's per-workspace conversation cache. agy records the most recent
 * conversation id for each cwd here; print mode does not echo the id, so this is
 * how we recover it for `--conversation`-based resume.
 */
export const AGY_CONVERSATIONS_CACHE = join(
  os.homedir(),
  '.gemini',
  'antigravity-cli',
  'cache',
  'last_conversations.json',
);
