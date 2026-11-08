import { describe, expect, it } from 'vitest';

import { buildAgyAcpArgs, buildAgyArgs, mapPermissionModeToAgyAcpMode } from './cliArgs';

describe('buildAgyArgs', () => {
  it('lets the native CLI choose its available default instead of sending a model named default', () => {
    expect(buildAgyArgs({ prompt: 'p', permissionMode: 'default', model: 'default' })).not.toContain('--model');
  });

  it('preserves reviewed edit and plan modes instead of bypassing all permissions', () => {
    for (const [mode, native] of [['acceptEdits', 'accept-edits'], ['safe-yolo', 'accept-edits'], ['plan', 'plan'], ['read-only', 'plan'], ['auto', 'auto']] as const) {
      const args = buildAgyArgs({ prompt: 'p', permissionMode: mode });
      expect(args).not.toContain('--dangerously-skip-permissions');
      expect(args).toContain('--sandbox');
      expect(args[args.indexOf('--mode') + 1]).toBe(native);
    }
  });
  it('uses --sandbox for non-skip permission modes and puts the prompt last', () => {
    const args = buildAgyArgs({ prompt: 'hello world', permissionMode: 'default' });

    expect(args).toContain('--sandbox');
    expect(args).not.toContain('--dangerously-skip-permissions');
    expect(args.slice(-2)).toEqual(['--print', 'hello world']);
  });

  it('uses --dangerously-skip-permissions for yolo-style modes', () => {
    for (const mode of ['yolo', 'bypassPermissions'] as const) {
      const args = buildAgyArgs({ prompt: 'p', permissionMode: mode });
      expect(args).toContain('--dangerously-skip-permissions');
      expect(args).not.toContain('--sandbox');
    }
  });

  it('passes the model via --model', () => {
    const args = buildAgyArgs({ prompt: 'p', permissionMode: 'default', model: 'Gemini 3.1 Pro (High)' });
    const idx = args.indexOf('--model');
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe('Gemini 3.1 Pro (High)');
  });

  it('resumes a conversation via --conversation when an id is given', () => {
    const args = buildAgyArgs({ prompt: 'p', permissionMode: 'default', conversationId: 'cid-123' });
    const idx = args.indexOf('--conversation');
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe('cid-123');
  });

  it('omits --conversation for a fresh conversation', () => {
    expect(buildAgyArgs({ prompt: 'p', permissionMode: 'default' })).not.toContain('--conversation');
    expect(buildAgyArgs({ prompt: 'p', permissionMode: 'default', conversationId: null })).not.toContain('--conversation');
  });

  it('adds a repeatable --add-dir for each directory', () => {
    const args = buildAgyArgs({ prompt: 'p', permissionMode: 'default', addDirs: ['/a', '/b'] });
    expect(args.filter((a) => a === '--add-dir')).toHaveLength(2);
    expect(args).toContain('/a');
    expect(args).toContain('/b');
  });

  it('passes --print-timeout when provided', () => {
    const args = buildAgyArgs({ prompt: 'p', permissionMode: 'default', printTimeout: '10m' });
    const idx = args.indexOf('--print-timeout');
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe('10m');
  });

  it('builds agy acp --stdio argv and maps ACP modes safely for 1.5.3', () => {
    expect(buildAgyAcpArgs({ permissionMode: 'default', addDirs: ['/work'] })).toEqual([
      'acp',
      '--stdio',
      '--sandbox',
      '--add-dir',
      '/work',
    ]);
    expect(buildAgyAcpArgs({ permissionMode: 'bypassPermissions', addDirs: ['/work'] })).toEqual([
      'acp',
      '--stdio',
      '--dangerously-skip-permissions',
      '--add-dir',
      '/work',
    ]);
    expect(mapPermissionModeToAgyAcpMode('default')).toBe('default');
    expect(mapPermissionModeToAgyAcpMode('acceptEdits')).toBe('accept-edits');
    expect(mapPermissionModeToAgyAcpMode('safe-yolo')).toBe('accept-edits');
    expect(mapPermissionModeToAgyAcpMode('auto', ['default', 'accept-edits', 'plan'])).toBe('accept-edits');
    expect(mapPermissionModeToAgyAcpMode('auto', ['default', 'accept-edits', 'plan', 'auto'])).toBe('auto');
    expect(mapPermissionModeToAgyAcpMode('plan')).toBe('plan');
    expect(mapPermissionModeToAgyAcpMode('read-only')).toBe('plan');
  });
});
