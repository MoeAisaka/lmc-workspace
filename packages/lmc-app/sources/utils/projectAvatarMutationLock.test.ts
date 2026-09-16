import { describe, expect, it, vi } from 'vitest';
import { ProjectAvatarMutationLock } from './projectAvatarMutationLock';

describe('ProjectAvatarMutationLock', () => {
    it('publishes project-scoped lock transitions and rejects overlap', async () => {
        const lock = new ProjectAvatarMutationLock();
        const listener = vi.fn();
        lock.subscribe(listener);
        let finish!: () => void;

        const first = lock.run('project-1', () => new Promise<void>((resolve) => {
            finish = resolve;
        }));

        expect(lock.isLocked('project-1')).toBe(true);
        expect(lock.isLocked('project-2')).toBe(false);
        await expect(lock.run('project-1', async () => undefined))
            .rejects.toThrow('Project avatar update already in progress');

        finish();
        await first;
        expect(lock.isLocked('project-1')).toBe(false);
        expect(listener).toHaveBeenCalledTimes(2);
    });

    it('allows different projects concurrently and releases after failure', async () => {
        const lock = new ProjectAvatarMutationLock();
        let finish!: () => void;
        const first = lock.run('project-1', () => new Promise<void>((resolve) => {
            finish = resolve;
        }));

        await expect(lock.run('project-2', async () => 'done')).resolves.toBe('done');
        await expect(lock.run('project-3', async () => {
            throw new Error('failed');
        })).rejects.toThrow('failed');
        expect(lock.isLocked('project-2')).toBe(false);
        expect(lock.isLocked('project-3')).toBe(false);

        finish();
        await first;
    });
});
