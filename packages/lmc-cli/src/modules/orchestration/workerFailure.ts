import { boardOf, boardUpdate } from './board';
import { formatReportEnvelope } from './envelope';
import { isQuotaFailure, type QuotaReporterPort } from './quota';

/** Terminal provider failures must be reported by the runner: a rejected model cannot report itself. */
export function createWorkerFailureReporter(port: QuotaReporterPort) {
    const reported = new Set<string>();
    const inFlight = new Map<string, Promise<void>>();
    return {
        async onFailure(detail: string): Promise<boolean> {
            const orchestration = port.metadata()?.orchestration;
            if (orchestration?.role !== 'worker') return false;
            const hubId = orchestration.hub.sessionId;
            const category = isQuotaFailure(detail) ? 'quota'
                : /model.*(?:not supported|not found|unavailable|does not exist)|unsupported.*model|模型|模型目录/i.test(detail) ? 'configuration'
                : /authentication|unauthorized|not logged in|\b401\b/i.test(detail) ? 'authentication' : 'runtime';
            const brief = detail.replace(/Bearer\s+\S+/gi, 'Bearer [redacted]').replace(/\s+/g, ' ').trim().slice(0, 600);
            const board = boardOf(orchestration);
            const open = board.filter(entry => entry.state === 'dispatched');
            // Already reported/closed tasks must not produce a second generic notice.
            if (!open.length && board.length) return true;
            for (const entry of open.length ? open : [undefined]) {
                const key = JSON.stringify([hubId, orchestration.hub.boundAt, entry?.id, entry?.dispatchId, entry?.attempt]);
                if (reported.has(key)) continue;
                const prior = inFlight.get(key);
                if (prior) { await prior; continue; }
                const delivery = (async () => {
                    const text = entry ? formatReportEnvelope({
                        id: entry.id, attempt: entry.attempt, status: 'blocked',
                        fields: { dispatch: entry.dispatchId,
                            summary: 'The engine failed before completing this task. Configuration delivery was not proof of execution. No automatic retry or budget reset.',
                            blocked: `${category} — ${brief}` },
                    }) : `[notice] worker ${port.selfId} stopped after an engine failure (${category}): ${brief}`;
                    const sent = await port.sendMail(hubId, text);
                    if (!sent.ok) return;
                    reported.add(key);
                    if (reported.size > 256) reported.delete(reported.values().next().value!);
                    const update = boardUpdate(text, hubId, port.now?.() ?? Date.now());
                    if (update) await port.updateMetadata(update).catch(() => undefined);
                })().catch(() => undefined).finally(() => { inFlight.delete(key); });
                inFlight.set(key, delivery);
                await delivery;
            }
            return true;
        },
    };
}
