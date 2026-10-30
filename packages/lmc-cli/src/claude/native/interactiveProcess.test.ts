import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { readFile, access } from 'node:fs/promises';
import { dirname } from 'node:path';

const fixture = vi.hoisted(() => ({
    args: [] as string[],
    failSpawn: false,
    failAddon: false,
    exit: undefined as undefined | ((result: { exitCode: number }) => Promise<void>),
}));
vi.mock('node:module', () => ({
    createRequire: () => (name: string) => {
        if (name === '@lydell/node-pty') {
            if (fixture.failAddon) throw new Error('Missing ConPTY binary');
            return { spawn: (_executable: string, args: string[]) => {
                fixture.args = args;
                if (fixture.failSpawn) throw new Error('Native startup failed');
                return { pid: 1234, write() {}, pause() {}, resume() {}, onData() {},
                    onExit(callback: typeof fixture.exit) { fixture.exit = callback; } };
            } };
        }
        if (name === '@xterm/headless') return { Terminal: class { dispose() {} } };
        throw new Error('Unexpected dependency');
    },
}));

import { nativeTransportAvailable, startNativeInteractiveProcess } from './interactiveProcess';

const sessionId = 'cc7a3049-18dc-40a5-b86b-f64525025075';
type HookCommand = { command: string; args: string[]; onFailure?: string };
async function invoke(hook: HookCommand, payload: object) {
    return new Promise<any>((resolve, reject) => {
        const child = execFile(hook.command, hook.args, { timeout: 10_000 }, (error, stdout) => {
            if (error) reject(error); else { try { resolve(JSON.parse(stdout)); } catch (error) { reject(error); } }
        });
        child.stdin!.end(JSON.stringify(payload));
    });
}

describe('native terminal hooks', () => {
    beforeEach(() => { fixture.args = []; fixture.failSpawn = false; fixture.failAddon = false; fixture.exit = undefined; });
    afterEach(async () => { if (fixture.exit) { await fixture.exit({ exitCode: 0 }); fixture.exit = undefined; } });

    it('uses executable arguments and round-trips native hooks without a shell', async () => {
        const onHook = vi.fn(async () => ({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny' } }));
        const process = await startNativeInteractiveProcess({ executable: 'claude', cwd: '.', sessionId, resume: true, onHook });
        const settingsPath = fixture.args[fixture.args.indexOf('--settings') + 1];
        const settings = JSON.parse(await readFile(settingsPath, 'utf8'));
        const hook: HookCommand = settings.hooks.PreToolUse[0].hooks[0];
        const result = await invoke(hook, { hook_event_name: 'PreToolUse', session_id: sessionId,
            tool_name: 'PowerShell', tool_input: { command: "echo 中文 ' $ ` ( )" }, tool_use_id: 'tool-1' });
        expect(result.hookSpecificOutput.permissionDecision).toBe('deny');
        expect(onHook).toHaveBeenCalledWith(expect.objectContaining({ event: 'PreToolUse', sessionId,
            toolName: 'PowerShell', toolInput: { command: "echo 中文 ' $ ` ( )" } }), expect.any(AbortSignal));
        expect(hook.onFailure).toBe('block');
        expect(fixture.args.slice(0, 2)).toEqual(['--resume', sessionId]);
        await fixture.exit!({ exitCode: 0 }); fixture.exit = undefined;
        await expect(process.exit).resolves.toEqual({ exitCode: 0 });
        await expect(access(dirname(settingsPath))).rejects.toThrow();
    });

    it('denies a wrong-session hook or handler error instead of allowing a tool', async () => {
        const onHook = vi.fn(async () => { throw new Error('Approval unavailable'); });
        await startNativeInteractiveProcess({ executable: 'claude', cwd: '.', sessionId, resume: false, onHook });
        const settingsPath = fixture.args[fixture.args.indexOf('--settings') + 1];
        const settings = JSON.parse(await readFile(settingsPath, 'utf8'));
        const hook = settings.hooks.PermissionRequest[0].hooks[0];
        const wrong = await invoke(hook, { hook_event_name: 'PermissionRequest', session_id: 'another-session' });
        expect(wrong.hookSpecificOutput.decision.behavior).toBe('deny');
        expect(onHook).not.toHaveBeenCalled();
        const failed = await invoke(hook, { hook_event_name: 'PermissionRequest', session_id: sessionId });
        expect(failed.hookSpecificOutput.decision.behavior).toBe('deny');
    });

    it('cleans temporary hooks when native spawn fails and checks actual addon loading', async () => {
        fixture.failSpawn = true;
        await expect(startNativeInteractiveProcess({ executable: 'claude', cwd: '.', sessionId, resume: false, onHook() {} })).rejects.toThrow('Native startup failed');
        const settingsPath = fixture.args[fixture.args.indexOf('--settings') + 1];
        await expect(access(dirname(settingsPath))).rejects.toThrow();
        fixture.failAddon = true;
        expect(nativeTransportAvailable()).toBe(false);
    });
});
