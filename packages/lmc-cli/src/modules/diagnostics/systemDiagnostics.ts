import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import type { FullDiskAccessDiagnostic, SystemPromptDiagnostic, ToolProcessObservation } from 'lmc-wire';

export type ProbeResult = { status: 'completed'; stdout: string } | { status: 'timeout' | 'failed' };
export type ProbeCommand = { executable: string; args: string[]; timeoutMs: number };
export type ProbePort = (command: ProbeCommand) => Promise<ProbeResult>;
const TIMEOUT_MS = 2000;

/** Deadline resolves even if the OS never delivers the child's exit event.
 * Only these newly spawned probes are killed, never an engine or tool. */
export const runDiagnosticProbe: ProbePort = command => new Promise(resolve => {
    let child: ReturnType<typeof spawn>;
    try {
        child = spawn(command.executable, command.args, {
            cwd: '/', env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' },
            stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true,
        });
    } catch { resolve({ status: 'failed' }); return; }
    let done = false;
    let stdout = '';
    const finish = (result: ProbeResult, kill = false) => {
        if (done) return;
        done = true; clearTimeout(timer);
        if (kill) { try { child.kill('SIGKILL'); } catch {} }
        child.stdout?.destroy();
        child.unref();
        resolve(result);
    };
    const timer = setTimeout(() => finish({ status: 'timeout' }, true), command.timeoutMs);
    child.stdout?.on('data', data => {
        stdout += data.toString();
        if (stdout.length > 512_000) finish({ status: 'failed' }, true);
    });
    child.on('error', () => finish({ status: 'failed' }));
    child.on('close', code => finish(code === 0 ? { status: 'completed', stdout } : { status: 'failed' }));
});

// CGWindow metadata does not require Screen Recording or Accessibility.
// Never request either permission, inspect window names, or send Apple events.
export const SYSTEM_WINDOW_SCRIPT = `
ObjC.import('Foundation');
ObjC.import('CoreGraphics');
// CFArrayRef is a pointer in JXA. Bind its toll-free NSArray return as id.
ObjC.bindFunction('CGWindowListCopyWindowInfo', ['id', ['unsigned int', 'unsigned int']]);
const windows = ObjC.deepUnwrap($.CGWindowListCopyWindowInfo(1 | 16, 0));
if (!Array.isArray(windows)) throw Error('Window list unavailable');
const owners = ['UserNotificationCenter', 'SecurityAgent', 'CoreServicesUIAgent'];
JSON.stringify(windows.filter(w => owners.includes(w.kCGWindowOwnerName) &&
    w.kCGWindowIsOnscreen && w.kCGWindowBounds &&
    w.kCGWindowBounds.Width > 0 && w.kCGWindowBounds.Height > 0)
    .map(w => ({ owner: w.kCGWindowOwnerName })));`;

type Options = { platform?: NodeJS.Platform; run?: ProbePort; now?: () => number; timeoutMs?: number };
export async function detectSystemPrompt(options: Options = {}): Promise<SystemPromptDiagnostic> {
    const checkedAt = (options.now ?? Date.now)();
    if ((options.platform ?? process.platform) !== 'darwin') return { status: 'unsupported', checkedAt };
    try {
        const result = await (options.run ?? runDiagnosticProbe)({ executable: '/usr/bin/osascript', args: ['-l', 'JavaScript', '-e', SYSTEM_WINDOW_SCRIPT], timeoutMs: options.timeoutMs ?? TIMEOUT_MS });
        if (result.status !== 'completed') return { status: 'unknown', checkedAt, reason: result.status };
        const rows: unknown = JSON.parse(result.stdout);
        const allowed = ['UserNotificationCenter', 'SecurityAgent', 'CoreServicesUIAgent'] as const;
        if (!Array.isArray(rows) || rows.some(row => !row || !allowed.includes(row.owner))) return { status: 'unknown', checkedAt, reason: 'malformed' };
        const owners = allowed.filter(owner => rows.some(row => row.owner === owner));
        return { status: rows.length ? 'detected' : 'none', owners, windowCount: rows.length, checkedAt };
    } catch { return { status: 'unknown', checkedAt, reason: 'failed' }; }
}

