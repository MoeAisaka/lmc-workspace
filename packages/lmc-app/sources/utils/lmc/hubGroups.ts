import type { Session } from '@/sync/storageTypes';
import { isArchivedForList } from './deviceEngineGroups';
import { compareSessionCreation, orderSessions } from '@/sync/sessionOrder';

/**
 * The hub-and-workers layer of the session list.
 *
 * A hub and its workers form one group at the top of the list, whatever
 * devices they run on — the device is a suffix on the row, not the grouping.
 * Everything not in such a group falls through to the device → engine
 * grouping below. A binding counts only when both sides record it, so a
 * worker whose hub does not list it (a half-finished bind) stays where it
 * physically is rather than appearing under a hub that does not know it.
 */
export interface LmcHubGroup {
    hub: Session;
    workers: Session[];
}

/**
 * @param order Saved hub display order (session ids), from
 * `sessionProjectOrder['lmc:hubs']`. Hubs in it sort first, in that order;
 * every other hub keeps falling in behind by createdAt, same as with no
 * saved order at all.
 */
export function splitHubGroups(sessions: Session[], order?: readonly string[] | null): { hubs: LmcHubGroup[]; rest: Session[] } {
    const byId = new Map(sessions.map((session) => [session.id, session]));
    const taken = new Set<string>();
    const hubs: LmcHubGroup[] = [];
    for (const session of sessions) {
        const orchestration = session.metadata?.orchestration;
        if (orchestration?.role !== 'hub' || isArchivedForList(session) || session.metadata?.isSideChat) continue;
        const workers = orchestration.workers
            .map((binding) => byId.get(binding.sessionId))
            .filter((worker): worker is Session => {
                const own = worker?.metadata?.orchestration;
                return !!worker && own?.role === 'worker' && own.hub.sessionId === session.id && !isArchivedForList(worker);
            })
            // Oldest first, like every other group: the order says when work
            // started; the user reorders by dragging.
            .sort(compareSessionCreation);
        hubs.push({ hub: session, workers });
        taken.add(session.id);
        for (const worker of workers) taken.add(worker.id);
    }
    // Oldest hub first, the same rule as every other group in the list — then
    // the user's own drag order, when there is one, wins over it. `orderSessions`
    // sorts stably, so a hub missing from `order` keeps its createdAt place
    // among the other unordered hubs rather than jumping to the front.
    hubs.sort((a, b) => compareSessionCreation(a.hub, b.hub));
    const orderedIds = orderSessions(hubs.map((g) => g.hub), order).map((h) => h.id);
    const byHubId = new Map(hubs.map((g) => [g.hub.id, g]));
    const orderedHubs = orderedIds.map((id) => byHubId.get(id)!);
    return { hubs: orderedHubs, rest: sessions.filter((session) => !taken.has(session.id)) };
}

/** Whether a session is bound as somebody's worker, on both sides. */
export function boundHubId(session: Session, all: Map<string, Session>): string | null {
    const own = session.metadata?.orchestration;
    if (own?.role !== 'worker') return null;
    const hub = all.get(own.hub.sessionId)?.metadata?.orchestration;
    return hub?.role === 'hub' && hub.workers.some((w) => w.sessionId === session.id) ? own.hub.sessionId : null;
}
