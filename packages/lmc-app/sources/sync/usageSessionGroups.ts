import { addUsage, emptyUsage, usageTotal, type UsageTokens } from 'lmc-wire';
import type { UsageGroup } from './usageAnalytics';

type UsageSession = {
    id: string;
    metadata?: {
        orchestration?: { role: 'hub'; workers: { sessionId: string }[] }
            | { role: 'worker'; hub: { sessionId: string } };
    } | null;
};
export type UsageSessionRole = { role: 'hub' | 'standalone' | 'unassigned' }
    | { role: 'worker'; hubId: string };

/** Same reciprocal binding rule as the sidebar. Archived usage must still count. */
export function usageSessionRoles(sessions: readonly UsageSession[]): Record<string, UsageSessionRole> {
    const byId = new Map(sessions.map(s => [s.id, s]));
    return Object.fromEntries(sessions.map(s => {
        const own = s.metadata?.orchestration;
        if (own?.role === 'hub') return [s.id, { role: 'hub' }];
        if (own?.role === 'worker') {
            const hub = byId.get(own.hub.sessionId)?.metadata?.orchestration;
            return [s.id, hub?.role === 'hub' && hub.workers.some(w => w.sessionId === s.id)
                ? { role: 'worker', hubId: own.hub.sessionId } : { role: 'unassigned' }];
        }
        return [s.id, { role: s.metadata ? 'standalone' : 'unassigned' }];
    }));
}

export type UsageHubGroup = {
    id: string;
    hubId: string | null;
    tokens: UsageTokens;
    ownTokens: UsageTokens;
    workerTokens: UsageTokens;
    sessions: UsageGroup[];
};

/** Input is the already deduplicated, period/engine/device/session-filtered usage. */
export function groupUsageByHub(sessions: UsageGroup[], roles: Record<string, UsageSessionRole>) {
    const groups = new Map<string, UsageHubGroup>();
    const totals = { hubs: emptyUsage(), workers: emptyUsage(), other: emptyUsage() };
    for (const session of sessions) {
        const role = roles[session.id];
        const hubId = role?.role === 'hub' ? session.id : role?.role === 'worker' ? role.hubId : null;
        const id = hubId === null ? 'other' : `hub:${hubId}`;
        const group = groups.get(id) ?? { id, hubId, tokens: emptyUsage(), ownTokens: emptyUsage(), workerTokens: emptyUsage(), sessions: [] };
        group.tokens = addUsage(group.tokens, session.tokens);
        group.sessions.push(session);
        if (role?.role === 'hub') {
            group.ownTokens = addUsage(group.ownTokens, session.tokens);
            totals.hubs = addUsage(totals.hubs, session.tokens);
        } else if (role?.role === 'worker') {
            group.workerTokens = addUsage(group.workerTokens, session.tokens);
            totals.workers = addUsage(totals.workers, session.tokens);
        } else totals.other = addUsage(totals.other, session.tokens);
        groups.set(id, group);
    }
    const sorted = [...groups.values()].sort((a, b) => usageTotal(b.tokens) - usageTotal(a.tokens) || a.id.localeCompare(b.id));
    for (const group of sorted) group.sessions.sort((a, b) => {
        // Keep the hub's own row first, then its workers by observed usage.
        if (a.id === group.hubId) return -1;
        if (b.id === group.hubId) return 1;
        return usageTotal(b.tokens) - usageTotal(a.tokens) || a.id.localeCompare(b.id);
    });
    return { groups: sorted, totals };
}
