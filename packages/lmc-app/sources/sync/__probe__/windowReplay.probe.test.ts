// Replays a real decrypted transcript through the web message window, one
// message at a time as realtime delivery would, and reports whether the
// resident window ever shrinks. Not a unit test of a rule — a probe of the
// rule against production data. Skipped unless LMC_REPLAY_DUMP points at a
// dump produced by scripts/switch-lab-style decryption.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { normalizeRawMessage } from '../typesRaw';
import { mergeAndSelectMessageWindow, estimateNormalizedMessageBytes } from '../messageWindow';

const dumpPath = process.env.LMC_REPLAY_DUMP;

describe.skipIf(!dumpPath)('message window replay', () => {
    it('reports resident window growth over a real transcript', () => {
        const rows: Array<{ id: string; seq: number; createdAt: number; content: any }> = JSON.parse(readFileSync(dumpPath!, 'utf8'));
        let existing: any[] = [];
        let readyCount = 0, evictions = 0, evictedTotal = 0, peak = 0, dropped = 0;
        const samples: string[] = [];
        for (const [index, row] of rows.entries()) {
            if (!row.content) { dropped++; continue; }
            const normalized = normalizeRawMessage(row.id, null, row.createdAt, row.content);
            if (!normalized) { dropped++; continue; }
            (normalized as any).serverSeq = row.seq;
            if (normalized.role === 'event' && (normalized as any).content?.type === 'ready') readyCount++;
            const result = mergeAndSelectMessageWindow(existing, [normalized], 'latest' as any);
            if (result.evictedIds.length) { evictions++; evictedTotal += result.evictedIds.length; }
            existing = result.messages;
            peak = Math.max(peak, existing.length);
            if (index % Math.max(1, Math.floor(rows.length / 12)) === 0 || index === rows.length - 1) {
                const bytes = existing.reduce((t, m) => t + estimateNormalizedMessageBytes(m), 0);
                samples.push(`#${index + 1} seq=${row.seq} resident=${existing.length} ~${Math.round(bytes / 1024)}KB ready=${readyCount} evictions=${evictions}`);
            }
        }
        // eslint-disable-next-line no-console
        console.log(['REPLAY', ...samples, `dropped(null-normalized)=${dropped} peakResident=${peak} evictedTotal=${evictedTotal}`].join('\n'));
        expect(rows.length).toBeGreaterThan(0);
    });
});
