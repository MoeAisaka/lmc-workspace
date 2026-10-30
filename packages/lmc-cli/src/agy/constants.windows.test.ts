import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { findAgyBin } from './constants';

vi.mock('node:child_process', () => ({ execSync: vi.fn() }));
vi.mock('node:fs', () => ({ existsSync: vi.fn() }));

describe('Antigravity executable discovery', () => {
  beforeEach(() => {
    vi.stubEnv('HAPPY_AGY_PATH', ''); vi.stubEnv('LMC_AGY_PATH', '');
    vi.mocked(execSync).mockImplementation(() => { throw new Error('not on PATH'); });
    vi.mocked(existsSync).mockReset();
  });
  afterEach(() => vi.unstubAllEnvs());

  it('finds the official Windows user install even in an old daemon environment', () => {
    const binary = 'C:\\Users\\Test\\AppData\\Local\\agy\\bin\\agy.exe';
    vi.mocked(existsSync).mockImplementation(p => p === binary);
    expect(findAgyBin({ platform: 'win32', home: 'C:\\Users\\Test', localAppData: 'C:\\Users\\Test\\AppData\\Local' })).toBe(binary);
  });

  it('does not silently pick another executable when an explicit override is wrong', () => {
    vi.stubEnv('LMC_AGY_PATH', '/explicit/missing/agy');
    vi.mocked(execSync).mockReturnValue(Buffer.from('/some/other/agy\n'));
    vi.mocked(existsSync).mockImplementation(p => p === '/some/other/agy');
    expect(findAgyBin()).toBeUndefined();
  });
});
