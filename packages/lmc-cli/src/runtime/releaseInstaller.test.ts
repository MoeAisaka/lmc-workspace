import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { npmArguments, run } from './releaseInstaller';

describe('npmArguments', () => {
    it('keeps the npm cache beside the engine releases, whatever the user npmrc says', () => {
        expect(npmArguments('/home/agent')).toEqual([
            '--cache=' + join('/home/agent', 'runtime-releases', '.npm-cache'),
            '--registry=https://registry.npmjs.org',
        ]);
    });
});

describe('run', () => {
    const node = (script: string) => run(process.execPath, ['-e', script], { timeout: 10_000, maxBuffer: 1024 });

    it('returns what the command printed', async () => {
        expect(await node("process.stdout.write('out');process.stderr.write('err')")).toEqual({ stdout: 'out', stderr: 'err' });
    });

    it('rejects with the exit code and output of a failed command', async () => {
        await expect(node("process.stdout.write('partial');process.exit(3)")).rejects.toMatchObject({ code: 3, stdout: 'partial' });
    });

    it('rejects when the command cannot be started, or prints too much', async () => {
        await expect(run('lmc-no-such-command', [], { timeout: 10_000, maxBuffer: 1024 })).rejects.toThrow();
        await expect(node("process.stdout.write('x'.repeat(5000))")).rejects.toThrow('命令输出过长');
    });
});
