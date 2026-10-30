import { describe, expect, it } from 'vitest';
import { spawnHostedPty } from './ptyHost';

describe('isolated native terminal host', () => {
    it('round-trips Unicode input and drains output before the real terminal exit', async () => {
        const terminal = await spawnHostedPty(process.execPath, ['-e', "process.stdin.setEncoding('utf8');process.stdin.once('data',s=>{process.stdout.write('ACK:'+s);setTimeout(()=>process.exit(0),50)})"],
            { cwd: process.cwd(), env: process.env, cols: 100, rows: 40 });
        expect(terminal.pid).toBeGreaterThan(0);
        let output = '';
        terminal.onData(data => { output += data; });
        const exit = new Promise<{ exitCode: number }>(resolve => terminal.onExit(resolve));
        terminal.write('中文 (native)\r');
        expect(await exit).toMatchObject({ exitCode: 0 });
        expect(output).toContain('ACK:中文 (native)');
        expect(() => terminal.write('duplicate')).toThrow('exited');
    }, 15_000);

    it('preserves an immediate native failure and its last output', async () => {
        const terminal = await spawnHostedPty(process.execPath, ['-e', "process.stdout.write('FINAL OUTPUT');process.exit(7)"],
            { cwd: process.cwd(), env: process.env, cols: 100, rows: 40 });
        let output = '';
        terminal.onData(data => { output += data; });
        const result = await new Promise(resolve => terminal.onExit(resolve));
        expect(result).toMatchObject({ exitCode: 7 });
        expect(output).toContain('FINAL OUTPUT');
    }, 15_000);

    it('reports a missing executable without leaving a live native session', async () => {
        await expect(spawnHostedPty('/lmc-missing-native-executable', [],
            { cwd: process.cwd(), env: process.env, cols: 100, rows: 40 })).rejects.toThrow();
    }, 15_000);
});
