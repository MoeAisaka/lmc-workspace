import { describe, expect, it } from 'vitest';
import { parseMarkdown } from './parseMarkdown';
import { inferQuestionOptions } from './inferQuestionOptions';

const question = '在现场按 Ctrl+Alt+F3，能否切到登录界面并输入？这能帮助判断还能否先读取故障证据。';
const labels = ['能切换并输入', '能切换，但无法登录', '完全没有响应'];
const markdown = `${question}\n${labels.map(label => `- ${label}`).join('\n')}`;
const infer = (text: string) => inferQuestionOptions(parseMarkdown(text));

describe('inferQuestionOptions', () => {
    it('recovers a running reply that asks a direct question but emits bullets', () => {
        expect(infer(markdown)).toEqual([
            ...parseMarkdown(question),
            { type: 'options', items: labels },
        ]);
        // Shared Markdown (user messages, documents, tool output) stays literal.
        expect(parseMarkdown(markdown).at(-1)?.type).toBe('list');
    });

    it('recognizes a short explicit choice, including numbered items separated by blank lines', () => {
        expect(infer('请选择下一步：\n\n1. 继续排查\n\n2. 暂时停止').at(-1)).toEqual({
            type: 'options', items: ['继续排查', '暂时停止'],
        });
        expect(infer('Which version would you prefer?\n- Desktop\n- Mobile').at(-1)).toEqual({
            type: 'options', items: ['Desktop', 'Mobile'],
        });
        expect(infer('Can you sign in? This will help with diagnosis.\n- Yes, I can\n- No, I cannot').at(-1)?.type).toBe('options');
        expect(infer('Please choose a version:\n- Desktop\n- Mobile').at(-1)?.type).toBe('options');
    });

    it.each([
        '检查结果：\n- 能切换并输入\n- 完全没有响应',
        '有哪些故障原因？\n- 磁盘损坏\n- 内存不足',
        '能否读取日志？\n- 文件权限不正确\n- 磁盘空间不足',
        'How to choose a disk:\n- Durability\n- Capacity',
        '例如，请选择下一步：\n- 继续\n- 暂停',
        '请选择下一步：\n- [查看文档](https://example.com)\n- 继续',
        '请选择下一步：\n- `rm -rf example`\n- 继续',
        '请选择下一步：\n- [ ] 排查\n- [ ] 修复',
        '请选择下一步：\n- 方案 A\n  - 子项\n- 方案 B',
        '请选择下一步：\n- 方案 A\n- 方案 B\n\n先执行上述步骤。',
        '请选择下一步：\n- 继续',
        '请选择下一步：\n- A\n- B\n- C\n- D\n- E',
        `请选择下一步：\n- ${'完整说明'.repeat(25)}\n- 暂停`,
        '请选择下一步：\n- 继续\n- 继续',
        '> 请选择下一步：\n> - 继续\n> - 暂停',
        '```text\n请选择下一步：\n- 继续\n- 暂停\n```',
    ])('leaves non-answer lists and examples unchanged: %s', (text) => {
        expect(infer(text)).toEqual(parseMarkdown(text));
    });

    it('keeps explicit options authoritative and does not infer a second set', () => {
        const text = `${markdown}\n<options>\n<option>改用明确选项</option>\n</options>`;
        expect(infer(text)).toEqual(parseMarkdown(text));
    });
});
