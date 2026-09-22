import { spawn } from 'node:child_process';
import { isEngineLoginUrl, type EngineLoginContext, type LoginEngine } from 'lmc-wire';
import { claudeExecutable, codexExecutable } from '@/runtime/managedRuntime';
import { engineLoginEnvironment } from '@/utils/engineLoginContext';

export type LoginChild = { submit(code: string): boolean; cancel(): void };
export type LoginEvents = { ready(url: string, userCode?: string): void; exit(success: boolean): void };

export function parseLoginOutput(engine: LoginEngine, raw: string): { url: string; userCode?: string } | undefined {
    const text = raw.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\r/g, '');
    // Only accept complete, whitespace-terminated URLs, including chunked stdout.
    const urls = [...text.matchAll(/https:\/\/[^\s<>"']+(?=\s)/g)].map(m => m[0]);
    const url = urls.find(value => isEngineLoginUrl(engine, value));
    if (!url) return;
    if (engine === 'claude') return { url };
    const userCode = text.match(/\b[A-Z0-9]{4}-[A-Z0-9]{4,5}\b/)?.[0];
    return userCode ? { url, userCode } : undefined;
}

/** Native CLI owns OAuth and writes credentials. Raw output is never logged. */
export function startNativeEngineLogin(context: EngineLoginContext, events: LoginEvents): LoginChild {
    const child = spawn(context.engine === 'claude' ? claudeExecutable() : codexExecutable(), context.engine === 'claude' ? ['auth', 'login', '--claudeai'] : ['login', '--device-auth'], {
        cwd: context.cwd, env: engineLoginEnvironment(context), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    });
    let output = '';
    let stopped = false;
    let published = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (success: boolean) => {
        if (killTimer) clearTimeout(killTimer);
        output = '';
        if (stopped) return;
        stopped = true;
        events.exit(success);
    };
    const receive = (data: Buffer) => {
        if (stopped || published) return;
        output = (output + data.toString()).slice(-32768);
        const parsed = parseLoginOutput(context.engine, output);
        if (parsed) { published = true; output = ''; events.ready(parsed.url, parsed.userCode); }
    };
    child.stdout.on('data', receive);
    child.stderr.on('data', receive);
    child.stdin.on('error', () => finish(false));
    child.on('error', () => finish(false));
    child.on('close', code => finish(code === 0));
    return {
        submit(code) {
            if (stopped || context.engine !== 'claude' || !child.stdin.writable) return false;
            child.stdin.write(`${code}\n`);
            return true;
        },
        cancel() {
            output = '';
            if (stopped) return;
            stopped = true;
            child.kill('SIGTERM');
            // This PID belongs only to our login child, never to a session runner.
            killTimer = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }, 2000);
            killTimer.unref();
        },
    };
}
