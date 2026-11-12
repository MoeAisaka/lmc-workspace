import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('Yulor compatibility executable', () => {
  it('prints branded help and version without creating runtime state', () => {
    const home = mkdtempSync(join(tmpdir(), 'yulor-probe-'));
    try {
      const env = { ...process.env, LMC_HOME_DIR: home, LMC_SERVER_URL: 'http://127.0.0.1:1' };
      for (const flags of [[], ['--no-warnings', '--no-deprecation']]) {
        const run = (arg: string) => execFileSync(process.execPath, [...flags, 'bin/yulor.mjs', arg], { cwd: process.cwd(), env, encoding: 'utf8', timeout: 10000 });
        expect(run('--version')).toMatch(/^Yulor version: \d+\.\d+\.\d+/);
        const help = run('--help');
        expect(help).toContain('Formerly LMC / Link my Cli');
        expect(help).toContain('yulor codex');
        expect(help).toContain('yulor agy');
        expect(help).toContain('LMC_*');
      }
      expect(readdirSync(home)).toEqual([]);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});
