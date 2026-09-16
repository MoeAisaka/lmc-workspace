import type { BoardEntry } from '@/sync/storageTypes';
import type { LmcSessionTone } from '@/utils/lmc/sessionStatusLine';
import { isClosedState } from './orchestrationTone';

/**
 * Two marks that used to be one.
 *
 * A row carries a *session* state — is this agent waiting on me, working, or
 * idle — and, when it is a hub's worker, a *task* state coming off the hub's
 * board. They answer different questions and they are not in sync: a task the
 * hub rejected stays open on the board until someone dispatches another
 * attempt, while the session itself may be idle, working, or gone.
 *
 * The old row multiplied the two together, so an unsettled task painted the
 * session ring, the row background and the title orange for as long as the
 * entry sat there — the node looked like it was waiting for an approval it had
 * never asked for. Keep them apart: the session mark says what the session is
 * doing, the task rows say what its tasks are doing.
 */

/**
 * The task-layer mark: in progress, settled, or needs a person.
 *
 * `rejected` / `blocked` / `failed` are not closed states (see CLOSED_STATES),
 * and that is deliberate — they are work someone still has to pick up. This is
 * the mark the task rows draw, and it stays exactly as it was.
 */
export function taskRowTone(entry: Pick<BoardEntry, 'state'>): 'working' | 'done' | 'attention' {
    if (entry.state === 'dispatched') return 'working';
    return isClosedState(entry.state) ? 'done' : 'attention';
}

/** Whether any of a worker's tasks is waiting on a person. Task layer only. */
export function hasTaskAttention(tasks: readonly Pick<BoardEntry, 'state'>[]): boolean {
    return tasks.some((entry) => taskRowTone(entry) === 'attention');
}

/**
 * The session-layer mark a row draws: its ring, its background tint and
 * whether its title is drawn strong.
 *
 * `taskAttention` is accepted and deliberately not consulted. It is the input
 * this function used to short-circuit on, and naming it here keeps the
 * separation testable: a row whose hub board still holds a rejected, blocked
 * or failed task must keep reporting the session's own state.
 */
export function resolveSessionRowTone({
    lineTone,
    unread,
}: {
    /** What `describeLmcSessionStatus` made of the session itself. */
    lineTone: LmcSessionTone;
    /** Unread turns a finished-but-unopened session green; unchanged. */
    unread: boolean;
    /** Present for the contract, never read. See above. */
    taskAttention?: boolean;
}): LmcSessionTone {
    return lineTone === 'idle' && unread ? 'done' : lineTone;
}
