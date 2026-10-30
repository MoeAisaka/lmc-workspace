import * as React from 'react';
import { useIsFocused } from '@react-navigation/native';
import type { Message } from '@/sync/typesMessage';
import type { QueuedPrompt } from '@/sync/turnQueue';
import {
    missingQueuedPromptTargets,
    queueReceiptRecoveryTargets,
    type MissingQueuedPromptTarget,
} from '@/sync/queueReceiptRecovery';
import { sync } from '@/sync/sync';

const MAX_PROMPT_RECOVERY_PAGES = 8;

type PromptSearchState = {
    sessionId: string;
    floorByKey: Map<string, number>;
    pagesByKey: Map<string, number>;
    exhaustedKeys: Set<string>;
};

/** Repair missed durable receipts or unloaded queued prompts without resending, withdrawing or guessing delivery. */
export function useQueueReceiptRecovery(sessionId: string, messages: Message[], queue?: readonly QueuedPrompt[] | null) {
    const focused = useIsFocused();
    const signature = JSON.stringify(queueReceiptRecoveryTargets(messages, queue));
    React.useEffect(() => {
        const targets = JSON.parse(signature) as { key: string; seq: number }[];
        if (!focused || !targets.length) return;
        let cancelled = false;
        let cursor = targets[0].seq;
        let timer: ReturnType<typeof setTimeout>;
        const repair = async () => {
            let delay = 30000;
            try {
                const result = await sync.recoverQueueReceiptPage(sessionId, targets.map(item => item.key), cursor);
                cursor = result.nextSeq;
                if (result.hasMore) delay = 1000;
            } catch {
                // Keep the row pending, retain the cursor and retry after reconnect.
            }
            if (!cancelled) timer = setTimeout(repair, delay);
        };
        // Let normal push delivery win; one bounded read per tick, only in the open chat.
        timer = setTimeout(repair, 15000);
        return () => { cancelled = true; clearTimeout(timer); };
    }, [sessionId, signature, focused]);

    const searchStateRef = React.useRef<PromptSearchState | null>(null);
    if (!searchStateRef.current || searchStateRef.current.sessionId !== sessionId) {
        searchStateRef.current = {
            sessionId,
            floorByKey: new Map(),
            pagesByKey: new Map(),
            exhaustedKeys: new Set(),
        };
    }

    const promptTargetsSignature = JSON.stringify(
        missingQueuedPromptTargets(messages, queue, sync.getSessionOldestSeq(sessionId)),
    );
    React.useEffect(() => {
        const state = searchStateRef.current;
        const allTargets = JSON.parse(promptTargetsSignature) as MissingQueuedPromptTarget[];
        const initialActive = allTargets.filter(item => !state?.exhaustedKeys.has(item.key));
        if (!focused || !state || !initialActive.length) return;
        let cancelled = false;
        let timer: ReturnType<typeof setTimeout>;

        const repairPrompts = async () => {
            const active = allTargets.filter(item => !state.exhaustedKeys.has(item.key));
            if (!active.length || cancelled) return;
            const liveOldestSeq = sync.getSessionOldestSeq(sessionId);
            let cursor = 0;
            for (const item of active) {
                const knownFloor = state.floorByKey.get(item.key) ?? item.beforeSeq;
                const bounded = liveOldestSeq !== undefined && liveOldestSeq > 1
                    ? Math.min(knownFloor, liveOldestSeq)
                    : knownFloor;
                if (bounded > cursor) cursor = bounded;
            }
            if (cursor <= 1) {
                for (const item of active) state.exhaustedKeys.add(item.key);
                return;
            }
            const batch = active.filter(item => {
                const knownFloor = state.floorByKey.get(item.key) ?? item.beforeSeq;
                const bounded = liveOldestSeq !== undefined && liveOldestSeq > 1
                    ? Math.min(knownFloor, liveOldestSeq)
                    : knownFloor;
                return bounded >= cursor - 500;
            });
            const batchKeys = (batch.length > 0 ? batch : active).map(item => item.key);
            try {
                const result = await sync.recoverQueuedPromptsPage(sessionId, batchKeys, cursor);
                for (const key of result.foundKeys) {
                    state.exhaustedKeys.add(key);
                }
                for (const key of batchKeys) {
                    if (state.exhaustedKeys.has(key)) continue;
                    const pages = (state.pagesByKey.get(key) ?? 0) + 1;
                    state.pagesByKey.set(key, pages);
                    state.floorByKey.set(key, result.nextBeforeSeq);
                    if (!result.hasMore || result.nextBeforeSeq <= 1 || pages >= MAX_PROMPT_RECOVERY_PAGES) {
                        state.exhaustedKeys.add(key);
                    }
                }
                if (!cancelled && allTargets.some(item => !state.exhaustedKeys.has(item.key))) {
                    timer = setTimeout(repairPrompts, 100);
                }
            } catch {
                if (!cancelled) timer = setTimeout(repairPrompts, 5000);
            }
        };

        // Durable `queue-released` receipts are guaranteed to point to earlier
        // history, so recover immediately on refresh; live queue entries wait a
        // brief moment so in-flight WebSocket message delivery wins.
        const initialDelay = initialActive.some(item => item.kind === 'released') ? 0 : 1000;
        timer = setTimeout(repairPrompts, initialDelay);
        return () => {
            cancelled = true;
            clearTimeout(timer);
        };
    }, [sessionId, promptTargetsSignature, focused]);
}
