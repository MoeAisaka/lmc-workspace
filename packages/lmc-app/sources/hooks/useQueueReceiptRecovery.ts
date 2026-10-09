import * as React from 'react';
import { useIsFocused } from '@react-navigation/native';
import type { Message } from '@/sync/typesMessage';
import type { QueuedPrompt } from '@/sync/turnQueue';
import { queueReceiptRecoveryTargets } from '@/sync/queueReceiptRecovery';
import { sync } from '@/sync/sync';

/** Repair missed durable receipts without resending, withdrawing or guessing delivery. */
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
}
