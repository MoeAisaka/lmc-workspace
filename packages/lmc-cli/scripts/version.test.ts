import { it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

it('version probes do not import a session runtime even with inherited reconnect state', () => {
  const root = mkdtempSync(join(tmpdir(), 'happy-version-'));
  try {
    mkdirSync(join(root, 'bin')); mkdirSync(join(root, 'dist'));
    copyFileSync('bin/happy.mjs', join(root, 'bin/happy.mjs'));
    writeFileSync(join(root, 'package.json'), JSON.stringify({ version: '1.2.3-test' }));
    writeFileSync(join(root, 'dist/index.mjs'), "import fs from 'node:fs'; fs.writeFileSync(new URL('../runtime-started', import.meta.url), 'bad');");
    for (const flag of ['--version', '-v']) {
      const output = execFileSync(process.execPath, [join(root, 'bin/happy.mjs'), flag], {
        env: { PATH: process.env.PATH, HAPPY_HOME_DIR: join(root, 'state'), HAPPY_RECONNECT_SESSION_ID: 'synthetic-session' }, encoding: 'utf8', timeout: 5000,
      });
      expect(output.trim()).toBe('happy version: 1.2.3-test');
      expect(existsSync(join(root, 'runtime-started'))).toBe(false);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
