/**
 * Agy CLI argument builder
 *
 * Pure function that turns a turn's parameters into the argv for `agy --print`.
 * Kept separate from the backend so it can be unit-tested in isolation.
 */

import type { PermissionMode } from '@/api/types';

/**
 * Only explicit bypass intent skips permissions. Reviewed edits and planning
 * use the native execution modes, with the terminal sandbox still enabled.
 */
const SKIP_PERMISSION_MODES: ReadonlySet<PermissionMode> = new Set<PermissionMode>([
  'yolo',
  'bypassPermissions',
]);

export interface BuildAgyArgsOptions {
  /** The user prompt for this turn. */
  prompt: string;
  /** Model display name passed to `--model` (e.g. "Gemini 3.1 Pro (High)"). */
  model?: string;
  /** Conversation id to resume via `--conversation`; omit/null for a fresh conversation. */
  conversationId?: string | null;
  /** LMC permission mode for this turn. */
  permissionMode: PermissionMode;
  /** Directories to expose to agy via repeatable `--add-dir`. */
  addDirs?: string[];
  /** Value for `--print-timeout` (e.g. "10m"). */
  printTimeout?: string;
}

/**
 * Build the argv for a single `agy --print` invocation. The prompt is placed
 * last (as the value of `--print`) so all preceding flags parse cleanly.
 */
export function buildAgyArgs(opts: BuildAgyArgsOptions): string[] {
  const args: string[] = ['--output-format', 'stream-json'];

  if (opts.conversationId) {
    args.push('--conversation', opts.conversationId);
  }
  if (opts.model && opts.model !== 'default') {
    args.push('--model', opts.model);
  }
  if (SKIP_PERMISSION_MODES.has(opts.permissionMode)) {
    args.push('--dangerously-skip-permissions');
  } else {
    args.push('--sandbox');
    const mode = opts.permissionMode;
    if (mode === 'acceptEdits' || mode === 'safe-yolo') args.push('--mode', 'accept-edits');
    else if (mode === 'plan' || mode === 'read-only') args.push('--mode', 'plan');
    else if (mode === 'auto') args.push('--mode', 'auto');
  }
  for (const dir of opts.addDirs ?? []) {
    args.push('--add-dir', dir);
  }
  if (opts.printTimeout) {
    args.push('--print-timeout', opts.printTimeout);
  }

  args.push('--print', opts.prompt);
  return args;
}
