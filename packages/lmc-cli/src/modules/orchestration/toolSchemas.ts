import { z } from 'zod';
import { TASK_STAGES } from './envelope';

/**
 * The hub-and-workers tools as the model sees them. One definition, used by
 * the Happy MCP server and by the Codex stdio bridge that forwards to it, so
 * the two engines are offered the same tools with the same words.
 */
export const ORCHESTRATION_TOOL_NAMES = ['spawn_worker', 'assign_task', 'report_task', 'review_report', 'configure_worker'] as const;
export type OrchestrationToolName = typeof ORCHESTRATION_TOOL_NAMES[number];

export const spawnWorkerSchema = {
    duty: z.string().min(1).max(12).describe('The worker\'s job in a word or two, shown as the 【…】 prefix of its title: 编码, 评审, 回归部署 …'),
    name: z.string().max(60).optional().describe('The rest of the title after the duty. Defaults to the directory name.'),
    directory: z.string().optional().describe('Working directory for the worker. Defaults to this session\'s own directory. On another machine, give a path that exists there.'),
    agent: z.enum(['claude', 'codex']).optional().describe('Engine (default claude).'),
    model: z.string().trim().min(1).describe('Explicit execution model; no inherited/default model. DIRECT is the default route.'),
    effort: z.string().trim().min(1).describe('Explicit reasoning effort for this executor.'),
    permission_mode: z.string().optional().describe('Permission mode for the worker, e.g. bypassPermissions (Claude) or yolo (Codex). Default: the engine\'s own default, which will stop to ask.'),
    machine: z.string().optional().describe('Machine id or machine name (as list_sessions shows it). Omit for this machine. Another machine\'s worker is started by an app on the account; expect a short delay and a message when it is up.'),
    force: z.boolean().optional().describe('Start another worker even though one with this duty already exists. Normally unnecessary: workers are a standing team, reused task after task.'),
};

export const assignTaskSchema = {
    budget_minutes: z.number().int().min(1).max(1440).describe('Total elapsed-minute budget from first dispatch, shared across one allowed return. Expiry blocks later dispatch, never kills active work. Not a subscription quota limit.'),
    dispatch_id: z.string().min(1).max(128).optional().describe('Optional explicit dispatch identity. Reuse it when retrying delivery; change it only for a deliberately new assignment with an otherwise identical specification.'),
    sessionId: z.string().describe('The worker to dispatch to; one of your workers from list_sessions.'),
    id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/).describe('Task id, stable across attempts, e.g. lmc-42.'),
    attempt: z.number().int().min(1).max(2).optional().describe('One initial attempt and at most one return. Cannot reset or skip.'),
    stage: z.enum(TASK_STAGES).optional().describe('build, review, verify or deploy.'),
    goal: z.string().min(1).describe('What done looks like, for the worker.'),
    scope: z.string().trim().min(1).describe('Explicit execution scope and allowed paths.'),
    acceptance: z.string().min(1).describe('Checks that decide pass or fail, one per line. Commands the hub can run go here verbatim, e.g. `npx vitest run sources/sync`.'),
    constraints: z.string().optional(),
    deliver: z.string().optional().describe('Where the work should land, e.g. branch task/lmc-42 pushed to remote lmc.'),
    run: z.string().optional().describe('A note on how to run it. To change the worker\'s model or effort for this task, use the model / effort fields below instead.'),
    model: z.string().trim().min(1).describe('Explicit execution model for this assignment, never inherited.'),
    effort: z.string().trim().min(1).describe('Explicit execution effort for this assignment.'),
    permission_mode: z.string().optional().describe('Permission mode from this task on, e.g. bypassPermissions (Claude) or yolo (Codex).'),
};

export const configureWorkerSchema = {
    sessionId: z.string().describe('One of your workers, from list_sessions.'),
    model: z.string().optional().describe('New model id for the worker.'),
    effort: z.string().optional().describe('New thinking depth: low, medium, high (Codex also xhigh; Claude also max).'),
    permission_mode: z.string().optional().describe('New permission mode.'),
};

