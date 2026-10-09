import { describe, expect, it } from 'vitest';
import { parseMarkdown } from './parseMarkdown';
import { parseFollowupDirective } from './parseFollowupDirective';

const action = ':codex-followup[实测资料回填]{prompt="根据我提供的实测资料回填，保留未确认项。"}';
const parsed = (text: string) => parseMarkdown(text, { followups: true });

describe('assistant follow-up actions', () => {
    it.each(['', '- ', '* ', '+ ', '1. ', ':'])('recognizes the reply form with prefix %j', prefix => {
        expect(parsed(prefix + action)).toEqual([{ type: 'followups', items: [{
            title: '实测资料回填', prompt: '根据我提供的实测资料回填，保留未确认项。',
        }] }]);
    });

    it('groups actions between prose without dropping surrounding text or lists', () => {
        const result = parsed(`前文\n\n- 普通检查项\n- ${action}\n\n- ${action.replace('实测资料回填', '统一最终视角')}\n- 仍需人工确认\n\n后文`);
        expect(result.map(b => b.type)).toEqual(['text', 'list', 'followups', 'list', 'text']);
        expect(result[2]).toMatchObject({ items: [{ title: '实测资料回填' }, { title: '统一最终视角' }] });
    });

    it('sends a decoded complete prompt, retaining quotes, paths and line breaks', () => {
        const prompt = '核对 "R12" 的 C:\\plans\\draft；\n保留未确认项。';
        expect(parseFollowupDirective(`::codex-followup[核对资料]{prompt=${JSON.stringify(prompt)}}`)).toEqual({ title: '核对资料', prompt });
    });

    it('does not activate actions in user messages or documents by default', () => {
        expect(parseMarkdown('- ' + action).map(b => b.type)).toEqual(['list']);
    });

    it.each(['```', '````', '~~~'])('keeps %s fenced examples literal', fence => {
        expect(parsed(`${fence}md\n${action}\n${fence}`)).toEqual([{ type: 'code-block', language: 'md', content: action }]);
    });

    it('does not end a long fence on an inner triple-backtick example', () => {
        expect(parsed(`\`\`\`\`md\n\`\`\`\n${action}\n\`\`\`\n\`\`\`\``)).toHaveLength(1);
    });

    it.each(['`' + action + '`', '> ' + action, '例如：' + action, '    ' + action])('keeps quoted or explanatory examples literal: %s', text => {
        expect(parsed(text).some(b => b.type === 'followups')).toBe(false);
    });

    it.each([
        action.slice(0, -1), action.replace('prompt=', 'url='), action + ' 附加文字',
        action.replace('实测资料回填', ''), ':codex-followup[空]{prompt=" "}',
        ':codex-followup[坏转义]{prompt="\\x20"}', action.replace('codex-followup', 'other-action'),
    ])('does not turn malformed, incomplete or unknown directives into actions: %s', text => {
        expect(parsed(text).some(b => b.type === 'followups')).toBe(false);
    });

    it('keeps existing XML options separate', () => {
        expect(parsed(`${action}\n\n<options>\n<option>继续</option>\n<option>暂停</option>\n</options>`).map(b => b.type)).toEqual(['followups', 'options']);
    });
});
