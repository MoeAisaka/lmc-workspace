import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { NativeTerminalRelay, nativeComposerReady, type NativeScreen } from './terminalRelay';

const require = createRequire(import.meta.url);
export function nativeTransportAvailable(): boolean {
    if (process.platform !== 'darwin') return false;
    try { require.resolve('@lydell/node-pty'); require.resolve('@xterm/headless'); return true; } catch { return false; }
}

export type NativeHook = { event: string; sessionId: string; toolName?: string; toolInput?: unknown; toolUseId?: string; requestId?: string };
export async function startNativeInteractiveProcess(options: {
    executable: string; cwd: string; sessionId: string; resume: boolean;
    args?: string[]; env?: NodeJS.ProcessEnv;
    onHook: (hook: NativeHook, signal: AbortSignal) => void | object | Promise<void | object>; onScreen?: () => void;
}) {
    if (process.platform !== 'darwin') throw new Error('Native Claude requires macOS');
    const pty = require('@lydell/node-pty');
    const { Terminal } = require('@xterm/headless');
    const terminal = new Terminal({ cols: 100, rows: 40, scrollback: 200, allowProposedApi: true });
    let screen: NativeScreen = { lines: [], cursor: { x: 0, y: 0 }, composer: false };
    let writes = Promise.resolve();
    let exited = false;
    const directory = await mkdtemp(join(tmpdir(), 'lmc-native-'));
    const nonce = randomUUID();
    const server = createServer(async (req, res) => {
        if (req.method !== 'POST' || req.url !== `/${nonce}`) { res.writeHead(404).end(); return; }
        try {
            const chunks: Buffer[] = []; let size = 0;
            for await (const chunk of req) { size += chunk.length; if (size > 1048576) throw new Error('Hook too large'); chunks.push(chunk); }
            const data = JSON.parse(Buffer.concat(chunks).toString());
            if (data.sessionId !== options.sessionId || typeof data.event !== 'string') throw new Error('Wrong native session');
            const controller = new AbortController();
            res.once('close', () => controller.abort());
            const result = await options.onHook(data, controller.signal);
            res.end(JSON.stringify(result ?? {}));
        } catch { res.writeHead(400).end('{}'); }
    });
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const port = (server.address() as { port: number }).port;
    const hookScript = join(directory, 'hook.cjs');
    await writeFile(hookScript, `const http=require('node:http');const {randomUUID}=require('node:crypto');let text='';process.stdin.on('data',c=>text+=c);process.stdin.on('end',()=>{const d=JSON.parse(text);const guarded=['PreToolUse','PermissionRequest'].includes(d.hook_event_name);const deny=()=>JSON.stringify(guarded?{hookSpecificOutput:d.hook_event_name==='PreToolUse'?{hookEventName:d.hook_event_name,permissionDecision:'deny',permissionDecisionReason:'LMC approval connection failed; wait for a new instruction.'}:{hookEventName:d.hook_event_name,decision:{behavior:'deny',message:'LMC approval connection failed; wait for a new instruction.'}}}:{});let ended=false;const finish=x=>{if(!ended){ended=true;process.stdout.write(x)}};const r=http.request({host:'127.0.0.1',port:${port},path:'/${nonce}',method:'POST',timeout:guarded?590000:4000},s=>{let body='';s.on('data',c=>body+=c);s.on('end',()=>finish(s.statusCode===200?body:deny()))});r.on('error',()=>finish(deny()));r.on('timeout',()=>r.destroy());r.end(JSON.stringify({event:d.hook_event_name,sessionId:d.session_id,...(guarded?{toolName:d.tool_name,toolInput:d.tool_input,toolUseId:d.tool_use_id,requestId:randomUUID()}:{})}))});`, { mode: 0o600 });
    const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
    const hook = [{ hooks: [{ type: 'command', command: `${quote(process.execPath)} ${quote(hookScript)}`, timeout: 5 }] }];
    const settings = join(directory, 'settings.json');
    const permissionHook = [{ hooks: [{ type: 'command', command: `${quote(process.execPath)} ${quote(hookScript)}`, timeout: 600 }] }];
    await writeFile(settings, JSON.stringify({ hooks: {
        ...Object.fromEntries(['SessionStart', 'SessionEnd', 'UserPromptSubmit', 'Stop', 'StopFailure'].map(name => [name, hook])),
        PreToolUse: [{ ...permissionHook[0], matcher: '.*' }],
        PermissionRequest: permissionHook,
    } }), { mode: 0o600 });
    const env: NodeJS.ProcessEnv = { ...process.env, ...options.env, TERM: 'xterm-256color' };
    for (const key of ['HAPPY_RECONNECT_SESSION_ID', 'HAPPY_RECONNECT_ENCRYPTION_KEY', 'HAPPY_RECONNECT_ENCRYPTION_VARIANT', 'CLAUDECODE']) delete env[key];
    let child: any;
    const relay = new NativeTerminalRelay({ write: data => child.write(data), screen: () => screen });
    const cleanup = async () => { server.close(); terminal.dispose(); await rm(directory, { recursive: true, force: true }); };
    try {
        child = pty.spawn(options.executable, [options.resume ? '--resume' : '--session-id', options.sessionId,
            ...options.args ?? [], '--settings', settings, '--ax-screen-reader'], { cwd: options.cwd, env, cols: 100, rows: 40 });
    } catch (error) { await cleanup(); throw error; }
    child.onData((data: string) => {
        // Backpressure bounds xterm's internal parser queue; only our own PTY.
        child.pause();
        writes = writes.then(() => new Promise<void>(resolve => terminal.write(data, () => {
            const buffer = terminal.buffer.active;
            const lines = Array.from({ length: terminal.rows }, (_, i) => buffer.getLine(buffer.baseY + i)?.translateToString(true) ?? '');
            const cursor = { x: buffer.cursorX, y: buffer.cursorY };
            const next = { lines, cursor, composer: nativeComposerReady(lines, cursor) };
            if (JSON.stringify(next) !== JSON.stringify(screen)) relay.outputChanged();
            screen = next;
            try { options.onScreen?.(); } finally {
                if (!exited) child.resume();
                resolve();
            }
        })));
    });
    const exit = new Promise<{ exitCode: number; signal?: number }>(resolve => child.onExit(async (result: { exitCode: number; signal?: number }) => {
        exited = true;
        await writes;
        relay.close();
        await cleanup();
        resolve(result);
    }));
    return { relay, exit, pid: child.pid as number, settled: () => writes,
        write: (data: string) => { if (exited) throw new Error('Native terminal exited'); relay.outputChanged(); child.write(data); } };
}
