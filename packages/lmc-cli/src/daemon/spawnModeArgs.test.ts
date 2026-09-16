import { describe, expect, it } from 'vitest';
import { appendDaemonSpawnModeArgs, shouldForwardDaemonPermissionMode } from './spawnModeArgs';

describe('daemon spawn mode arguments', () => {
  it('forwards Codex default because it is a concrete ask-first policy', () => {
    const args: string[] = [];

    appendDaemonSpawnModeArgs(args, { directory: '/repo', permissionMode: 'default' }, 'codex');

    expect(args).toEqual(['--permission-mode', 'default']);
  });

  it('leaves Claude default ambient', () => {
    const args: string[] = [];

    appendDaemonSpawnModeArgs(args, { directory: '/repo', permissionMode: 'default' }, 'claude');

    expect(args).toEqual([]);
  });

  it('forwards explicit Codex permission, model, and effort selections', () => {
    const args: string[] = [];

    appendDaemonSpawnModeArgs(args, {
      directory: '/repo',
      permissionMode: 'yolo',
      modelMode: 'gpt-5.6-sol',
      effortLevel: 'medium',
    }, 'codex');

    expect(args).toEqual([
      '--permission-mode', 'yolo',
      '--model', 'gpt-5.6-sol',
      '--effort', 'medium',
    ]);
  });

  it('uses the same Codex default rule for resume launches', () => {
    expect(shouldForwardDaemonPermissionMode('codex', 'default')).toBe(true);
    expect(shouldForwardDaemonPermissionMode('claude', 'default')).toBe(false);
  });
  it('rejects invalid Astra settings before appending any launch arguments', () => {
    const args = ['codex'];
    expect(() => appendDaemonSpawnModeArgs(args, { directory: '/repo', permissionMode: 'yolo', modelMode: 'gpt-6-astra', effortLevel: 'none' }, 'codex')).toThrow(/reasoning effort/);
    expect(args).toEqual(['codex']);
  });
  it.each(['low', 'medium', 'high', 'xhigh', 'max', 'ultra'])('forwards Astra %s verbatim', (effort) => {
    const args: string[] = [];
    appendDaemonSpawnModeArgs(args, { directory: '/repo', permissionMode: 'auto', modelMode: 'gpt-6-astra', effortLevel: effort }, 'codex');
    expect(args).toEqual(['--permission-mode', 'auto', '--model', 'gpt-6-astra', '--effort', effort]);
  });

});
it('forwards context limits and refuses invalid pairs atomically', () => {
  const args: string[] = [];
  appendDaemonSpawnModeArgs(args, { directory: '/repo', codexContextLimits: { contextWindow: 1000000, autoCompactTokenLimit: 800000 } }, 'codex');
  expect(args).toEqual(['--context-window', '1000000', '--auto-compact-token-limit', '800000']);
  const invalid = ['codex'];
  expect(() => appendDaemonSpawnModeArgs(invalid, { directory: '/repo', permissionMode: 'yolo', codexContextLimits: { contextWindow: 100, autoCompactTokenLimit: 101 } }, 'codex')).toThrow();
  expect(invalid).toEqual(['codex']);
});

 it('forwards standard and fast, rejects invalid speed before changing launch args', () => {
  for (const tier of ['fast', 'default'] as const) {
    const args: string[] = [];
    appendDaemonSpawnModeArgs(args, { directory: '/repo', codexServiceTier: tier }, 'codex');
    expect(args).toEqual(['--service-tier', tier]);
  }
  const args: string[] = ['codex'];
  expect(() => appendDaemonSpawnModeArgs(args, { directory: '/repo', permissionMode: 'yolo', codexServiceTier: '2x' as any }, 'codex')).toThrow();
  expect(args).toEqual(['codex']);
 });
