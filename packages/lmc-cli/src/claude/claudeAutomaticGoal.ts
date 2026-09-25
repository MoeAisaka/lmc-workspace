import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import type { MessageParam } from '@anthropic-ai/sdk/resources';
import { parseClaudeGoalStatusTranscriptEvent } from './claudeGoalStatus';
import type { AutomaticGoalPolicy } from '@/utils/automaticGoal';
import { detectAutomaticGoal } from '@/utils/automaticGoal';

export type ClaudeGoalMessage = { message: MessageParam['content']; mode: { permissionMode?: string }; goalText?: string };

/** Native Claude logs slash commands as markup, not as the input sent over SDK. */
export function normalizeClaudeGoalEcho(text: string): string {
    const echo = /^<command-name>\/goal<\/command-name>\s*<command-message>goal<\/command-message>\s*<command-args>([\s\S]*)<\/command-args>$/.exec(text.trim());
    return echo ? `/goal ${echo[1]}` : text;
}

/** Read the native authority on resume, including when the live scanner skipped old rows. */
export async function claudeGoalAvailable(projectDir: string, sessionId: string | null): Promise<boolean> {
    if (!sessionId) return true;
    if (!/^[\w-]+$/.test(sessionId)) return false;
    const stream = createReadStream(join(projectDir, `${sessionId}.jsonl`));
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    let available = true;
    try {
        for await (const line of lines) {
            if (!line.includes('goal_status')) continue;
            const event = parseClaudeGoalStatusTranscriptEvent(JSON.parse(line));
            if (!event || event.sourceSessionId !== sessionId) return false;
            available = event.attachment.met;
        }
        return available;
    } catch {
        // A missing/malformed resume record is not evidence that no goal exists.
        return false;
    } finally {
        lines.close();
        stream.destroy();
    }
}

export async function prepareClaudeAutomaticGoal<T extends ClaudeGoalMessage>(input: T, opts: {
    commands: string[];
    policy: AutomaticGoalPolicy;
    available: () => Promise<boolean>;
    onCommand?: (command: string) => void;
}): Promise<T> {
    if (!input.goalText || !detectAutomaticGoal(input.goalText) || input.mode.permissionMode === 'plan'
        || !opts.commands.some(command => command.replace(/^\//, '') === 'goal')) return input;
    const text = typeof input.message === 'string' ? input.message : input.message.find(block => block.type === 'text')?.text;
    // File inbox notes are also command arguments. Stay within the native
    // length exercised by acceptance; longer turns are delivered unchanged.
    if (!text || text.length > 2000) return input;
    const objective = await opts.policy.claim(input.goalText, { supported: true, available: await opts.available(), permissionMode: input.mode.permissionMode });
    if (!objective) return input;
    // Native /goal keeps the original request and attached files together. The
    // native goal_status sentinel, not this conversion, makes the UI card visible.
    if (typeof input.message === 'string') {
        const command = `/goal ${input.message}`;
        opts.onCommand?.(command);
        return { ...input, message: command };
    }
    let replaced = false;
    const message = input.message.map(block => {
        if (block.type !== 'text' || replaced) return block;
        replaced = true;
        const text = `/goal ${block.text}`;
        opts.onCommand?.(text);
        return { ...block, text };
    });
    return { ...input, message };
}
