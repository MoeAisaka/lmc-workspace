import { compareDisplayMessages } from './messageDisplayOrder';
import type { NormalizedMessage } from './typesRaw';
import type { AgentState } from './storageTypes';
import type { Message } from './typesMessage';
import { createReducer, reducer, type ReducerState } from './reducer/reducer';

export type MessageWindowEdge = 'newest' | 'older';
export const WEB_MESSAGE_WINDOW_POLICY = { completedTurnsToKeep: 2 } as const;

export function estimateNormalizedMessageBytes(value: unknown): number {
    const seen = new Set<object>();

    const visit = (current: unknown): number => {
        if (current == null) return 4;
        if (typeof current === 'string') return current.length * 2;
        if (typeof current === 'number') return 8;
        if (typeof current === 'boolean') return 4;
        if (typeof current !== 'object') return 0;
        if (seen.has(current)) return 0;
        seen.add(current);
        if (Array.isArray(current)) {
            return 8 + current.reduce((total, item) => total + visit(item), 0);
        }
        return 16 + Object.values(current).reduce((total, item) => total + visit(item), 0);
    };

    return visit(value);
}

function compareChronologically(a: NormalizedMessage, b: NormalizedMessage): number {
    const sequenceDelta = (a.serverSeq ?? Number.POSITIVE_INFINITY) - (b.serverSeq ?? Number.POSITIVE_INFINITY);
    if (Number.isFinite(sequenceDelta) && sequenceDelta !== 0) return sequenceDelta;
    if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
    return a.id.localeCompare(b.id);
}

/** Keep two completed turns plus any active turn; never truncate payloads.
 * Realtime progress and manual history loads do not evict anything. Only a
 * newly observed main-turn completion advances the resident-history boundary.
 */
export function mergeAndSelectMessageWindow(
    existing: readonly NormalizedMessage[],
    incoming: readonly NormalizedMessage[],
    _edge: MessageWindowEdge,
): {
    messages: NormalizedMessage[];
    estimatedBytes: number;
    evictedIds: string[];
    compactedIds: string[];
} {
    const mergedById = new Map(existing.map(message => [message.id, message]));
    for (const message of incoming) mergedById.set(message.id, message);
    const merged = [...mergedById.values()].sort(compareChronologically);
    const existingIds = new Set(existing.map(message => message.id));
    const latestExisting = [...existing].sort(compareChronologically).at(-1);
    const completed: number[] = [];
    const completedTurnIds = new Set<string>();
    let hasContent = false;
    let newCompletion = false;
    for (let index = 0; index < merged.length; index++) {
        const message = merged[index];
        if (message.isSidechain) continue;
        if (message.role === 'event' && message.content.type === 'ready') {
            if (!hasContent || (message.turnId && completedTurnIds.has(message.turnId))) continue;
            completed.push(index);
            if (message.turnId) completedTurnIds.add(message.turnId);
            hasContent = false;
            if (!existingIds.has(message.id) && (!latestExisting || compareChronologically(message, latestExisting) > 0)) newCompletion = true;
        } else if (message.role === 'user' || (message.role === 'agent' && message.content.length > 0)) {
            hasContent = true;
        }
    }
    const cutoff = newCompletion && completed.length > WEB_MESSAGE_WINDOW_POLICY.completedTurnsToKeep ? completed[completed.length - WEB_MESSAGE_WINDOW_POLICY.completedTurnsToKeep - 1] + 1 : 0;
    const messages = merged.slice(cutoff);
    return {
        messages,
        estimatedBytes: messages.reduce((total, message) => total + estimateNormalizedMessageBytes(message), 0),
        evictedIds: merged.slice(0, cutoff).map(message => message.id),
        compactedIds: [],
    };
}

/**
 * Structural equality over the plain-data object graphs the reducer emits.
 * Used to keep the previous derived Message object (and with it every row
 * component's memo identity) when a full rebuild reproduces identical content.
 */
export function derivedMessagesEqual(a: unknown, b: unknown): boolean {
    if (Object.is(a, b)) return true;
    if (typeof a !== typeof b) return false;
    if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    if (Array.isArray(a) && Array.isArray(b)) {
        if (a.length !== b.length) return false;
        for (let index = 0; index < a.length; index++) {
            if (!derivedMessagesEqual(a[index], b[index])) return false;
        }
        return true;
    }
    const aKeys = Object.keys(a as Record<string, unknown>);
    const bKeys = Object.keys(b as Record<string, unknown>);
    if (aKeys.length !== bKeys.length) return false;
    for (const key of aKeys) {
        if (!Object.prototype.hasOwnProperty.call(b, key)) return false;
        if (!derivedMessagesEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key])) return false;
    }
    return true;
}

export function rebuildDerivedMessageWindow(
    sourceMessages: readonly NormalizedMessage[],
    agentState?: AgentState | null,
): {
    reducerState: ReducerState;
    messages: Message[];
    messagesMap: Record<string, Message>;
    todos: ReturnType<typeof reducer>['todos'];
    hasReadyEvent: boolean;
} {
    const reducerState = createReducer();
    const reducerResult = reducer(reducerState, [...sourceMessages].sort(compareChronologically), agentState);
    const messagesMap: Record<string, Message> = {};
    for (const message of reducerResult.messages) {
        messagesMap[message.id] = message;
    }
    return {
        reducerState,
        messages: Object.values(messagesMap).sort(compareDisplayMessages),
        messagesMap,
        todos: reducerResult.todos,
        hasReadyEvent: reducerResult.hasReadyEvent === true,
    };
}
