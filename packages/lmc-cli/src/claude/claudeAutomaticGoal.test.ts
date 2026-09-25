import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AutomaticGoalPolicy } from '@/utils/automaticGoal';
import { claudeGoalAvailable, prepareClaudeAutomaticGoal, normalizeClaudeGoalEcho, type ClaudeGoalMessage } from './claudeAutomaticGoal';

describe('Claude automatic native goals', () => {
    it('deduplicates the real native slash-command echo without hiding ordinary text', () => {
        expect(normalizeClaudeGoalEcho('<command-name>/goal</command-name>\n  <command-message>goal</command-message>\n  <command-args>fix and test</command-args>')).toBe('/goal fix and test');
        expect(normalizeClaudeGoalEcho('An explanation of /goal')).toBe('An explanation of /goal');
    });
    it('preserves text, files and mode, suppresses duplicates across restart, and respects native goals', async () => {
        const root = await mkdtemp(join(tmpdir(), 'claude-auto-goal-'));
        const path = join(root, 'state.json');
        const goalText = '实现资源搜索，补齐测试并验证';
        const input: ClaudeGoalMessage = { goalText, message: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'test' } }, { type: 'text', text: goalText + '\n[file: sample.pdf]' }], mode: { permissionMode: 'default' } };
        const opts = { commands: ['goal'], policy: new AutomaticGoalPolicy(path), available: async () => false };
        const longInput = { ...input, message: goalText + 'x'.repeat(2000) };
        expect(await prepareClaudeAutomaticGoal(longInput, { ...opts, available: async () => true })).toBe(longInput);
        expect(await prepareClaudeAutomaticGoal(input, opts)).toBe(input);
        const result = await prepareClaudeAutomaticGoal(input, { ...opts, available: async () => true });
        expect(result.mode).toBe(input.mode);
        expect(result.message[0]).toEqual(input.message[0]);
        expect(result.message[1]).toEqual({ type: 'text', text: '/goal ' + goalText + '\n[file: sample.pdf]' });
        expect(await prepareClaudeAutomaticGoal(input, { ...opts, policy: new AutomaticGoalPolicy(path), available: async () => true })).toBe(input);
    });
    it('reads resumed native state and fails closed on unknown state', async () => {
        const root = await mkdtemp(join(tmpdir(), 'claude-goal-state-'));
        expect(await claudeGoalAvailable(root, null)).toBe(true);
        expect(await claudeGoalAvailable(root, 'missing')).toBe(false);
        const event = (met: boolean) => JSON.stringify({ type: 'attachment', uuid: 'event-1', sessionId: 'thread-1', attachment: { type: 'goal_status', met, condition: 'existing task' } });
        const path = join(root, 'thread-1.jsonl');
        await writeFile(path, event(false) + '\n');
        expect(await claudeGoalAvailable(root, 'thread-1')).toBe(false);
        await writeFile(path, event(false) + '\n' + event(true) + '\n');
        expect(await claudeGoalAvailable(root, 'thread-1')).toBe(true);
        await writeFile(path, '{"goal_status": damaged}\n');
        expect(await claudeGoalAvailable(root, 'thread-1')).toBe(false);
    });
});
