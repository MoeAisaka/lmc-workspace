import { HAPPY_MCP_TOOL_NAMES } from '@/claude/utils/startHappyServer';
import type { Metadata } from '@/api/types';

/**
 * Hub identity and tool/permission authority are decoupled: being a hub
 * changes what a session is trusted with for orchestration (the bridge
 * tools below), not what it is allowed to do with its own engine. A hub
 * may Edit/Write/Bash/Task and run Codex at whatever permission mode it
 * was given, exactly like any other session — nothing here forces it
 * read-only or strips tools on the strength of `role === 'hub'` alone.
 */
export function isHub(metadata: Metadata | null | undefined): boolean {
    return metadata?.orchestration?.role === 'hub';
}

/** The disallowed-tools list for this turn: the user's own, unchanged by hub role. */
export function hubDisallowedTools(metadata: Metadata | null | undefined, current: string[] | undefined): string[] | undefined {
    return current;
}

/** The Codex permission mode for this turn: whatever was requested, unchanged by hub role. */
export function hubCodexPermissionMode<T extends string>(metadata: Metadata | null | undefined, requested: T): T {
    return requested;
}


export const HUB_CODEX_DENIAL = 'This session is a hub: file edits and shell are disabled. Assign the work to a worker with assign_task.';

/** No approval is denied on hub role or a stale turnWasHub flag alone; role carries no tool restriction. */
export function hubCodexApprovalDenied(metadata: Metadata | null | undefined, turnWasHub = false): boolean {
    return false;
}


/** Only the runner-owned bridge tools bypass Codex's MCP prompt layer.
 * Actual exec/patch/elicitation approvals still go through the hub denial.
 */
export function hubCodexMcpTools(metadata: Metadata | null | undefined): Record<string, { approval_mode: 'approve' }> | undefined {
    if (metadata?.orchestration?.role === 'worker') return { report_task: { approval_mode: 'approve' } };
    if (!isHub(metadata)) return undefined;
    return Object.fromEntries(HAPPY_MCP_TOOL_NAMES.map(name => [name, { approval_mode: 'approve' as const }]));
}
