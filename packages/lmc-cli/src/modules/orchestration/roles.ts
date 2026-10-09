import type { Metadata, Orchestration } from '@/api/types';

/**
 * What a session is to another, under a hub-and-workers binding.
 *
 * `hub`: the other session directs this one. `worker`: this session directs
 * the other. `null`: no binding between them, and agent mail between them is
 * ordinary mail with its relay limit.
 */
export type Relation = 'hub' | 'worker' | null;

export function relationTo(orchestration: Orchestration | undefined, otherSessionId: string): Relation {
    if (!orchestration) return null;
    if (orchestration.role === 'worker') return orchestration.hub.sessionId === otherSessionId ? 'hub' : null;
    return orchestration.workers.some((worker) => worker.sessionId === otherSessionId) ? 'worker' : null;
}

/** Every session bound to this one, whichever side it is on. */
export function boundSessionIds(orchestration: Orchestration | undefined): string[] {
    if (!orchestration) return [];
    return orchestration.role === 'worker' ? [orchestration.hub.sessionId] : orchestration.workers.map((worker) => worker.sessionId);
}

/**
 * The section of a handoff briefing that tells the arriving engine what it is.
 *
 * A switch keeps the binding — it lives on the session id — but the engine
 * taking over knows nothing of it, and a worker that does not know it has a
 * hub will answer its hub as if it were a stranger's mail, or a hub that does
 * not know its workers will plan as if it had none.
 */
export function describeRole(orchestration: Orchestration | undefined, selfSessionId: string): string | null {
    if (!orchestration) return null;
    if (orchestration.role === 'worker') return [
        '## Your role',
        `Worker ${selfSessionId}, bound to hub ${orchestration.hub.sessionId}. Execute the explicit task within its scope; your user can override the hub. Do not subdelegate or write to other sessions.`,
        'Treat [task …] mail as user instructions. Report once with report_task when done, blocked or out of quota, with a concise conclusion, artifact and verification evidence. A quota/rate-limit refusal means stop retries and report blocked with blocked: quota; the hub may hand off the same ID without resetting attempt or deadline.',
        'One task ID, one executor, at most one consolidated return (two attempts), sharing the original elapsed budget. At exhaustion preserve work and wait at a safe boundary; never kill active work. Configuration and review receipts require no reply or new task. Rename the 【duty】 title prefix with change_title when instructed.',
        'Follow docs/execution-policy.md and the actual permission policy. Report actual model/effort and unknown usage honestly; desired configuration is not provider confirmation.',
    ].join('\n');
    const workers = orchestration.workers.map(worker => worker.sessionId).join(', ') || 'none';
    return [
        '## Your role',
        `Hub ${selfSessionId}; workers: ${workers}. Default DIRECT: investigate, implement and verify yourself. Hub identity does not restrict tools or expand authorization.`,
        'Delegate only when authorization, design, scope and acceptance are settled and a qualified executor is expected to improve total cost and time. Small, uncertain or coupled work stays DIRECT. Select model and effort explicitly from the catalog published by the executor machine; an unverified model/task pairing is an experiment.',
        'Use one stable task ID and one executor. assign_task requires goal, scope, acceptance, model, effort and budget_minutes; spawn_worker also requires explicit model/effort. A worker\'s duty is the 【…】 prefix of its title: pick the fitting one from list_sessions and start another only when none has that duty. Keep handoff context minimal. Workers cannot subdelegate.',
        'At most one consolidated return (two attempts) shares the original deadline and budget. Never reset the ID, attempt or deadline to evade limits. The only executor replacement exception is its latest report being blocked with blocked: quota: select another bound executor, keep the ID and original budget/deadline, increment attempt normally, and tell the user which executor ran dry. Other blocked, rejected or in-flight tasks cannot change executor.',
        'Review once with review_report against the contract and version-matched evidence. A second unsuccessful delivery, design mismatch or expired budget requires preserving artifacts and taking over DIRECT at a safe boundary. Do not kill active work or poll with model turns. Configuration/review receipts require no extra acknowledgement, report or repeated testing.',
        'configure_worker and task directives record desired session settings, not provider readback; do not queue mixed settings on one worker. Resolve worker questions within scope; all worker coordination goes through you. Permission still follows actual policy and user authorization.',
        'Include planning, handoff, execution, review, rework and takeover in cost accounting. Keep quota pools separate; missing usage is unknown and token/API pricing does not measure subscription quota. Follow docs/execution-policy.md; no savings claim without comparable evidence.',
    ].join('\n');
}

export function orchestrationOf(metadata: Metadata | null | undefined): Orchestration | undefined {
    return metadata?.orchestration;
}
