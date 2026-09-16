import type { Metadata } from '@/api/types';

/**
 * What a worker is born knowing, carried from the daemon's spawn options to
 * the runner as environment variables, the same road the fork lineage takes.
 * Written into the first metadata the session ever has, so the binding and
 * the duty exist before the engine's first turn — a title set later would
 * blink, and a binding set later would leave the hub's first task unframed.
 */
export const HUB_SESSION_ID_ENV = 'HAPPY_HUB_SESSION_ID';
export const SESSION_TITLE_ENV = 'HAPPY_SESSION_TITLE';

export function workerBirthFromEnv(env: NodeJS.ProcessEnv = process.env): Pick<Metadata, 'orchestration' | 'summary'> {
    const out: Pick<Metadata, 'orchestration' | 'summary'> = {};
    const hub = env[HUB_SESSION_ID_ENV]?.trim();
    if (hub) out.orchestration = { role: 'worker', hub: { sessionId: hub, boundAt: Date.now(), by: 'auto' } };
    const title = env[SESSION_TITLE_ENV]?.trim();
    if (title) out.summary = { text: title.slice(0, 120), updatedAt: Date.now() };
    return out;
}
