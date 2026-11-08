import { spawnSync } from 'node:child_process';
import { findAgyBin } from './constants';

/** Local, non-authenticating checks only. Never launches an agent or queries quota. */
export function inspectAgyCli() {
  const binary = findAgyBin();
  const missing = { installed: false, binary: binary ?? null, version: null as string | null, readyForSignIn: false, supportsAcp: false, authentication: 'not_checked' as const };
  if (!binary) return { ...missing, reason: 'Install the official Antigravity CLI, or correct LMC_AGY_PATH.' };
  try {
    const run = (flag: string) => {
      const result = spawnSync(binary, [flag], { encoding: 'utf8', timeout: 15_000, maxBuffer: 256 * 1024, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      if (result.error || result.status !== 0) throw new Error('CLI inspection failed');
      // Go's successful --help is written to stderr, while --version uses stdout.
      return (result.stdout ?? '') + (result.stderr ?? '');
    };
    const version = run('--version').trim();
    const help = run('--help');
    const requiredFlags = ['--output-format', '--conversation', '--mode', '--print'];
    const missingFlags = requiredFlags.filter(flag => !help.includes(flag));
    const supportsAcp = /\bacp\b/.test(help);
    return { installed: true, binary, version, readyForSignIn: missingFlags.length === 0 && help.includes('stream-json'), supportsAcp, missingFlags, authentication: 'not_checked' as const };
  } catch {
    return { ...missing, installed: true, reason: 'The CLI could not be inspected. Run agy --version and agy --help locally; no login or model request was started.' };
  }
}
