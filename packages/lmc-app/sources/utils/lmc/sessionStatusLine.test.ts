import { describe, expect, it, vi } from 'vitest';
// The status line reads translations, and the i18n module loads stored
// settings at import time. With nothing stored the language is English.
vi.mock('@/sync/persistence', () => ({ loadSettings: () => ({ settings: {} }) }));
import { describeLmcSessionStatus, describePermissionRequest, formatRelativeShort } from './sessionStatusLine';
import type { Session } from '@/sync/storageTypes';

const now = 1_700_000_000_000;
const base = (extra: Partial<Session> = {}): Session => ({
    id: 's', seq: 1, createdAt: now - 60_000, updatedAt: now, active: true, activeAt: now - 5_000, metadataVersion: 1, agentStateVersion: 1,
    thinking: false, thinkingAt: 0, presence: 'online', agentState: null,
    metadata: { machineId: 'm', flavor: 'claude', lastMeaningfulMessageAt: now - 3 * 60_000 } as any, ...extra,
});

describe('describeLmcSessionStatus', () => {
    it('names the command a permission request is waiting on', () => {
        const line = describeLmcSessionStatus(base({ agentState: { requests: { r: { tool: 'Bash', arguments: { command: 'npm run build' } } } } as any }), now);
        expect(line).toEqual({ tone: 'attention', needsReply: true, text: 'Allow running npm run build', trailing: '3m ago' });
    });

    it('shows the agent goal and elapsed time while working', () => {
        const line = describeLmcSessionStatus(base({
            thinking: true, thinkingAt: now - 12_000,
            metadata: { machineId: 'm', flavor: 'claude', claudeSessionId: 'c1', lastMeaningfulMessageAt: now - 60_000 } as any,
            agentState: { agentGoalStatus: { status: 'active', source: 'claude', observedAt: now, sourceSessionId: 'c1', text: 'Writing code · UpgradePanel.tsx' } } as any,
        }), now);
        expect(line.tone).toBe('working');
        expect(line.text).toBe('Writing code · UpgradePanel.tsx · 12s');
        expect(line.trailing).toBe('12s');
    });

    it('falls back to a generic working line without a goal', () => {
        expect(describeLmcSessionStatus(base({ thinking: true, thinkingAt: now - 90_000 }), now).text).toBe('Working · 1m');
    });

    it('reports idle and disconnected with relative times', () => {
        expect(describeLmcSessionStatus(base(), now)).toMatchObject({ tone: 'idle', text: 'Idle · 3m ago', needsReply: false });
        expect(describeLmcSessionStatus(base({ presence: now - 3 * 86_400_000 }), now)).toMatchObject({ tone: 'offline', text: 'Disconnected · 3d ago' });
    });

    it('describes file tools by file name and unknown tools by verb', () => {
        expect(describePermissionRequest({ tool: 'Edit', arguments: { file_path: '/a/b/run.ts' } })).toBe('Allow Editing a file run.ts');
        expect(describePermissionRequest({ tool: 'Mystery' })).toBe('Allow Mystery');
    });

    it('formats short relative times', () => {
        expect(formatRelativeShort(now - 10_000, now)).toBe('just now');
        expect(formatRelativeShort(now - 2 * 3_600_000, now)).toBe('2h ago');
    });
});
