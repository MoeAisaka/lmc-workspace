import { spawn } from 'cross-spawn';

/** Bounded CLI probe that also resolves npm .cmd shims on Windows. */
export function probeCommand(command: string, args: string[], options: {
    cwd?: string; env?: NodeJS.ProcessEnv; timeout?: number; maxBuffer?: number;
} = {}): Promise<{ code: number | null; stdout: string; stderr: string }> {
    return new Promise(resolve => {
        const child = spawn(command, args, { cwd: options.cwd, env: options.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
        const stdout: Buffer[] = [], stderr: Buffer[] = [];
        let bytes = 0, done = false;
        const finish = (code: number | null) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            resolve({ code, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') });
        };
        const abort = () => { finish(null); child.kill(); };
        const timer = setTimeout(abort, options.timeout ?? 10_000);
        const collect = (chunks: Buffer[]) => (chunk: Buffer) => {
            if (done) return;
            bytes += chunk.length;
            if (bytes > (options.maxBuffer ?? 64 * 1024)) { abort(); return; }
            chunks.push(chunk);
        };
        child.stdout!.on('data', collect(stdout));
        child.stderr!.on('data', collect(stderr));
        child.once('error', () => finish(null));
        child.once('close', code => finish(code));
    });
}
