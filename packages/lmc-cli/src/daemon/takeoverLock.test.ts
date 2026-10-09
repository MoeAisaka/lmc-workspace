import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('@/ui/logger', () => ({ logger: { debug: vi.fn(), warn: vi.fn() } }));
vi.mock('@/configuration', () => ({ configuration: { daemonLockFile: '/unused/daemon.lock', daemonStateFile: '/unused/daemon.state' } }));

const { acquireDaemonLock, releaseDaemonLock } = await import('@/persistence');

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
async function lockPath() {
    const dir = await mkdtemp(join(tmpdir(), 'lmc-takeover-'));
    dirs.push(dir);
    return join(dir, 'daemon.takeover.lock');
}

describe('daemon takeover lock', () => {
    it('admits exactly one starter out of a herd', async () => {
        const file = await lockPath();
        // launchd, plus every session's ensureDaemonRunning, can start together.
        const handles = await Promise.all(Array.from({ length: 6 }, () => acquireDaemonLock(1, 0, file)));
        expect(handles.filter(Boolean)).toHaveLength(1);
        expect(await readFile(file, 'utf-8')).toBe(String(process.pid));
    });

    it('lets the next starter in once the winner releases', async () => {
        const file = await lockPath();
        const first = await acquireDaemonLock(1, 0, file);
        expect(first).not.toBeNull();
        expect(await acquireDaemonLock(1, 0, file)).toBeNull();
        await releaseDaemonLock(first!, file);
        const second = await acquireDaemonLock(1, 0, file);
        expect(second).not.toBeNull();
        await releaseDaemonLock(second!, file);
    });

    it('reclaims a lock whose owner died mid-takeover', async () => {
        const file = await lockPath();
        const { writeFileSync } = await import('node:fs');
        // A crashed starter leaves its pid behind; 2^31-1 is never a live pid here.
        writeFileSync(file, '2147483647');
        const handle = await acquireDaemonLock(2, 0, file);
        expect(handle).not.toBeNull();
        await releaseDaemonLock(handle!, file);
    });

    it('keeps the main daemon lock independent of the takeover lock', async () => {
        const takeover = await lockPath();
        const main = await lockPath();
        const a = await acquireDaemonLock(1, 0, takeover);
        const b = await acquireDaemonLock(1, 0, main);
        expect(a).not.toBeNull();
        expect(b).not.toBeNull();
        await releaseDaemonLock(a!, takeover);
        await releaseDaemonLock(b!, main);
    });
});

describe('daemon heartbeat state', () => {
    const startup = {
        pid: 100, httpPort: 5000, startTime: 'start', startedWithCliVersion: '1.2.7',
        daemonLogPath: '/tmp/d.log', supervisor: 'launchd' as const,
    };

    it('keeps the supervisor and log path across a heartbeat', async () => {
        const { heartbeatDaemonState } = await import('@/persistence');
        const next = heartbeatDaemonState(startup, { pid: 100, httpPort: 5001, startedWithCliVersion: '1.2.7' }, 'now');
        expect(next).toEqual({ ...startup, httpPort: 5001, lastHeartbeat: 'now' });
    });

    it('leaves an unsupervised daemon unsupervised', async () => {
        const { heartbeatDaemonState } = await import('@/persistence');
        const { supervisor, ...unmanaged } = startup;
        const next = heartbeatDaemonState(unmanaged, { pid: 100, httpPort: 5000, startedWithCliVersion: '1.2.7' }, 'now');
        expect('supervisor' in next).toBe(false);
    });
});

describe('daemon owner cleanup', () => {
    async function ownerFiles(statePid: number, lockPid: number) {
        const lock = await lockPath();
        const state = lock + '.state';
        const { configuration } = await import('@/configuration');
        const { writeFileSync } = await import('node:fs');
        Object.assign(configuration, { daemonStateFile: state, daemonLockFile: lock });
        writeFileSync(state, JSON.stringify({ pid: statePid }));
        writeFileSync(lock, String(lockPid));
        return { state, lock };
    }

    it('preserves the successor state and lock when the old daemon exits late', async () => {
        const { state, lock } = await ownerFiles(process.pid + 1, process.pid + 1);
        const { clearDaemonState } = await import('@/persistence');
        await clearDaemonState(process.pid);
        expect(JSON.parse(await readFile(state, 'utf-8')).pid).toBe(process.pid + 1);
        expect(await readFile(lock, 'utf-8')).toBe(String(process.pid + 1));
    });

    it('clears only the state and lock belonging to the expected owner', async () => {
        const { state, lock } = await ownerFiles(process.pid, process.pid);
        const { clearDaemonState } = await import('@/persistence');
        await clearDaemonState(process.pid);
        await expect(readFile(state)).rejects.toMatchObject({ code: 'ENOENT' });
        await expect(readFile(lock)).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('does not remove a newer lock while cleaning an older state file', async () => {
        const { state, lock } = await ownerFiles(process.pid, process.pid + 1);
        const { clearDaemonState } = await import('@/persistence');
        await clearDaemonState(process.pid);
        await expect(readFile(state)).rejects.toMatchObject({ code: 'ENOENT' });
        expect(await readFile(lock, 'utf-8')).toBe(String(process.pid + 1));
    });

    it('does not unlink another owner when releasing a superseded lock handle', async () => {
        const file = await lockPath();
        const handle = await acquireDaemonLock(1, 0, file);
        const { writeFileSync } = await import('node:fs');
        writeFileSync(file, String(process.pid + 1));
        await releaseDaemonLock(handle!, file);
        expect(await readFile(file, 'utf-8')).toBe(String(process.pid + 1));
    });
});
