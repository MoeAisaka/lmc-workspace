import { expect, it } from 'vitest';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkEngineAuth } from './engineAuth';

async function probeCatalog(code: number, stdout: string, stderr = '') {
    const directory = mkdtempSync(join(tmpdir(), 'agy-auth-probe-'));
    const script = join(directory, 'agy.cjs');
    const binary = process.platform === 'win32' ? join(directory, 'agy.cmd') : script;
    const previous = process.env.LMC_AGY_PATH;
    try {
        writeFileSync(script, `#!${process.execPath}\n
if (process.argv[2] === 'models') {
    process.stdout.write(${JSON.stringify(stdout)});
    process.stderr.write(${JSON.stringify(stderr)});
    process.exitCode = ${code};
} else {
    // Quota failure must not overrule a healthy authenticated model catalog.
    console.log(JSON.stringify({ status: 'ERROR', error: 'quota service unavailable' }));
    process.exitCode = 1;
}
`);
        if (process.platform === 'win32') {
            writeFileSync(binary, `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`);
        } else chmodSync(binary, 0o755);
        process.env.LMC_AGY_PATH = binary;
        return await checkEngineAuth('agy', directory);
    } finally {
        if (previous === undefined) delete process.env.LMC_AGY_PATH;
        else process.env.LMC_AGY_PATH = previous;
        rmSync(directory, { recursive: true, force: true });
    }
}

it('accepts authenticated native models even when the independent quota service is unavailable', async () => {
    expect(await probeCatalog(0, 'gemini-4-carbon-high\tGemini 4 Carbon (High)\n')).toBe('ready');
});

it('requires login only for the native signed-out response', async () => {
    expect(await probeCatalog(1, '', 'Error: Please sign in to view available models.\n')).toBe('required');
});

it('preserves the session when the model service cannot be reached', async () => {
    expect(await probeCatalog(1, '', 'Error: connection timed out\n')).toBe('unknown');
});

it('does not treat successful empty or unrecognized output as authenticated', async () => {
    expect(await probeCatalog(0, '')).toBe('unknown');
    expect(await probeCatalog(0, 'Fetching available models...\n')).toBe('unknown');
});

it('does not accept a failed command even if it printed a catalog first', async () => {
    expect(await probeCatalog(2, 'gemini-4-carbon-high\tGemini 4 Carbon (High)\n')).toBe('unknown');
});
