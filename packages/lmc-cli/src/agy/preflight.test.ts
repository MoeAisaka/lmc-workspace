import { describe, expect, it, vi } from 'vitest';
import { inspectAgyCli } from './preflight';

vi.mock('./constants', () => ({ findAgyBin: () => '/installed/agy' }));
vi.mock('node:child_process', () => ({
  execFileSync: vi.fn((_bin, args) => args[0] === '--version' ? '1.4.2\n' : ''),
  spawnSync: vi.fn((_bin, args) => ({ status: 0, stdout: args[0] === '--version' ? '1.4.2\n' : '', stderr: args[0] === '--help' ? '--output-format stream-json --conversation --mode --print\n' : '' })),
}));

describe('Antigravity local preflight', () => {
  it('recognizes the real CLI behavior of printing successful help to stderr', () => {
    expect(inspectAgyCli()).toMatchObject({ installed: true, version: '1.4.2', readyForSignIn: true, authentication: 'not_checked' });
  });
});
