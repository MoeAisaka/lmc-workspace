import { parseSpecialCommand } from '@/parsers/specialCommands';
import type { PendingAttachment } from '@/utils/MessageQueue2';

type CodexUserTextQueue<T> = {
    push: (message: string, mode: T, attachments?: PendingAttachment[], options?: { key?: string }) => void;
    pushIsolateAndClear: (message: string, mode: T, attachments?: PendingAttachment[], options?: { key?: string }) => void;
};

export function isCodexClearText(text: string): boolean {
    return parseSpecialCommand(text).type === 'clear';
}

export function enqueueCodexUserText<T>(opts: {
    text: string;
    mode: T;
    queue: CodexUserTextQueue<T>;
    attachments?: PendingAttachment[];
    /** The app's localKey, so the queue entry matches the message it shows. */
    key?: string;
}): 'clear' | 'queued' {
    if (isCodexClearText(opts.text)) {
        opts.queue.pushIsolateAndClear(opts.text, opts.mode, opts.attachments, { key: opts.key });
        return 'clear';
    }

    opts.queue.push(opts.text, opts.mode, opts.attachments, { key: opts.key });
    return 'queued';
}
