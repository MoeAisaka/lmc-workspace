import type { ApiSessionClient } from '@/api/apiSession';
import type { Metadata } from '@/api/types';
import type { HandoffPort } from '@/claude/utils/startHappyServer';
import { formatSubmittedHandoff } from './engineHandoff';
import { logger } from '@/ui/logger';
import { describeRole } from '@/modules/orchestration/roles';

/**
 * Holds the briefing that will be handed to the engine taking over.
 *
 * Armed the moment a switch is requested, with the fallback the app compiled
 * from the transcript. That ordering is what makes every failure mode land in
 * the same place: whether the engine writes a handoff, refuses to, or dies
 * before it can, something is already in place to hand over, and no timer has
 * to decide when to give up on it.
 *
 * `submit_handoff` replaces the fallback with the engine's own account, which
 * is better in the way that matters — it knows why the code looks the way it
 * does, and the transcript only shows that it changed.
 */
export interface PriorThread {
    engine: string;
    id: string;
    transcriptPath?: string;
}

type ThreadRecord = NonNullable<Metadata['engineThreadHistory']>[number];

/** How many past stretches the briefing lists; older ones are still in the transcript tool. */
const HISTORY_SHOWN = 6;

/**
 * The section that tells the next engine where the full record is.
 *
 * The briefing is short by design, and short means lossy. This turns the loss
 * into something recoverable in two ways. The session's own transcript is one
 * record across every engine, on any machine, and a tool reads it. And every
 * engine-native conversation the session has had is listed as a file or
 * thread the next engine can open with its own tools — including, after a
 * round trip, its own earlier stretches. Those are marked, and marked as
 * history: an engine that recognises its own words is inclined to trust them,
 * and the files they mention may have changed hands since.
 */
export function describeRecord(history: ThreadRecord[], arriving: 'claude' | 'codex' | undefined): string {
    const lines: string[] = ['## Full record'];
    lines.push('Read this session\'s own transcript with the read_session_transcript tool: it is the one record covering every engine that has worked here, from any machine. These notes summarise it.');
    const shown = history.slice(-HISTORY_SHOWN);
    if (shown.length > 0) {
        lines.push('');
        lines.push(shown.length === history.length
            ? 'Engine conversations this session has had, oldest first. None is resumed for you; each is a record you can read:'
            : `The last ${shown.length} of ${history.length} engine conversations this session has had, oldest first. None is resumed for you; each is a record you can read:`);
        for (const record of shown) {
            const where = record.transcriptPath ?? `thread ${record.id}`;
            const yours = arriving && record.flavor === arriving
                ? ' — yours, from an earlier stretch of this same session. Treat it as history: the files it talks about may have been changed since by the other engine.'
                : '';
            lines.push(`- ${record.engine} · ${where}${yours}`);
        }
    }
    return lines.join('\n');
}

export type ArmedHandoffPort = HandoffPort & {
    /** `target` is the engine taking over, so its own earlier stretches can be marked as such. */
    arm(fallbackBriefing: string | null, target?: 'claude' | 'codex'): void;
    disarm(): void;
    /**
     * Called once the engine's own briefing is stored, so the runner can stop
     * taking new work: from that moment the notes describe a session that must
     * not keep changing under them.
     */
    onSubmitted?: () => void;
};

export function createHandoffPort(client: ApiSessionClient, from: string, fromFlavor: 'claude' | 'codex', priorThread: () => PriorThread | null): ArmedHandoffPort {
    let pending = false;
    let target: 'claude' | 'codex' | undefined;

    const store = (briefing: string, source: 'engine' | 'compiled') => {
        const prior = priorThread();
        client.updateMetadata((metadata) => {
            // The conversation being left joins the session's history of them,
            // once: arming and submitting both pass through here.
            const history = [...(metadata.engineThreadHistory ?? [])];
            if (prior && !history.some((record) => record.id === prior.id)) {
                history.push({ engine: prior.engine, flavor: fromFlavor, id: prior.id, transcriptPath: prior.transcriptPath, endedAt: Date.now() });
            }
            // The binding survives the switch; the engine arriving has to be told.
            const role = describeRole(metadata.orchestration, client.sessionId);
            return {
                ...metadata,
                engineThreadHistory: history,
                pendingHandoff: {
                    from,
                    fromFlavor,
                    source,
                    briefing: [briefing, describeRecord(history, target), role].filter(Boolean).join('\n\n'),
                    ...(prior ? { priorThread: prior } : {}),
                },
            };
        });
    };

    const port: ArmedHandoffPort = {
        isPending: () => pending,
        arm(fallbackBriefing, to) {
            pending = true;
            target = to;
            if (fallbackBriefing) store(fallbackBriefing, 'compiled');
        },
        disarm() {
            pending = false;
            client.updateMetadata((metadata) => ({ ...metadata, pendingHandoff: undefined }));
        },
        submit(document) {
            if (!pending) return false;
            const briefing = formatSubmittedHandoff(document, from);
            if (!briefing) return false;
            store(briefing, 'engine');
            // The notes are written; the session stops taking new work here so
            // they cannot be made stale by a turn the next engine never sees.
            port.onSubmitted?.();
            logger.debug('[handoff] Recorded the engine’s own briefing');
            return true;
        },
    };
    return port;
}

/**
 * The briefing waiting for this runner, if it is taking a session over.
 *
 * Read through the metadata lock, not off the local copy. A relaunched process
 * is built with fresh metadata of its own and learns the server's only when a
 * write comes back with a version conflict — an un-awaited round-trip that a
 * plain `getMetadata()` at startup raced and lost. The handler here runs on
 * whatever copy the server accepts, retried under conflict, so the briefing it
 * captures on the run that commits is the one that was actually there.
 *
 * Consumed and cleared in one write, because a briefing that stayed would be
 * delivered again on the next ordinary refresh — the new engine being told to
 * take over from itself.
 */
export async function consumePendingHandoff(client: ApiSessionClient): Promise<{ briefing: string; source: 'engine' | 'compiled'; from: string; fromFlavor?: 'claude' | 'codex' } | null> {
    let pending: Metadata['pendingHandoff'] | undefined;
    await client.updateMetadata((metadata) => {
        pending = metadata.pendingHandoff;
        if (!pending) return metadata;
        return { ...metadata, pendingHandoff: undefined };
    });
    if (!pending?.briefing) return null;
    return { briefing: pending.briefing, source: pending.source, from: pending.from, fromFlavor: pending.fromFlavor };
}
