import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

describe('CLI module import does not run the CLI', () => {
    for (const format of ['mjs', 'cjs']) it(`imports ${format} without version output or startup`, () => {
        const home = mkdtempSync(join(tmpdir(), 'lmc-import-fixture-'));
        try {
            // --version makes the old bug observable without auth or session registration.
            const target = pathToFileURL(resolve(`dist/index.${format}`)).href;
            const output = execFileSync(process.execPath, ['--input-type=module', '-e',
                `process.argv = [process.execPath, '/fixture/diagnostic.mjs', '--version']; await import(${JSON.stringify(target)}); console.log('import-only');`],
                { encoding: 'utf8', timeout: 15000, env: { PATH: process.env.PATH, HOME: home, USERPROFILE: home, LMC_HOME_DIR: home, HAPPY_HOME_DIR: home } });
            expect(output.trim()).toBe('import-only');
        } finally { rmSync(home, { recursive: true, force: true }); }
    });

    for (const [script, flags] of [
        ['dist/index.mjs', []],
        ['bin/happy.mjs', []],
        ['bin/happy.mjs', ['--no-warnings', '--no-deprecation']],
    ] as const) it(`still executes ${script} with flags ${flags.join(' ')}`, () => {
        const home = mkdtempSync(join(tmpdir(), 'lmc-cli-fixture-'));
        try {
            const output = execFileSync(process.execPath, [...flags, resolve(script), '--version', '--version'],
                { encoding: 'utf8', timeout: 15000, env: { PATH: process.env.PATH, HOME: home, USERPROFILE: home, LMC_HOME_DIR: home, HAPPY_HOME_DIR: home } });
            expect(output.trim()).toMatch(/^happy version: /);
        } finally { rmSync(home, { recursive: true, force: true }); }
    });
});