export const reportTaskSchema = {
    dispatch_id: z.string().min(1).max(128).optional().describe('Dispatch identity from the task; omit for the current board entry. Supply it when reporting a prior phase.'),
    evidence: z.string().optional().describe('New explicit evidence, including its stable ID or digest. Unlike the automatic transcript tail, changes here create a new report.'),
    id: z.string().describe('The task id from the [task …] you received.'),
    attempt: z.number().int().min(1).max(99).optional().describe('The attempt number from the task. Omit to use the board\'s.'),
    status: z.enum(['done', 'blocked', 'failed']).describe('done: acceptance met. blocked: cannot continue (a question, a missing permission, quota). failed: tried and could not meet acceptance.'),
    summary: z.string().min(1).describe('What was done, in a few lines.'),
    changes: z.string().optional().describe('Branch @ sha, or files changed.'),
    verification: z.string().optional().describe('What you ran and what it said.'),
    questions: z.string().optional().describe('Anything the hub or the user must decide.'),
    blocked: z.string().optional().describe('Why you are blocked; say `quota` if you ran out of quota.'),
    evidence_count: z.number().int().min(0).max(120).optional().describe('How many of your most recent transcript entries to attach as evidence. Default: 0 (skipped) for status done, 12 for blocked or failed — a clean done costs your hub nothing to read past.'),
};

export const reviewReportSchema = {
    id: z.string().describe('Task id to review; the report must already be on the board.'),
    branch: z.string().optional().describe('The worker\'s branch to fetch and check, e.g. task/lmc-42. Omit to check the working tree here for build tasks; review/deploy tasks skip git and scope scans and execute only the supplied run commands.'),
    base: z.string().optional().describe('Base ref the branch grew from (default: merge-base with HEAD).'),
    repo: z.string().optional().describe('Working directory for the git and run commands, when it is not this session\'s own directory (e.g. a hub whose own cwd is not the repo the worker committed to). Default: this session\'s directory. Required together with branch when this session is not itself inside the repository.'),
    scope: z.array(z.string()).optional().describe('Allowed paths or globs; every changed file must match one. Defaults to the scope of the [task …] on record when it can be read.'),
    run: z.array(z.string()).optional().describe('Shell commands to run as acceptance, each must exit 0. Run in a detached worktree of the branch when one is given, otherwise in repo or the session directory, including review/deploy tasks without a branch.'),
    verdict: z.enum(['accepted', 'rejected']).optional().describe('Your own judgement after reading the report and evidence. Omit to let the checks decide; give it to override them, with reasons. Required for review/deploy tasks with neither a branch nor run commands.'),
    reasons: z.string().optional().describe('Why, for the worker and the record. Required when rejecting.'),
};

export const ORCHESTRATION_TOOL_DEFS: Record<OrchestrationToolName, { title: string; description: string; inputSchema: Record<string, z.ZodTypeAny> }> = {
    spawn_worker: {
        title: 'Start A Worker Session',
        description: 'Start a new agent session bound to this one as your worker, titled 【duty】name. Workers are a standing team: one per duty (编码 / 评审 / 回归部署 …), reused for every task of that duty, usually on a cheaper model. Call this only when you have no live worker for the duty (check list_sessions for [your worker] marks); the tool refuses otherwise unless force is set. On this machine the worker is up within seconds and its id is returned; on another machine an app on the account starts it and you receive a message with the id.',
        inputSchema: spawnWorkerSchema,
    },
    assign_task: {
        title: 'Assign A Task',
        description: 'Dispatch a [task …] envelope to one of your workers and record it on the board. Prefer this to send_to_session for tasks: the fields are checked, the attempt is counted, and review_report can later check the diff against the scope you gave.',
        inputSchema: assignTaskSchema,
    },
    report_task: {
        title: 'Report A Task',
        description: 'Answer your hub with a [report …] envelope when a task is done, blocked or failed. The runner attaches the tail of your transcript as evidence so the hub can review what you actually did. Use this rather than send_to_session for reports. If you hit a quota or rate limit, report at once with status blocked and blocked: quota; do not retry on your own.',
        inputSchema: reportTaskSchema,
    },
    configure_worker: {
        title: 'Configure A Worker',
        description: 'Change a bound worker’s model, effort or permission mode through the runtime control channel. This does not start a model turn and needs no acknowledgement report. An active provider may require a supported query/turn boundary before a setting is effective.',
        inputSchema: configureWorkerSchema,
    },
    review_report: {
        title: 'Review A Report',
        description: 'Check a worker report against its contract and record one verdict. At most one consolidated return is allowed; after a second failed delivery the hub takes over DIRECT, without replacing the worker or resetting the task ID. No separate acknowledgement message is needed.',
        inputSchema: reviewReportSchema,
    },
};
