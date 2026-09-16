import type { ApiSessionClient } from '@/api/apiSession';
import { createHash } from 'node:crypto';
import { logger } from '@/ui/logger';
import { AgentMailClient, formatIncomingMail, type AgentDescriptor } from './agentMail';
import { relationTo } from '@/modules/orchestration/roles';
import { boardUpdate } from '@/modules/orchestration/board';
import { formatReportEnvelope, parseEnvelope } from '@/modules/orchestration/envelope';
import { applyWorkerConfig, configDirectives, hasConfig, isConfigMail } from '@/modules/orchestration/workerConfig';

const POLL_MS = 10_000;

/**
 * Keeps a session's directory entry current and delivers its mail.
 *
 * On by default — agents reaching each other is the point of the feature — and
 * turned off per session by setting `metadata.agentMail` to false. Sending is
 * never gated: an agent only sends because its own user asked it to.
 *
 * Polling rather than a socket event: it needs no change to the message
 * protocol the app and every agent already share. The directory is written
 * only when what it says actually changed, so a quiet session costs one small
 * request per tick and nothing else.
 */
export function startAgentMail(session: ApiSessionClient, token: string, describe: () => AgentDescriptor) {
    const mail = new AgentMailClient(token, session.sessionId);
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let published: string | null = null;
    // A worker whose hub has left the directory: once it has been gone for a
    // while the person is told, since the worker itself cannot rebind.
    let hubMissingSince: number | null = null;
    let hubLostTold = false;
    let lastHubCheck = 0;
    const HUB_CHECK_MS = 5 * 60_000;
    const HUB_LOST_AFTER_MS = 10 * 60_000;
    const decisions = new Map<string, Promise<boolean>>();
    session.setHubRequestHandler?.(async (requestId, tool, input) => {
        const o = session.getMetadata()?.orchestration;
        if (stopped || o?.role !== 'worker' || o.hub.autonomy !== true) return false;
        const questions = JSON.stringify({ tool, input });
        const digest = createHash('sha256').update(JSON.stringify([o.hub.sessionId, o.hub.boundAt, requestId, questions])).digest('hex');
        const prior = decisions.get(digest);
        if (prior) return prior;
        const delivery = (async () => {
            const text = formatReportEnvelope({ id: 'decision-' + digest.slice(0, 24), attempt: 1, status: 'blocked', fields: {
                digest, summary: 'This worker needs a hub decision. No tool approval or answer was invented.',
                questions, blocked: 'Resolve within the assigned scope, then send the worker a new task with the answer; change permission explicitly with configure_worker if needed. The worker does not wait for a person to click its permission card.',
            } });
            const sent = await mail.send(o.hub.sessionId, text, 1);
            if (!sent.ok) return false;
            session.sendSessionEvent({ type: 'message', message: `[hub decision] ${tool} was sent to hub ${o.hub.sessionId}; awaiting its next instruction.` });
            return true;
        })().catch(() => false);
        decisions.set(digest, delivery);
        if (decisions.size > 128) decisions.delete(decisions.keys().next().value!);
        const sent = await delivery;
        if (!sent) decisions.delete(digest); // Safe to retry: the server keeps the report's identity.
        return sent;
    });

    const accepting = () => {
        const metadata = session.getMetadata();
        if (metadata?.agentMail === false) return false;
        // Not while the session is being handed to another process. Fetching
        // marks mail delivered, and this process is about to exit — the letter
        // would be gone without anyone having read it. It waits instead: the
        // engine that takes over collects it on its first tick.
        return metadata?.sessionConfigState !== 'queued' && metadata?.sessionConfigState !== 'refreshing';
    };

    const tick = async () => {
        if (stopped) return;
        try {
            if (accepting()) {
                const descriptor = describe();
                const fingerprint = JSON.stringify(descriptor);
                if (fingerprint !== published) {
                    await mail.publish(descriptor);
                    published = fingerprint;
                }
                const orchestration = session.getMetadata()?.orchestration;
                if (orchestration?.role === 'worker' && Date.now() - lastHubCheck >= HUB_CHECK_MS) {
                    lastHubCheck = Date.now();
                    const present = (await mail.list()).some((entry) => entry.sessionId === orchestration.hub.sessionId);
                    if (present) { hubMissingSince = null; hubLostTold = false; }
                    else {
                        hubMissingSince ??= Date.now();
                        if (!hubLostTold && Date.now() - hubMissingSince >= HUB_LOST_AFTER_MS) {
                            hubLostTold = true;
                            session.sendSessionEvent({ type: 'message', message: `[hub lost] Hub session ${orchestration.hub.sessionId} has not been seen for ${Math.round(HUB_LOST_AFTER_MS / 60_000)} minutes. This worker keeps its tasks but has nobody to report to; in the app, open the session's info page and move it to another hub.` });
                        }
                    }
                }
                for (const message of await mail.receive()) {
                    try {
                    logger.debug(`[agent-mail] Delivering mail from ${message.fromSessionId}`);
                    let relation = relationTo(session.getMetadata()?.orchestration, message.fromSessionId);
                    const envelope = parseEnvelope(message.text);
                    // The hub's word on how this worker runs: a [config …] mail,
                    // or model=/effort= directives in a task's run line. Record
                    // the desired pick; subscribers handle runtime application.
                    let config = {};
                    if (relation === 'hub') {
                        config = isConfigMail(message.text) ? configDirectives(message.text) : envelope?.kind === 'task' ? configDirectives(envelope.fields.run) : {};
                    }
                    if (hasConfig(config)) await session.updateMetadata((m) => relationTo(m.orchestration, message.fromSessionId) === 'hub'
                        ? applyWorkerConfig(m, config) : m, { strict: true });
                    // A binding can change while the metadata write is in flight.
                    // Accepted settings reach the runner through its metadata
                    // subscription; never replay a captured configuration in a
                    // later user message (which could undo a newer choice).
                    relation = relationTo(session.getMetadata()?.orchestration, message.fromSessionId);
                    if (relation === 'hub' && (isConfigMail(message.text) || envelope?.kind === 'review')) {
                        // Store/notify only. A review or configuration is not a
                        // fresh assignment and must not bill another model turn.
                        session.sendSessionEvent({ type: 'message', message: message.text });
                    } else {
                        // Delivery precedes the board projection: a rejected
                        // board write must not discard an already-collected task.
                        session.sendUserTextMessage(formatIncomingMail(message, relation), undefined);
                    }
                    if (relation) {
                        const update = boardUpdate(message.text, message.fromSessionId);
                        if (update) await session.updateMetadata(m => relationTo(m.orchestration, message.fromSessionId) ? update(m) : m, { strict: true });
                    }
                    } catch (error) {
                        // One failed projection/configuration must not swallow
                        // the rest of this batch, which has already been claimed.
                        logger.debug('[agent-mail] Message processing failed', error);
                        session.sendSessionEvent({ type: 'message', message: `[agent-mail] Could not finish processing mail ${message.id}; its configuration or board update was not confirmed.` });
                        if (relationTo(session.getMetadata()?.orchestration, message.fromSessionId) === 'hub') {
                            const digest = createHash('sha256').update(message.id).digest('hex');
                            await mail.send(message.fromSessionId, formatReportEnvelope({
                                id: 'mail-error-' + digest.slice(0, 24), attempt: 1, status: 'blocked', fields: {
                                    summary: 'A delivered instruction could not finish its metadata/configuration processing.',
                                    blocked: 'Check the requested engine/mode and the worker connection. Delivery does not prove configuration or board acknowledgement; do not infer that a task has or has not run.',
                                },
                            }), 1).catch(() => undefined);
                        }
                    }
                }
            }
        } catch (error) {
            logger.debug('[agent-mail] Poll failed', error);
        }
        if (!stopped) timer = setTimeout(tick, POLL_MS);
    };

    timer = setTimeout(tick, 1_000);

    return {
        mail,
        stop: () => {
            stopped = true;
            session.setHubRequestHandler?.(null);
            if (timer) clearTimeout(timer);
        },
    };
}
