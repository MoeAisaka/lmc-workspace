import { afterEach, describe, expect, it, vi } from 'vitest';
import psList from 'ps-list';
import { listSessionProcesses } from './sessionProcesses';

const execute = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({
    execFile: Object.assign(vi.fn(), {[Symbol.for('nodejs.util.promisify.custom')]: execute}),
}));
vi.mock('ps-list', () => ({ default: vi.fn() }));
const originalPlatform = process.platform;
afterEach(() => { Object.defineProperty(process, 'platform', {value: originalPlatform}); vi.resetAllMocks(); });
const windowsOutput = (stdout: string, error: Error | null = null) => {
    Object.defineProperty(process, 'platform', {value: 'win32'});
    if (error) execute.mockRejectedValue(error);
    else execute.mockResolvedValue({stdout, stderr: ''});
};

describe('session process discovery', () => {
    it('keeps the existing native process listing outside Windows', async () => {
        Object.defineProperty(process, 'platform', {value: 'darwin'});
        vi.mocked(psList).mockResolvedValue([{pid: 123, name: 'node', ppid: 1, cmd: 'node /opt/happy/dist/index.mjs codex'}]);
        expect(await listSessionProcesses()).toEqual(await psList());
        expect(execute).not.toHaveBeenCalled();
    });
    it('reads Windows command lines, including a single process and Unicode/spaces', async () => {
        const cmd = String.raw`"C:\Program Files\nodejs\node.exe" C:\用户\link-my-cli\dist\index.mjs codex`;
        windowsOutput(JSON.stringify([{ProcessId: 13656, Name: 'node.exe', CommandLine: cmd}]));
        expect(await listSessionProcesses()).toEqual([{pid: 13656, name: 'node.exe', cmd}]);
        const [file, args, options] = execute.mock.calls[0];
        expect(file).toMatch(/WindowsPowerShell.*powershell\.exe$/i);
        expect(args).toContain('-EncodedCommand');
        expect(options).toMatchObject({timeout: 10000, windowsHide: true, maxBuffer: 4 * 1024 * 1024});
        expect(psList).not.toHaveBeenCalled();
    });
    it('represents an inaccessible command as unknown, never as an absent process', async () => {
        windowsOutput('[{"ProcessId":13656,"Name":"node.exe","CommandLine":null}]');
        expect(await listSessionProcesses()).toEqual([{pid: 13656, name: 'node.exe', cmd: undefined}]);
    });
    it('accepts a successful empty process inventory', async () => {
        windowsOutput('[]'); expect(await listSessionProcesses()).toEqual([]);
    });
    it.each(['', 'not-json', '{}', '[{"ProcessId":null,"Name":"node.exe"}]'])('fails closed on malformed process inventory: %s', async output => {
        windowsOutput(output); await expect(listSessionProcesses()).rejects.toThrow();
    });
    it('fails closed on a failed or timed-out CIM query', async () => {
        windowsOutput('[]', new Error('CIM timeout')); await expect(listSessionProcesses()).rejects.toThrow('CIM timeout');
    });
});
