import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let directory: string;
beforeEach(async () => {
    directory = await fs.mkdtemp(join(tmpdir(), 'lmc-files-'));
    vi.stubEnv('DATA_DIR', directory);
    vi.stubEnv('S3_HOST', '');
    vi.resetModules();
});
afterEach(async () => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    vi.unstubAllEnvs();
    await fs.rm(directory, { recursive: true, force: true });
});

it('round trips opaque bytes and removes only the selected session/project files', async () => {
    const files = await import('./files');
    await files.loadFiles();
    const bytes = Buffer.from([0, 255, 1, 128]);
    await files.putLocalFile('sessions/one/attachments/a.enc', bytes);
    await files.putLocalFile('sessions/two/attachments/b.enc', bytes);
    await files.putLocalFile('projects/one/avatar/a.enc', bytes);
    expect(await files.readLocalFile('sessions/one/attachments/a.enc')).toEqual(bytes);
    await files.deleteSessionAttachments('one');
    await files.deleteProjectAvatars('one');
    await expect(files.readLocalFile('sessions/one/attachments/a.enc')).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await files.readLocalFile('sessions/two/attachments/b.enc')).toEqual(bytes);
    expect(await files.localFileExists('projects/one/avatar/a.enc')).toBe(false);
});

it('bounds stalled storage work, keeps timers running and retains slots after timeout until IO settles', async () => {
    const files = await import('./files');
    vi.useFakeTimers();
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const mkdir = vi.spyOn(fs, 'mkdir').mockImplementation(() => blocked as any);
    const write = vi.spyOn(fs, 'writeFile');
    const a = files.putLocalFile('a.enc', Buffer.from('a'));
    const b = files.putLocalFile('b.enc', Buffer.from('b'));
    const failures = Promise.all([
        expect(a).rejects.toMatchObject({ statusCode: 503 }),
        expect(b).rejects.toMatchObject({ statusCode: 503 }),
    ]);
    let heartbeat = false;
    setTimeout(() => { heartbeat = true; }, 10);
    await vi.advanceTimersByTimeAsync(20);
    expect(heartbeat).toBe(true);
    await expect(files.putLocalFile('c.enc', Buffer.from('c'))).rejects.toMatchObject({ statusCode: 503 });
    expect(mkdir).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(15000);
    await failures;
    await expect(files.putLocalFile('d.enc', Buffer.from('d'))).rejects.toMatchObject({ statusCode: 503 });
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(write).not.toHaveBeenCalled(); // timed-out mkdir cannot proceed to a late write
    mkdir.mockRestore();
    vi.useRealTimers();
    await files.putLocalFile('e.enc', Buffer.from('e'));
    expect(await files.readLocalFile('e.enc')).toEqual(Buffer.from('e'));
});

it('preserves the previous blob when replacement fails and cleans its temporary file', async () => {
    const files = await import('./files');
    await files.putLocalFile('a.enc', Buffer.from('old'));
    vi.spyOn(fs, 'rename').mockRejectedValueOnce(Object.assign(new Error('denied'), { code: 'EACCES' }));
    await expect(files.putLocalFile('a.enc', Buffer.from('new'))).rejects.toMatchObject({ statusCode: 503 });
    expect(await files.readLocalFile('a.enc')).toEqual(Buffer.from('old'));
    expect(await fs.readdir(join(directory, 'files'))).toEqual(['a.enc']);
});

it('does not disguise permission failures as missing files', async () => {
    const files = await import('./files');
    vi.spyOn(fs, 'stat').mockRejectedValueOnce(Object.assign(new Error('private path'), { code: 'EPERM' }));
    await expect(files.localFileExists('a.enc')).rejects.toMatchObject({ statusCode: 503, message: 'Local storage unavailable' });
});
