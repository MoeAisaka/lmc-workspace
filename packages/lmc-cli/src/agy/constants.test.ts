import { execSync } from 'node:child_process';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { AGY_PRINT_TIMEOUT, findAgyBin, resolveAgyBin, resolveAgyPrintTimeout } from './constants';

vi.mock('node:child_process', () => ({ execSync: vi.fn() }));

const mockedExecSync = vi.mocked(execSync);

describe('resolveAgyBin', () => {
  const orig = process.env.HAPPY_AGY_PATH;

  beforeEach(() => {
    mockedExecSync.mockReset();
    mockedExecSync.mockReturnValue(Buffer.alloc(0));
  });

  afterEach(() => {
    if (orig === undefined) {
      delete process.env.HAPPY_AGY_PATH;
    } else {
      process.env.HAPPY_AGY_PATH = orig;
    }
  });

  it('uses HAPPY_AGY_PATH when it points at an existing file', () => {
    // node's own binary is guaranteed to exist on every platform
    process.env.HAPPY_AGY_PATH = process.execPath;
    expect(findAgyBin()).toBe(process.execPath);
    expect(resolveAgyBin()).toBe(process.execPath);
  });

  it('rejects an explicit path when the target does not exist', () => {
    process.env.HAPPY_AGY_PATH = '/nonexistent/path/to/agy-should-not-resolve';
    expect(findAgyBin()).toBeUndefined();
    expect(() => resolveAgyBin()).toThrow(/configured Antigravity executable/);
  });

  it('hides the PATH probe so detached Windows daemons do not flash a console', () => {
    delete process.env.HAPPY_AGY_PATH;

    findAgyBin();

    expect(mockedExecSync).toHaveBeenCalledWith(
      expect.stringMatching(/^(where|command -v) agy$/),
      { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, encoding: 'utf8' },
    );
  });

  it('uses an explicit multi-day --print-timeout (168h) instead of 0 to avoid agy 30m background-wait fallback', () => {
    expect(AGY_PRINT_TIMEOUT).toBe('168h');
    const origTimeout = process.env.LMC_AGY_PRINT_TIMEOUT;
    try {
      delete process.env.LMC_AGY_PRINT_TIMEOUT;
      expect(resolveAgyPrintTimeout()).toBe('168h');
      expect(resolveAgyPrintTimeout('48h')).toBe('48h');
      process.env.LMC_AGY_PRINT_TIMEOUT = '72h';
      expect(resolveAgyPrintTimeout()).toBe('72h');
      expect(resolveAgyPrintTimeout('10m')).toBe('10m');
    } finally {
      if (origTimeout === undefined) {
        delete process.env.LMC_AGY_PRINT_TIMEOUT;
      } else {
        process.env.LMC_AGY_PRINT_TIMEOUT = origTimeout;
      }
    }
  });
});
