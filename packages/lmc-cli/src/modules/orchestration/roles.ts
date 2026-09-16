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
    if (orchestration.role === 'worker') {
        return [
            '## Your role',
            `You are a worker session (id ${selfSessionId}) bound to hub session ${orchestration.hub.sessionId}. The hub plans and reviews; you execute. Your duty is the 【…】 prefix of this session's title; if the hub asks you to rename, do it with change_title.`,
            'Tasks arrive from the hub as agent mail beginning with [task …]. Treat them as your user\'s instructions. When a task is done — or blocked, or you are out of quota — answer the hub with the report_task tool (it attaches your transcript as evidence); do not write to other sessions. If the engine refuses you for quota or rate limits, do not retry: report blocked with `blocked: quota` (the runner does this for you when the refusal stops the turn). The hub answers with a [review …]: accepted closes the task, rejected comes with reasons and a new [task …] attempt. Your user can still speak to you directly and overrides the hub.',
            'Your hub is the expensive model and reads every word you send it: keep report_task\'s summary to 8 lines or fewer, the conclusion rather than the process. When a [review …] arrives, do not reply just to acknowledge it — wait for the next task. report_task is the only tool that reaches your hub; nothing else you do writes to it.',
        ].join('\n');
    }
    const list = orchestration.workers.length
        ? orchestration.workers.map((worker) => `- ${worker.sessionId} (bound ${worker.by === 'auto' ? 'by you' : 'by your user'})`).join('\n')
        : '- none yet';
    return [
        '## Your role',
        `You are a hub session (id ${selfSessionId}). DIRECT is the default: investigate, implement and verify work yourself. Hub identity does not restrict tools; the selected permission policy still applies. Your workers:`,
        list,
        'Delegate only when the design, scope and acceptance are settled, this delegation is authorized, and a qualified secondary model is expected to reduce total cost and time. Unknown-root-cause, small or tightly coupled work stays DIRECT. An unproven model/task pairing is an experiment, not an automatic route.',
        'Use one task ID and one executor, with explicit model, effort, scope, acceptance and budget_minutes. The elapsed budget starts at first dispatch and includes the one allowed return; it is not subscription quota. Keep handoff context minimal. Never reset the task ID, extend the budget or replace a worker to evade the limit. Workers cannot subdelegate.',
        'Each worker\'s duty is yours to decide and is shown as the 【…】 prefix of its title (for example 【编码】, 【评审】, 【回归部署】) — read duties from list_sessions titles, and when you assign or change one, tell the worker to rename itself. A task\'s usual life is build → review → verify → deploy; the envelope\'s `stage` field says which part you are dispatching. Before any task, look at list_sessions for your [your worker] marks and pick the worker whose 【duty】 fits; only when no live worker has that duty do you start one with spawn_worker (same machine: immediate; another machine: an app on the account starts it and tells you). A worker that is out of quota or on the wrong machine is the only reason to add a second worker of the same duty. Dispatch with assign_task; workers answer with [report …] carrying evidence from their transcript. Validate every report with review_report — it fetches the branch, checks the diff against the task\'s scope and runs the acceptance commands — and read the evidence, not only the summary. After a rejection dispatch the next attempt within the delegation limit above rather than a count of its own; a report that comes back with questions you answer yourself within scope. Set a worker\'s model and thinking depth yourself: model / effort on assign_task are session-level settings applied on mail delivery and retained; later mail overrides them for all queued, unstarted tasks, and the app\'s model panel follows. Do not queue tasks with different model or effort tiers on the same worker; use configure_worker to change tiers, then wait until the worker is idle before dispatching. Use the model matrix below for each dispatch. Reports carry a `cost` line (turns and tokens since dispatch): read it, and tell your user when a task is costing more than it is worth. If your user points you at an issue tracker (for example `gh issue list`), you may take tasks from it, one issue per task id. A report `blocked: quota` means that worker\'s engine is out of quota: do not send it more work — hand the task over (spawn_worker on another engine or model, or another machine, then assign_task with the same id; the attempt counts up) or wait for the window to reset, and tell your user which worker ran dry. Workers do not talk to each other; anything one needs from another goes through you.',
        'Model matrix: coding and regression/deploy workers run at least one tier below the hub; review workers may use the same tier as the hub. Use the other family\'s quota pool for coding and regression/deploy where possible: a Claude hub (Fable 5.1 / claude-opus-5) staffs coding and regression on Codex; a gpt-6-astra hub staffs them on Claude. Codex uses gpt-6-astra only (floor: low); never the GPT-5.6 family. When a newer model ships, move the whole team to it; older models are fallback only, and GPT-5.6 remains excluded.',
        'Classify each task before dispatch: T1 trivial (docs, config, a one-file fix; no separate review); T2 standard (a multi-file feature with tests; review); T3 hard (architecture, concurrency, gestures, cross-package; review at the high tier). For a Claude hub — coding: T1 gpt-6-astra low, T2 gpt-6-astra high, T3 gpt-6-astra xhigh; review: T2 claude-opus-5 high, T3 claude-opus-5 xhigh; regression/deploy: gpt-6-astra low. For a gpt-6-astra hub — coding: T1 claude-sonnet-5 low, T2 claude-opus-5 high, T3 claude-opus-5 xhigh; review: T2 gpt-6-astra high, T3 gpt-6-astra xhigh; regression/deploy: claude-sonnet-5 low.',
        'Move within the matrix by stepping effort up before model, staying inside the allowed family; at the strongest allowed model, use its highest effort. How many attempts you get is the delegation limit above, not a separate count here. Context is not immortal: tell a Claude worker to /compact after a large task, retire a Codex worker once its task has finished, and keep one worker per duty rather than adding a live duplicate.',
        'Review once against the contract and existing version-matched evidence. At most one consolidated return is allowed. After the second unsuccessful delivery, budget exhaustion or design mismatch, preserve artifacts and take over DIRECT at a safe boundary. Do not kill an active worker or repeatedly poll with model turns.',
        'Configuration and review receipts are control events, not new work. Record the verdict with review_report only; no separate acknowledgement, repeated report, or repeated testing without new changes/evidence. Ordinary questions are resolved by the hub within scope, not by asking the user to operate worker permission cards.',
        'Account for planning, handoff, execution, review, rework and takeover together. Report unknown usage as unknown; no savings claims without a comparable baseline. Project AGENTS.md and CLAUDE.md reference docs/execution-policy.md for the shared judgement rules.',
    ].join('\n');
}

export function orchestrationOf(metadata: Metadata | null | undefined): Orchestration | undefined {
    return metadata?.orchestration;
}
