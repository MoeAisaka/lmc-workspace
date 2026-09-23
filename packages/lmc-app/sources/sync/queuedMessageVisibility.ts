import type { Message } from './typesMessage';

// Existing Agents persist this success receipt as a generic event. The queue
// already acknowledges acceptance by removing the item; replaying these receipts
// in the transcript adds permanent, repeated rows. Match only this known event,
// never user/assistant text or delivery warnings. Keep the stored history intact.
const STEER_ACCEPTED_RECEIPT = 'Codex 已接收补充回复，将在当前工作中处理。';

/** Queue keys are the sender's localId, not prompt text or a derived row id.
 * Filter before turn grouping so pending input cannot split the active turn.
 * Keep the stored transcript intact: leaving the queue makes the row visible.
 */
export function visibleTranscriptMessages(messages: Message[], queue?: readonly { key: string }[] | null): Message[] {
    const pending = new Set(queue?.map(item => item.key));
    const visible = messages.filter(message => {
        if (message.kind === 'agent-event' && message.event.type === 'message'
            && message.event.message === STEER_ACCEPTED_RECEIPT) return false;
        return message.kind !== 'user-text' || !pending.has(message.localId ?? message.id);
    });
    return visible.length === messages.length ? messages : visible;
}
