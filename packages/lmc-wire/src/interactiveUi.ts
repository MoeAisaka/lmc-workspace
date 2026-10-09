/**
 * Interactive answers (D30): the engine answers with a self-contained HTML
 * page inside a fenced block, and the LMC web client shows it in a sandbox.
 *
 * The fence is ordinary Markdown, so any client that does not know the block
 * still shows readable code. The info string carries the block's identity:
 *
 *     ```lmc-ui id=plan-compare title="套餐对比"
 *     <!doctype html>…
 *     ```
 *
 * Re-showing a page the session already holds is a reference, which costs
 * the engine a line instead of the whole page:
 *
 *     ```lmc-ui ref=plan-compare
 *     ```
 */
export const INTERACTIVE_FENCE = 'lmc-ui';
export const INTERACTIVE_BLOCK_MAX_BYTES = 200 * 1024;

/** How much the engine is told about the capability. */
export type InteractiveAnswersMode = 'off' | 'ask' | 'auto';
export const INTERACTIVE_ANSWERS_MODES: readonly InteractiveAnswersMode[] = ['off', 'ask', 'auto'];
export const INTERACTIVE_ANSWERS_DEFAULT: InteractiveAnswersMode = 'auto';

export type InteractiveFence = { id: string | null; title: string | null; ref: string | null };

/** Parses the info string after the fence; null when it is not an interactive block. */
export function parseInteractiveFence(info: string | null | undefined): InteractiveFence | null {
    const text = (info ?? '').trim();
    if (text !== INTERACTIVE_FENCE && !text.startsWith(INTERACTIVE_FENCE + ' ')) return null;
    const result: InteractiveFence = { id: null, title: null, ref: null };
    const attrs = /(\w+)=("([^"]*)"|'([^']*)'|(\S+))/g;
    let match: RegExpExecArray | null;
    while ((match = attrs.exec(text.slice(INTERACTIVE_FENCE.length))) !== null) {
        const value = (match[3] ?? match[4] ?? match[5] ?? '').trim();
        if (match[1] === 'id') result.id = cleanId(value);
        else if (match[1] === 'ref') result.ref = cleanId(value);
        else if (match[1] === 'title') result.title = value.slice(0, 80) || null;
    }
    return result;
}

function cleanId(value: string): string | null {
    const id = value.toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 40);
    return id || null;
}

export type InteractiveBlock = InteractiveFence & { html: string; closed: boolean };

/** Every interactive block in a Markdown text, in order; an unclosed last fence is still being written. */
export function extractInteractiveBlocks(markdown: string): InteractiveBlock[] {
    const blocks: InteractiveBlock[] = [];
    const lines = markdown.split('\n');
    for (let index = 0; index < lines.length; index++) {
        const fence = /^\s*(`{3,}|~{3,})(.*)$/.exec(lines[index]);
        if (!fence) continue;
        const info = parseInteractiveFence(fence[2]);
        const closing = new RegExp(`^\\s*${fence[1][0]}{${fence[1].length},}\\s*$`);
        const body: string[] = [];
        let closed = false;
        for (index++; index < lines.length; index++) {
            if (closing.test(lines[index])) { closed = true; break; }
            body.push(lines[index]);
        }
        if (info) blocks.push({ ...info, html: body.join('\n'), closed });
    }
    return blocks;
}

const AUTO_WHEN = `Use it whenever a page would explain or let the person work with the answer better than prose would: comparisons, charts, timelines, diagrams, calculators, small tools. Plain facts, code, logs and short answers stay as text.`;
const ASK_WHEN = `Use it only when the person explicitly asks for a chart, a diagram, a comparison page, a calculator or another interactive view. Never volunteer one.`;

/** What the engine is told; empty when the feature is off so it costs nothing. */
export function interactiveAnswersPrompt(mode: InteractiveAnswersMode): string {
    if (mode === 'off') return '';
    return `# Interactive answers

You can answer with a page the person can look at and use, by writing a fenced code block whose info string starts with \`${INTERACTIVE_FENCE}\` and whose body is one complete, self-contained HTML document:

\`\`\`${INTERACTIVE_FENCE} id=<short-id> title="<short title>"
<!doctype html>
<html>…</html>
\`\`\`

${mode === 'auto' ? AUTO_WHEN : ASK_WHEN}

Rules:
- The page runs in a sandboxed frame with no access to this app, the conversation or any login. It may load scripts, styles, fonts and data from the network (for example a chart library from a CDN), but it cannot navigate the app, open windows or submit forms anywhere.
- Never put the conversation's text, file contents or anything private into the page beyond the data it shows.
- Keep it under ${Math.round(INTERACTIVE_BLOCK_MAX_BYTES / 1024)} KB. Use system fonts and simple CSS; both light and dark backgrounds should look fine.
- Give every block a stable \`id\` (lowercase letters, digits, dashes) and a \`title\`. To show a block again later, write only \`\`\`${INTERACTIVE_FENCE} ref=<id>\`\`\` with an empty body instead of repeating the page. To change a block, write a new block with a new id.
- Interaction stays inside the page: it cannot send anything back to you. Put the conclusion in your text as well, so the answer reads without the page.
- Write the block once, complete, and do not describe its contents again in prose.`;
}
