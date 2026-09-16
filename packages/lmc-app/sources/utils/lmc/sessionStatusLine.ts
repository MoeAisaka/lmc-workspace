import type { AgentState, Session } from '@/sync/storageTypes';
import { resolveSessionState, type SessionState } from '@/sync/sessionState';
import { selectPendingCommunications } from '@/sync/agentCommunications';
import { resolveVisibleAgentGoalStatus } from '@/components/agentGoalStatus';
import { getSessionActivityAt } from '@/utils/sessionActivity';
import { t } from '@/text';

/**
 * The four visual tones of the approved LMC status ring. Permission requests
 * and questions both need the user, so they share one tone; the ring, the
 * second line and the trailing pill all key off this single value.
 */
export type LmcSessionTone = 'attention' | 'working' | 'done' | 'idle' | 'offline';

export interface LmcSessionStatusLine {
    tone: LmcSessionTone;
    /** Second line under the title: what the agent is doing or waiting for. */
    text: string;
    /** Trailing column: elapsed time while working, otherwise last activity. */
    trailing: string;
    /** Whether the trailing column should be the reply pill instead of text. */
    needsReply: boolean;
}

export function resolveLmcSessionTone(state: SessionState): LmcSessionTone {
    switch (state) {
        case 'permission_required':
        case 'input_required':
            return 'attention';
        case 'thinking':
            return 'working';
        case 'waiting':
            return 'idle';
        default:
            return 'offline';
    }
}

const TOOL_VERB_KEYS: Record<string, 'runCommand' | 'editFile' | 'writeFile' | 'editNotebook' | 'readFile' | 'fetchUrl' | 'webSearch' | 'startSubtask' | 'exitPlanMode'> = {
    Bash: 'runCommand',
    shell: 'runCommand',
    exec_command: 'runCommand',
    Edit: 'editFile',
    MultiEdit: 'editFile',
    Write: 'writeFile',
    apply_patch: 'editFile',
    NotebookEdit: 'editNotebook',
    Read: 'readFile',
    WebFetch: 'fetchUrl',
    WebSearch: 'webSearch',
    Task: 'startSubtask',
    Agent: 'startSubtask',
    exit_plan_mode: 'exitPlanMode',
    ExitPlanMode: 'exitPlanMode',
};

function toolVerb(tool: string): string {
    const key = TOOL_VERB_KEYS[tool];
    return key ? t(`lmc.status.${key}` as 'lmc.status.runCommand') : tool;
}

function firstPendingRequest(agentState: AgentState | null | undefined) {
    const entries = Object.entries(agentState?.requests ?? {});
    if (entries.length === 0) return null;
    entries.sort((a, b) => (a[1].createdAt ?? 0) - (b[1].createdAt ?? 0));
    return entries[0][1];
}

function compact(text: string, max: number): string {
    const single = text.replace(/\s+/g, ' ').trim();
    return single.length > max ? `${single.slice(0, max - 1)}…` : single;
}

/** "Allow running npm run build" — the command when there is one, else the verb. */
export function describePermissionRequest(request: { tool: string; arguments?: any } | null): string {
    if (!request) return t('lmc.status.awaitingReply');
    const verb = toolVerb(request.tool);
    const args = request.arguments ?? {};
    const command = typeof args.command === 'string' ? args.command
        : Array.isArray(args.command) ? args.command.join(' ')
        : typeof args.cmd === 'string' ? args.cmd
        : null;
    if (command) return t('lmc.status.permissionAllowCommand', { command: compact(command, 40) });
    const path = typeof args.file_path === 'string' ? args.file_path
        : typeof args.path === 'string' ? args.path
        : typeof args.notebook_path === 'string' ? args.notebook_path
        : null;
    if (path) {
        const name = path.split(/[/\\]/).filter(Boolean).pop() ?? path;
        return t('lmc.status.permissionAllowTarget', { verb, target: compact(name, 32) });
    }
    return t('lmc.status.permissionAllow', { verb });
}

export function formatElapsed(ms: number): string {
    const seconds = Math.max(0, Math.floor(ms / 1000));
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h`;
    return `${Math.floor(hours / 24)}d`;
}

/** Relative time for the trailing column: just now / 5m ago / yesterday / 9/6. */
export function formatRelativeShort(timestamp: number, now: number): string {
    const age = now - timestamp;
    const minute = 60_000;
    const hour = 60 * minute;
    const day = 24 * hour;
    if (age < minute) return t('lmc.status.justNow');
    if (age < hour) return t('lmc.status.minutesAgo', { count: Math.floor(age / minute) });
    if (age < day) return t('lmc.status.hoursAgo', { count: Math.floor(age / hour) });
    const today = new Date(now); today.setHours(0, 0, 0, 0);
    const then = new Date(timestamp); then.setHours(0, 0, 0, 0);
    const days = Math.round((today.getTime() - then.getTime()) / day);
    if (days <= 1) return t('lmc.status.yesterday');
    if (days < 7) return t('lmc.status.daysAgo', { count: days });
    const date = new Date(timestamp);
    return `${date.getMonth() + 1}/${date.getDate()}`;
}

export function describeLmcSessionStatus(session: Session, now: number = Date.now()): LmcSessionStatusLine {
    const isOnline = session.presence === 'online';
    const state = resolveSessionState({ agentState: session.agentState, thinking: session.thinking, isOnline });
    const tone = resolveLmcSessionTone(state);
    const lastActivity = getSessionActivityAt(session);

    if (state === 'permission_required') {
        return { tone, needsReply: true, trailing: formatRelativeShort(lastActivity, now), text: describePermissionRequest(firstPendingRequest(session.agentState)) };
    }
    if (state === 'input_required') {
        const pending = selectPendingCommunications(session.agentState ?? null)[0];
        const question = pending && pending.kind === 'form' ? pending.questions[0]?.header || pending.questions[0]?.question : pending && pending.kind === 'unsupported' ? pending.title : null;
        return { tone, needsReply: true, trailing: formatRelativeShort(lastActivity, now), text: question ? t('lmc.status.answerWith', { question: compact(String(question), 40) }) : t('lmc.status.awaitingAnswer') };
    }
    if (state === 'thinking') {
        const goal = resolveVisibleAgentGoalStatus(session);
        const since = session.thinkingAt || session.agentState?.runtime?.updatedAt || lastActivity;
        const elapsed = formatElapsed(now - since);
        return { tone, needsReply: false, trailing: elapsed, text: goal ? t('lmc.status.goalWithElapsed', { goal: compact(goal.text, 40), elapsed }) : t('lmc.status.working', { elapsed }) };
    }
    if (state === 'waiting') {
        return { tone, needsReply: false, trailing: formatRelativeShort(lastActivity, now), text: t('lmc.status.idle', { when: formatRelativeShort(lastActivity, now) }) };
    }
    const seen = typeof session.presence === 'number' ? session.presence : session.activeAt;
    return { tone, needsReply: false, trailing: formatRelativeShort(seen, now), text: t('lmc.status.disconnected', { when: formatRelativeShort(seen, now) }) };
}
