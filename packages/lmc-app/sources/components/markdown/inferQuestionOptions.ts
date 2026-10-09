import type { MarkdownBlock } from './parseMarkdown';

type ListBlock = Extract<MarkdownBlock, { type: 'list' | 'numbered-list' }>;

const isList = (block: MarkdownBlock | undefined): block is ListBlock =>
    block?.type === 'list' || block?.type === 'numbered-list';

const explicitChoice = /请(?:你|您)?(?:选择|选)|(?:你|您)(?:想|希望|倾向|更喜欢)[^。！？]{0,35}(?:哪|选)|选哪(?:个|一)|\b(?:which|what)\b[^?]{0,90}\b(?:you|prefer)\b|(?:^|[.!?]\s+)(?:please\s+)?(?:choose|select|pick)\b/i;
const yesNoQuestion = /能否|是否|要不要|可不可以|(?:你|您)能|能[^。！？]{0,30}吗|\b(?:can|could|would|do|are|have|will) you\b/i;
const affirmative = /^(?:能|可以|已|是|需要|同意|确认|继续|保留|yes\b|i can\b|able\b)/i;
const negative = /^(?:不|无法|没|完全没有|尚未|无需|no\b|not\b|cannot\b|unable\b|i can['’]t\b)/i;
const unknown = /^(?:不确定|未知|还不清楚|部分|unsure\b|not sure\b|maybe\b)/i;
const scopeQuestion = /(?:是否|是不是|要不要)(?:只|仅)/;
const restrictedScope = /^(?:仅|只|限于)/;
const expandedScope = /^(?:同时|也|还)(?:支持|包括|包含|面向|允许|开放)/;

/**
 * Models sometimes ask a mid-turn question as bullets, saving <options> for
 * their final answer. Recover only a short, trailing answer list after a direct
 * choice prompt, a yes/no answer pair, or a restricted/expanded scope pair.
 *
 * Opt in only for assistant prose. User text, tool output, quotes, code, links,
 * nested lists and longer explanations must keep their Markdown semantics.
 * Explicit <options> remains the authoritative protocol.
 */
export function inferQuestionOptions(blocks: MarkdownBlock[]): MarkdownBlock[] {
    if (blocks.some(block => block.type === 'options')) return blocks;

    const last = blocks.at(-1);
    if (!isList(last)) return blocks;
    let start = blocks.length - 1;
    while (start > 0 && blocks[start - 1].type === last.type) start--;

    const prompt = blocks[start - 1];
    if (prompt?.type !== 'text') return blocks;
    if (prompt.content.some(span => span.url || span.styles.includes('code'))) return blocks;
    const question = prompt.content.map(span => span.text).join('').trim();
    if (/^(?:>|例如|示例|例子|for example\b|example\b)/i.test(question) || question.length > 300) return blocks;

    const entries = (blocks.slice(start) as ListBlock[]).flatMap(block => block.items);
    if (entries.length < 2 || entries.length > 4) return blocks;
    if (entries.some(item => item.depth !== 0 || item.spans.some(span => span.url || span.styles.includes('code')))) return blocks;
    const labels = entries.map(item => item.spans.map(span => span.text).join('').trim());
    if (labels.some(label => !label || label.length > 80 || /^[>\[]/.test(label) || /[\n。！？；;]/.test(label))) return blocks;
    if (new Set(labels).size !== labels.length) return blocks;

    const directChoice = explicitChoice.test(question) && /[?？:：]/.test(question);
    const binaryChoice = /[?？]/.test(question) && yesNoQuestion.test(question)
        && labels.some(label => affirmative.test(label))
        && labels.some(label => negative.test(label))
        && labels.every(label => affirmative.test(label) || negative.test(label) || unknown.test(label));
    // "是否只面向…？ / 仅… / 同时支持…" answers the question without
    // starting with 是/否. Require both sides of that scope choice so ordinary
    // feature lists after a question are not turned into send buttons.
    const scopeChoice = /[?？]/.test(question) && scopeQuestion.test(question)
        && labels.some(label => restrictedScope.test(label))
        && labels.some(label => expandedScope.test(label))
        && labels.every(label => restrictedScope.test(label) || expandedScope.test(label) || unknown.test(label));
    if (!directChoice && !binaryChoice && !scopeChoice) return blocks;

    return [...blocks.slice(0, start), { type: 'options', items: labels }];
}
