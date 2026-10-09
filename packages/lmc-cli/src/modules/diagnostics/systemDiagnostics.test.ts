import { describe, expect, it, vi } from 'vitest';
import { checkFullDiskAccess, detectSystemPrompt, observeToolProcesses, runDiagnosticProbe, SYSTEM_WINDOW_SCRIPT, systemPromptHint, type ProbePort } from './systemDiagnostics';

const completed = (stdout: string): ProbePort => vi.fn(async () => ({ status: 'completed' as const, stdout }));
describe('non-interactive system diagnostics', () => {
    it('finds only sanitized onscreen system owners, and uses a bounded child', async () => {
        const run = completed('[{"owner":"UserNotificationCenter"},{"owner":"SecurityAgent"}]');
        expect(await detectSystemPrompt({ platform: 'darwin', run, now: () => 1 })).toEqual({ status: 'detected', owners: ['UserNotificationCenter', 'SecurityAgent'], windowCount: 2, checkedAt: 1 });
        expect(run).toHaveBeenCalledWith({ executable: '/usr/bin/osascript', args: ['-l', 'JavaScript', '-e', SYSTEM_WINDOW_SCRIPT], timeoutMs: 2000 });
        expect(SYSTEM_WINDOW_SCRIPT).not.toMatch(/kCGWindowName|requestAccess|System Events|Desktop|Downloads|Documents/);
    });
    it('separates no windows, timeout, malformed and unsupported', async () => {
        expect(await detectSystemPrompt({ platform: 'darwin', run: completed('[]') })).toMatchObject({ status: 'none', windowCount: 0 });
        expect(await detectSystemPrompt({ platform: 'darwin', run: async () => ({ status: 'timeout' }) })).toMatchObject({ status: 'unknown', reason: 'timeout' });
        for (const value of ['{}', 'oops', '[{"owner":"Terminal","title":"private"}]']) expect(await detectSystemPrompt({ platform: 'darwin', run: completed(value) })).toMatchObject({ status: 'unknown' });
        const run = completed('[]');
        expect(await detectSystemPrompt({ platform: 'linux', run })).toMatchObject({ status: 'unsupported' });
        expect(run).not.toHaveBeenCalled();
        expect(await detectSystemPrompt({ platform: 'darwin', run: async () => { throw Error('probe failed'); } })).toMatchObject({ status: 'unknown' });
    });
    it('opens/closes the FDA sentinel without reading the database or consent folders', async () => {
        const run = completed('{"status":"readable"}');
        expect(await checkFullDiskAccess({ platform: 'darwin', home: '/fixture', run })).toMatchObject({ status: 'readable', method: 'tcc-file-open' });
        const command = vi.mocked(run).mock.calls[0][0];
        expect(command.timeoutMs).toBe(2000);
        expect(command.args[2]).toBe('/fixture/Library/Application Support/com.apple.TCC/TCC.db');
        expect(command.args[1]).not.toMatch(/readFile|readdir|sqlite|Desktop|Downloads|Documents/);
        expect(await checkFullDiskAccess({ platform: 'darwin', run: completed('{"status":"denied","reason":"EPERM"}') })).toMatchObject({ status: 'denied', reason: 'EPERM' });
        expect(await checkFullDiskAccess({ platform: 'darwin', run: completed('{"status":"unknown","reason":"unavailable"}') })).toMatchObject({ status: 'unknown', reason: 'unavailable' });
        expect(await checkFullDiskAccess({ platform: 'darwin', run: async () => ({ status: 'timeout' }) })).toMatchObject({ status: 'unknown', reason: 'timeout' });
        expect(await checkFullDiskAccess({ platform: 'darwin', run: completed('broken') })).toMatchObject({ status: 'unknown' });
        expect(await checkFullDiskAccess({ platform: 'linux', run })).toMatchObject({ status: 'unsupported' });
    });
    it('counts only live descendants of the requested engine and excludes zombies', async () => {
        const run = completed('1 0 Ss\n10 1 S\n11 10 S\n12 11 R\n13 10 Z\n20 1 R\n');
        expect(await observeToolProcesses(10, { run, now: () => 2 })).toEqual({ status: 'alive', liveCount: 2, checkedAt: 2 });
        expect(vi.mocked(run).mock.calls[0][0].args).toEqual(['-axo', 'pid=,ppid=,stat=']);
        expect(await observeToolProcesses(10, { run: completed('10 1 S\n11 10 Z') })).toMatchObject({ status: 'none', liveCount: 0 });
        expect(await observeToolProcesses(10, { run: completed('1 0 S') })).toMatchObject({ status: 'unknown' });
        expect(await observeToolProcesses(10, { run: async () => ({ status: 'timeout' }) })).toMatchObject({ status: 'unknown' });
    });
    it('returns at the deadline even for a hung child, and safely handles spawn failure', async () => {
        expect(await runDiagnosticProbe({ executable: process.execPath, args: ['-e', 'setTimeout(() => {}, 60000)'], timeoutMs: 30 })).toEqual({ status: 'timeout' });
        expect(await runDiagnosticProbe({ executable: '/lmc-fixture-no-such-command', args: [], timeoutMs: 1000 })).toEqual({ status: 'failed' });
    });
    it('tells the person which Mac to visit without claiming causation', () => {
        const hint = systemPromptHint({ status: 'detected', checkedAt: 1 }, 'lab-mac');
        expect(hint).toContain('lab-mac'); expect(hint).toContain('屏幕上');
        expect(hint).not.toContain('导致');
    });
});
