import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AutomaticGoalPolicy, detectAutomaticGoal } from './automaticGoal';

describe('automatic goal recognition', () => {
    it.each([
        '修复登录失效的问题，补齐回归测试，验证通过后上线并同步仓库',
        '实现会话资源搜索，支持文件正文，完成后验证 PDF 和 DOCX',
        '持续推进 Qwen 评测，直到完整验证通过',
        '帮我完成这个功能：1、分析原因；2、实现修复；3、跑测试',
        'Implement file search, test PDF and DOCX, then deploy it.',
        'Keep working on the migration until all acceptance checks pass.',
    ])('recognizes an authorized sustained task: %s', text => {
        expect(detectAutomaticGoal(text)).toBe(text);
    });

    it.each([
        '你好', '现在什么进度', '解释一下为什么要测试和部署',
        '能否实现自动搜索、测试和部署？', '先给方案，不要实现和部署',
        '帮我分析这个方案', '只改这个颜色', '上线',
        '/goal 修复、测试并上线', '```\n修复问题，测试后上线\n```',
        '> 修复问题，测试后上线', '[from your worker] 修复问题，测试后上线',
        'What does implement, test and deploy mean?',
        'Please explain how to implement and test this.',
        'Do not implement this yet; first propose a plan and test strategy.',
    ])('leaves ordinary input alone: %s', text => {
        expect(detectAutomaticGoal(text)).toBeNull();
    });
});

describe('automatic goal lifecycle', () => {
    const text = '修复登录问题，测试通过后部署';
    it('persists only hashes and does not recreate a cleared task after restart', async () => {
        const path = join(await mkdtemp(join(tmpdir(), 'lmc-auto-goal-')), 'state.json');
        const policy = new AutomaticGoalPolicy(path);
        expect(await policy.claim(text, { supported: true, available: true })).toBe(text);
        expect(await new AutomaticGoalPolicy(path).claim(text, { supported: true, available: true })).toBeNull();
        expect(await readFile(path, 'utf8')).not.toContain('登录');
    });
    it('keeps existing goals, plan mode and unsupported runtimes unchanged', async () => {
        const path = join(await mkdtemp(join(tmpdir(), 'lmc-auto-goal-')), 'state.json');
        const policy = new AutomaticGoalPolicy(path);
        for (const opts of [
            { supported: true, available: false },
            { supported: false, available: true },
            { supported: true, available: true, permissionMode: 'plan' },
        ]) expect(await policy.claim(text, opts)).toBeNull();
        expect(await policy.claim(text, { supported: true, available: true })).toBe(text);
    });
    it('fails closed on damaged state and serializes concurrent claims', async () => {
        const path = join(await mkdtemp(join(tmpdir(), 'lmc-auto-goal-')), 'state.json');
        const policy = new AutomaticGoalPolicy(path);
        const results = await Promise.all([1, 2].map(() => policy.claim(text, { supported: true, available: true })));
        expect(results.filter(Boolean)).toHaveLength(1);
        await writeFile(path, 'damaged');
        await expect(new AutomaticGoalPolicy(path).claim(text, { supported: true, available: true })).rejects.toThrow();
    });
});
