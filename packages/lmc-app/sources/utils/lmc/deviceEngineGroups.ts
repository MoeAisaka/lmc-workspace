import type { Machine, Session } from '@/sync/storageTypes';
import { resolveSessionState } from '@/sync/sessionState';
import { isRigMetadata } from '@/sync/rig';
import { getRepoPath, isWorktreePath } from '@/utils/worktreePaths';
import { t } from '@/text';
import { compareSessionCreation, compareStableIds } from '@/sync/sessionOrder';

/**
 * The approved list structure: device → engine → session. Status never forms
 * a group of its own; it only colours the row. Archived sessions are excluded
 * unless asked for, and side chats never appear.
 */
export type LmcEngineKey = 'claude' | 'codex' | 'other';

export interface LmcEngineGroup {
    key: LmcEngineKey;
    label: string;
    sessions: Session[];
}

export interface LmcDeviceGroup {
    machineId: string | null;
    name: string;
    online: boolean;
    agentVersion: string | null;
    attentionCount: number;
    engines: LmcEngineGroup[];
}

const ENGINE_ORDER: LmcEngineKey[] = ['claude', 'codex', 'other'];
const ENGINE_LABEL: Record<LmcEngineKey, string> = { claude: 'Claude', codex: 'Codex', other: t('lmc.common.otherEngine') };

export function engineKeyForSession(session: Session): LmcEngineKey {
    const flavor = session.metadata?.flavor;
    if (flavor === 'claude' || flavor === 'codex') return flavor;
    return 'other';
}

export function machineDisplayName(machine: Machine | undefined, fallback: string): string {
    return machine?.metadata?.displayName ?? machine?.metadata?.host ?? fallback;
}

export function machineAgentVersion(machine: Machine | undefined): string | null {
    return machine?.daemonState?.startedWithCliVersion ?? machine?.metadata?.happyCliVersion ?? null;
}

/**
 * Same rule as the storage list: explicitly archived, or a plain CLI session
 * whose process is gone. Rig sessions that merely lost their socket stay live.
 */
export function isArchivedForList(session: Session): boolean {
    return session.metadata?.lifecycleState === 'archived'
        || (!isRigMetadata(session.metadata) && !session.active);
}

/** Archived sessions, newest first, for the collapsed section under the device groups. */
export function collectArchivedSessions(sessions: Session[]): Session[] {
    // lastMessageSentAt is local to the sending device. Only shared fields
    // can determine the archive order consistently on phone and desktop.
    const activityAt = (session: Session) => session.metadata?.lastMeaningfulMessageAt ?? session.createdAt;
    return sessions
        .filter((s) => !s.metadata?.isSideChat && isArchivedForList(s))
        .sort((a, b) => activityAt(b) - activityAt(a) || compareStableIds(a.id, b.id));
}

export function sessionNeedsReply(session: Session): boolean {
    const state = resolveSessionState({ agentState: session.agentState, thinking: session.thinking, isOnline: session.presence === 'online' });
    return state === 'permission_required' || state === 'input_required';
}

/**
 * The project-group id the sidebar cards used, so custom project avatars keep
 * pointing at the same `projectAvatarOverrides` entry after the redesign.
 * Rig sessions with a native project use its id; everything else is keyed by
 * machine + repository path under the same 'rig' / 'happy' prefix as before.
 */
export function projectGroupIdForSession(session: Session): string {
    const meta = session.metadata;
    if (isRigMetadata(meta) && meta?.project?.id) return meta.project.id;
    const path = meta?.path?.trim() || '';
    const repoPath = isWorktreePath(path) ? getRepoPath(path) : path;
    return `${isRigMetadata(meta) ? 'rig' : 'happy'}:${JSON.stringify([meta?.machineId ?? null, repoPath])}`;
}

export function buildDeviceEngineGroups(
    sessions: Session[],
    machines: Machine[],
    options: { includeArchived?: boolean; unknownDeviceLabel?: string; hideIdleOfflineDevices?: boolean } = {},
): LmcDeviceGroup[] {
    const byMachine = new Map<string, Machine>(machines.map((m) => [m.id, m]));
    const buckets = new Map<string | null, Map<LmcEngineKey, Session[]>>();
    for (const session of sessions) {
        if (session.metadata?.isSideChat) continue;
        if (!options.includeArchived && isArchivedForList(session)) continue;
        const machineId = session.metadata?.machineId ?? null;
        const engines = buckets.get(machineId) ?? new Map<LmcEngineKey, Session[]>();
        const key = engineKeyForSession(session);
        engines.set(key, [...(engines.get(key) ?? []), session]);
        buckets.set(machineId, engines);
    }
    // Devices the user knows about but that have no visible sessions still get
    // a row, so a freshly paired machine is discoverable from the drawer.
    for (const machine of machines) if (!buckets.has(machine.id)) buckets.set(machine.id, new Map());

    const groups: LmcDeviceGroup[] = [];
    for (const [machineId, engines] of buckets) {
        const machine = machineId ? byMachine.get(machineId) : undefined;
        const engineGroups: LmcEngineGroup[] = ENGINE_ORDER
            .filter((key) => (engines.get(key)?.length ?? 0) > 0)
            .map((key) => ({
                key,
                label: ENGINE_LABEL[key],
                // Oldest first, never by activity: the list is the user's to
                // order by dragging, and a session that starts working must not
                // jump the queue. Rows with no saved position land at the end,
                // which is where a newly created session belongs anyway.
                sessions: [...engines.get(key)!].sort(compareSessionCreation),
            }));
        const attentionCount = engineGroups.reduce((n, g) => n + g.sessions.filter(sessionNeedsReply).length, 0);
        groups.push({
            machineId,
            name: machineId ? machineDisplayName(machine, machineId.slice(0, 8)) : (options.unknownDeviceLabel ?? t('lmc.common.unknownDevice')),
            online: machine ? machine.active : false,
            agentVersion: machineAgentVersion(machine),
            attentionCount,
            engines: engineGroups,
        });
    }
    // A machine that is offline and has nothing to show is a retired device,
    // not a group; it stays reachable from settings but leaves the list.
    const visible = options.hideIdleOfflineDevices === false
        ? groups
        : groups.filter((g) => g.online || g.engines.length > 0);
    // By name alone. Sorting on presence or on how many sessions want a reply
    // made devices trade places while you were reading them.
    // Pin collation so a phone's language cannot change the device order.
    return visible.sort((a, b) => a.name.localeCompare(b.name, 'en') || compareStableIds(a.machineId ?? '', b.machineId ?? ''));
}

/**
 * A device's sessions as one list, for the layout that does not nest them
 * under their engine. Merged by creation time rather than engine-major, so
 * the order says when work started and nothing else — the same rule each
 * engine group already follows within itself.
 */
export function flattenDeviceSessions(group: LmcDeviceGroup): Session[] {
    return group.engines
        .flatMap((engine) => engine.sessions)
        .sort(compareSessionCreation);
}
