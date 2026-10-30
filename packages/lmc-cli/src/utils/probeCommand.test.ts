import { expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { probeCommand } from './probeCommand';

it('captures stderr and nonzero exits for auth status without treating failure as ready', async () => {
    expect(await probeCommand(process.execPath, ['-e', 'process.stderr.write("Not logged in");process.exit(1)'])).toEqual({ code: 1, stdout: '', stderr: 'Not logged in' });
});
it('bounds missing, hung and excessive-output probes', async () => {
    expect((await probeCommand('lmc-missing-probe-executable', [])).code).toBeNull();
    expect((await probeCommand(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { timeout: 100 })).code).toBeNull();
    expect((await probeCommand(process.execPath, ['-e', 'process.stdout.write("x".repeat(10000))'], { maxBuffer: 16 })).code).toBeNull();
});
it.skipIf(process.platform !== 'win32')('resolves a bare npm-style .cmd shim in a directory with spaces', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lmc probe '));
    try {
        writeFileSync(join(dir, 'lmc-probe.cmd'), '@echo off\r\necho Logged in using ChatGPT 1>&2\r\n');
        const env = { ...process.env };
        const key = Object.keys(env).find(k => k.toLowerCase() === 'path') ?? 'Path';
        env[key] = dir + ';' + env[key];
        const result = await probeCommand('lmc-probe', ['login', 'status'], { env });
        expect(result.code).toBe(0);
        expect(result.stderr).toContain('Logged in using ChatGPT');
    } finally { rmSync(dir, { recursive: true, force: true }); }
});
