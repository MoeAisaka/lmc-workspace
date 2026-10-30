import { fork } from 'node:child_process';
import { join } from 'node:path';
import { projectPath } from '../../projectPath';

type Exit = { exitCode: number; signal?: number };
type SpawnOptions = { cwd: string; env: NodeJS.ProcessEnv; cols: number; rows: number };

/** Isolate Windows ConPTY handles without patching node-pty or the CLI.
 * The helper exits only after the native CLI has exited. */
export async function spawnHostedPty(executable: string, args: string[], options: SpawnOptions) {
    const host = fork(join(projectPath(), 'bin/native-pty-host.cjs'), [], {
        env: options.env, execArgv: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    let onData: ((data: string) => void) | undefined;
    let onExit: ((exit: Exit) => void) | undefined;
    let finished: Exit | undefined;
    let inputError: Error | undefined;
    const pending: string[] = [];
    const finish = (result: Exit) => {
        if (finished) return;
        finished = result;
        onExit?.(result);
    };
    const send = (message: object) => {
        if (inputError) throw inputError;
        if (!host.connected || finished) throw new Error('Native terminal exited');
        host.send(message, error => { if (error) inputError = error; });
    };
    const pid = await new Promise<number>((resolve, reject) => {
        host.on('error', error => { reject(error); finish({ exitCode: 1 }); });
        host.on('exit', (code) => {
            reject(new Error('Native terminal host exited before startup'));
            finish({ exitCode: code || 1 });
        });
        host.on('message', (message: any) => {
            if (message?.type === 'ready') resolve(message.pid);
            else if (message?.type === 'data') {
                if (onData) onData(message.data); else pending.push(message.data);
            } else if (message?.type === 'exit') finish(message.result);
            else if (message?.type === 'error') {
                inputError = new Error(message.message);
                reject(inputError);
            }
        });
        send({ type: 'start', executable, args, options: { cwd: options.cwd, cols: options.cols, rows: options.rows } });
    });
    return {
        pid,
        write: (data: string) => send({ type: 'write', data }),
        pause: () => { if (!finished) send({ type: 'pause' }); },
        resume: () => { if (!finished) send({ type: 'resume' }); },
        onData: (callback: (data: string) => void) => {
            onData = callback;
            for (const data of pending.splice(0)) callback(data);
            if (!finished) send({ type: 'resume' });
        },
        onExit: (callback: (result: Exit) => void) => {
            onExit = callback;
            if (finished) queueMicrotask(() => callback(finished!));
        },
    };
}