// SystemPolicyAllFiles has no automatic consent prompt. Open/close only;
// do not read or query this database, or probe per-folder consent paths.
export const FULL_DISK_ACCESS_SCRIPT = `
const fs = require('node:fs');
try {
    const fd = fs.openSync(process.argv[1], fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    fs.closeSync(fd);
    process.stdout.write(JSON.stringify({ status: 'readable' }));
} catch (e) {
    process.stdout.write(JSON.stringify(e.code === 'EPERM' ? { status: 'denied', reason: 'EPERM' } : { status: 'unknown', reason: 'unavailable' }));
}`;
export async function checkFullDiskAccess(options: Options & { home?: string } = {}): Promise<FullDiskAccessDiagnostic> {
    const checkedAt = (options.now ?? Date.now)();
    const base = { checkedAt, method: 'tcc-file-open' as const };
    if ((options.platform ?? process.platform) !== 'darwin') return { ...base, status: 'unsupported' };
    try {
        const result = await (options.run ?? runDiagnosticProbe)({ executable: process.execPath,
            args: ['-e', FULL_DISK_ACCESS_SCRIPT, `${options.home ?? homedir()}/Library/Application Support/com.apple.TCC/TCC.db`], timeoutMs: options.timeoutMs ?? TIMEOUT_MS });
        if (result.status !== 'completed') return { ...base, status: 'unknown', reason: result.status };
        const value = JSON.parse(result.stdout);
        if (value.status === 'readable') return { ...base, status: 'readable' };
        if (value.status === 'denied' && value.reason === 'EPERM') return { ...base, status: 'denied', reason: 'EPERM' };
        if (value.status === 'unknown' && value.reason === 'unavailable') return { ...base, status: 'unknown', reason: 'unavailable' };
        return { ...base, status: 'unknown', reason: 'malformed' };
    } catch { return { ...base, status: 'unknown', reason: 'failed' }; }
}

export async function observeToolProcesses(pid: number | undefined, options: Options = {}): Promise<ToolProcessObservation> {
    const checkedAt = (options.now ?? Date.now)();
    if (!pid || !Number.isSafeInteger(pid) || (options.platform ?? process.platform) === 'win32') return { status: 'unknown', checkedAt };
    try {
        const result = await (options.run ?? runDiagnosticProbe)({ executable: '/bin/ps', args: ['-axo', 'pid=,ppid=,stat='], timeoutMs: options.timeoutMs ?? TIMEOUT_MS });
        if (result.status !== 'completed') return { status: 'unknown', checkedAt };
        const rows = result.stdout.trim().split('\n').map(line => /^(\d+)\s+(\d+)\s+(\S+)\s*$/.exec(line.trim()));
        if (rows.some(row => !row) || !rows.some(row => Number(row![1]) === pid)) return { status: 'unknown', checkedAt };
        const descendants = new Set([pid]);
        for (let changed = true; changed;) {
            changed = false;
            for (const row of rows) if (descendants.has(Number(row![2])) && !descendants.has(Number(row![1]))) { descendants.add(Number(row![1])); changed = true; }
        }
        const liveCount = rows.filter(row => Number(row![1]) !== pid && descendants.has(Number(row![1])) && !row![3].includes('Z')).length;
        return { status: liveCount ? 'alive' : 'none', liveCount, checkedAt };
    } catch { return { status: 'unknown', checkedAt }; }
}

export function systemPromptHint(diagnostic: SystemPromptDiagnostic, host?: string): string {
    if (diagnostic.status === 'detected') return `检测到系统授权或安全弹窗待处理，请到${host ? ` ${host} 这台` : '运行引擎的那台'} Mac 的屏幕上查看并处理。`;
    if (diagnostic.status === 'none') return '未检测到屏上的系统授权或安全弹窗。';
    if (diagnostic.status === 'unsupported') return '此系统不支持 macOS 弹窗诊断。';
    return '系统弹窗状态未知，诊断未能完成。';
}
