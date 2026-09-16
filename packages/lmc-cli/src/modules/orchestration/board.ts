import type { BoardEntry, Metadata, Orchestration } from '@/api/types';
import { parseEnvelope, type Envelope } from './envelope';

/**
 * The task board, kept in the session's metadata by its runner.
 *
 * Every [task] a hub sends and every [report] it receives moves a row on this
 * board; a worker keeps the mirror image for its own tasks. Metadata because
 * that is what every device already holds for every session: the list can
 * show a hub's tasks without loading a single message, and two devices read
 * the same board. The transcript stays the record; the board is the summary.
 */
export const BOARD_LIMIT = 40;

/** States a task does not come back from: the row can fold away. */
export const CLOSED_STATES: readonly BoardEntry['state'][] = ['done', 'accepted'];

export function boardOf(orchestration: Orchestration | undefined): BoardEntry[] {
    return orchestration?.board ?? [];
}

/** Applies one envelope that crossed the wire, in either direction. */
export function applyEnvelope(board: BoardEntry[], envelope: Envelope, counterpart: string | null, now: number): BoardEntry[] {
    const rest = board.filter((entry) => entry.id !== envelope.id);
    const existing = board.find((entry) => entry.id === envelope.id);
    // Old deliveries remain in the transcript, but cannot roll back the current attempt/phase.
    if (existing && envelope.attempt < existing.attempt) return board;
    if (existing && envelope.attempt === existing.attempt && envelope.kind !== 'task') {
        if (existing.dispatchId && envelope.fields.dispatch && existing.dispatchId !== envelope.fields.dispatch) return board;
        if (envelope.kind === 'report' && (existing.state === 'accepted' || existing.state === 'rejected')) return board;
    }
    if (existing && envelope.kind === 'task' && envelope.attempt === existing.attempt
        && envelope.fields.dispatch && existing.dispatchId === envelope.fields.dispatch) return board;
    const entry: BoardEntry = existing
        ? { ...existing, updatedAt: now, attempt: Math.max(existing.attempt, envelope.attempt) }
        : { id: envelope.id, title: envelope.id, state: 'dispatched', attempt: envelope.attempt, counterpart: null, firstAt: now, updatedAt: now };
    if (counterpart) entry.counterpart = counterpart;
    if (envelope.kind === 'task') {
        entry.dispatchId = envelope.fields.dispatch;
        const goal = envelope.fields.goal?.split('\n')[0]?.trim();
        if (goal) entry.title = goal;
        if (envelope.fields.stage) entry.stage = envelope.fields.stage.trim();
        if (envelope.fields.scope) entry.scope = envelope.fields.scope.trim();
        entry.state = 'dispatched';
        delete entry.reason;
    } else {
        // A report or a review: either way the status is the new state.
        entry.state = envelope.status;
        if (envelope.kind === 'report' && envelope.status === 'blocked' && /quota|rate[ _-]?limit|429/i.test(envelope.fields.blocked ?? '')) entry.reason = 'quota';
        else delete entry.reason;
        if (envelope.kind === 'report' && envelope.fields.cost) entry.cost = envelope.fields.cost.split('\n')[0].trim();
        if (envelope.kind === 'report' && envelope.fields.model) entry.model = envelope.fields.model.split('\n')[0].trim();
    }
    // Newest first, bounded: the transcript keeps what falls off.
    return [entry, ...rest].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, BOARD_LIMIT);
}

/** The metadata updater for a message this session sent or received, or null when it carried no envelope. */
export function boardUpdate(text: string, counterpart: string | null, now = Date.now()): ((metadata: Metadata) => Metadata) | null {
    const envelope = parseEnvelope(text);
    if (!envelope) return null;
    return (metadata) => {
        const orchestration = metadata.orchestration;
        if (!orchestration) return metadata;
        const ledger = metadata.delegationLedger;
        const reservation = ledger?.[envelope.id];
        const canUpdate = reservation && envelope.kind !== 'task'
            && envelope.attempt === reservation.attempt
            && envelope.fields.dispatch === reservation.dispatch
            && !(envelope.kind === 'report' && ['accepted', 'rejected'].includes(reservation.state));
        return { ...metadata,
            ...(canUpdate ? { delegationLedger: { ...ledger, [envelope.id]: { ...reservation, state: envelope.status } } } : {}),
            orchestration: { ...orchestration, board: applyEnvelope(boardOf(orchestration), envelope, counterpart, now) } };
    };
}
