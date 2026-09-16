import type { Metadata } from '@/api/types';
import { boardOf, boardUpdate } from './board';
import { formatReportEnvelope } from './envelope';

/**
 * A worker that runs out of quota cannot say so itself: the model that would
 * write the report is the thing that has just been refused. So the runner
 * says it. When the engine's turn fails for a quota or rate-limit reason and
 * this session is a worker, every task still dispatched to it is reported
 * back to the hub as `blocked: quota …`, once, and the hub decides — hand the
 * task to another worker, wait, or ask the owner. Nothing is retried here:
 * that was the owner's rule, and a retry against a limit is what burns the
 * remaining quota.
 */
export const QUOTA_PATTERN = /usage limit|rate[ _-]?limit|too many requests|\b429\b|quota|insufficient[_ ]?(?:quota|credits|balance)|limit reached|out of credits|credit balance|billing/i;

export function isQuotaFailure(detail: string): boolean {
    return QUOTA_PATTERN.test(detail);
}

export interface QuotaReporterPort {
    selfId: string;
    metadata: () => Metadata | null;
    updateMetadata: (update: (metadata: Metadata) => Metadata) => Promise<void>;
    sendMail: (sessionId: string, text: string) => Promise<{ ok: true } | { ok: false; error: string }>;
    now?: () => number;
}

/** How long one task stays reported before another failure re-reports it. */
export const QUOTA_REPORT_COOLDOWN_MS = 10 * 60_000;

export function createQuotaReporter(port: QuotaReporterPort) {
    const reported = new Map<string, number>();
    return {
        /** Returns true when the failure was a quota failure this session had to report. */
        async onFailure(detail: string): Promise<boolean> {
            if (!isQuotaFailure(detail)) return false;
            const orchestration = port.metadata()?.orchestration;
            if (orchestration?.role !== 'worker') return false;
            const hubId = orchestration.hub.sessionId;
            const now = port.now?.() ?? Date.now();
            const brief = detail.replace(/\s+/g, ' ').trim().slice(0, 300);
            const recentlyReported = (id: string) => reported.has(id) && now - reported.get(id)! < QUOTA_REPORT_COOLDOWN_MS;
            const open = boardOf(orchestration).filter((entry) => entry.state === 'dispatched');
            if (open.length === 0) {
                if (!recentlyReported('*')) {
                    await port.sendMail(hubId, `[notice] worker ${port.selfId} hit an engine quota or rate limit and has stopped: ${brief}`);
                    reported.set('*', now);
                }
                return true;
            }
            for (const entry of open) {
                if (recentlyReported(entry.id)) continue;
                const text = formatReportEnvelope({
                    id: entry.id, attempt: entry.attempt, status: 'blocked',
                    fields: { dispatch: entry.dispatchId, summary: 'Stopped by the engine\'s quota or rate limit before finishing; not retrying on my own.', blocked: `quota — ${brief}` },
                });
                const sent = await port.sendMail(hubId, text);
                if (!sent.ok) continue;
                reported.set(entry.id, now);
                const update = boardUpdate(text, hubId, now);
                if (update) await port.updateMetadata(update).catch(() => undefined);
            }
            return true;
        },
    };
}

/** Whether a Claude SDK message reports a failed turn, and how. */
export function claudeTurnFailure(message: unknown): string | null {
    if (!message || typeof message !== 'object') return null;
    const m = message as Record<string, unknown>;
    if (m.type === 'result' && m.is_error) return typeof m.result === 'string' ? m.result : JSON.stringify(m.errors ?? m.subtype ?? 'error');
    if (m.type === 'assistant') {
        if (typeof m.error === 'string' && m.error !== 'authentication_failed') return m.error;
        const inner = m.message as { content?: unknown } | undefined;
        const blocks = Array.isArray(inner?.content) ? inner!.content as { type?: string; text?: string }[] : [];
        const text = blocks.filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text as string).join('\n');
        if (/usage limit reached|rate limit/i.test(text)) return text.slice(0, 300);
    }
    return null;
}
