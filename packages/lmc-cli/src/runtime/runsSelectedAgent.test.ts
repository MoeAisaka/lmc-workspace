import { mkdtemp, mkdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runsSelectedAgent } from './managedRuntime';

describe('runsSelectedAgent', () => {
    it('treats a release reached through a symlinked directory as the one running', async () => {
        const root = await mkdtemp(join(tmpdir(), 'lmc-agent-root-'));
        await mkdir(join(root, 'volume', 'agent-releases', 'r1'), { recursive: true });
        await symlink(join(root, 'volume', 'agent-releases'), join(root, 'agent-releases'));
        expect(runsSelectedAgent(join(root, 'agent-releases', 'r1'), join(root, 'volume', 'agent-releases', 'r1'))).toBe(true);
        await mkdir(join(root, 'volume', 'agent-releases', 'r2'));
        expect(runsSelectedAgent(join(root, 'agent-releases', 'r2'), join(root, 'volume', 'agent-releases', 'r1'))).toBe(false);
    });
});
