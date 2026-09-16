/**
 * Codex Permission Handler
 *
 * Handles tool permission requests and responses for Codex sessions.
 * Extends BasePermissionHandler with Codex-specific configuration.
 */

import { logger } from "@/ui/logger";
import { ApiSessionClient } from "@/api/apiSession";
import type { AgentState, PermissionMode } from "@/api/types";
import { shouldAutoApproveCodexApproval } from '../executionPolicy';
import {
    BasePermissionHandler,
    PermissionResult,
    PendingRequest
} from '@/utils/BasePermissionHandler';

// Re-export types for backwards compatibility
export type { PermissionResult, PendingRequest };

/**
 * Codex-specific permission handler.
 */
export class CodexPermissionHandler extends BasePermissionHandler {
    // Exact tool names that should always be auto-approved. Include the bare
    // form (used by Codex elicitation messages like `tool "change_title"`)
    // and the MCP-qualified form for defense in depth.
    private static readonly ALWAYS_AUTO_APPROVE_NAMES: ReadonlySet<string> = new Set([
        'change_title',
        'mcp__happy__change_title',
    ]);

    // Tool-call IDs that should auto-approve when they exactly match one of
    // these values or start with `<name>-` (e.g. `change_title-1765385846663`).
    // Substring matching was a bypass vector — any tool whose ID happened to
    // contain `change_title` as a substring would be silently approved.
    private static readonly ALWAYS_AUTO_APPROVE_ID_PREFIXES: readonly string[] = [
        'change_title',
    ];

    constructor(session: ApiSessionClient) {
        super(session);
    }

    protected getLogPrefix(): string {
        return '[Codex]';
    }

    onPolicyChange(mode: PermissionMode, hubGuarded: boolean): void {
        if (shouldAutoApproveCodexApproval(mode, false, hubGuarded)) this.approvePendingTools();
        if (!hubGuarded) for (const [id, pending] of this.pendingRequests) {
            void this.session.requestHubDecision?.(id, pending.toolName, pending.input).then(sent => {
                if (sent) this.settlePending(id, pending, { decision: 'denied' });
            });
        }
    }

    private shouldAutoApprove(toolName: string, toolCallId: string): boolean {
        if (CodexPermissionHandler.ALWAYS_AUTO_APPROVE_NAMES.has(toolName)) {
            return true;
        }

        const toolCallIdSegments = toolCallId.split(':');

        for (const prefix of CodexPermissionHandler.ALWAYS_AUTO_APPROVE_ID_PREFIXES) {
            if (
                toolCallIdSegments.some((segment) => (
                    segment === prefix || segment.startsWith(`${prefix}-`)
                ))
            ) {
                return true;
            }
        }

        return false;
    }

    /**
     * Handle a tool permission request
     * @param toolCallId - The unique ID of the tool call
     * @param toolName - The name of the tool being called
     * @param input - The input parameters for the tool
     * @returns Promise resolving to permission result
     */
    async handleToolCall(
        toolCallId: string,
        toolName: string,
        input: unknown,
        options?: { policyAutoApprove?: boolean },
    ): Promise<PermissionResult> {
        const worker = this.session.getMetadata?.()?.orchestration;
        if (worker?.role === 'worker' && worker.hub.autonomy === true
            && this.session.requestHubDecision && await this.session.requestHubDecision(toolCallId, toolName, input)) return { decision: 'denied' };
        if (this.shouldAutoApprove(toolName, toolCallId)) {
            logger.debug(`${this.getLogPrefix()} Auto-approving tool ${toolName} (${toolCallId})`);

            this.session.updateAgentState((currentState) => ({
                ...currentState,
                completedRequests: {
                    ...currentState.completedRequests,
                    [toolCallId]: {
                        tool: toolName,
                        arguments: input,
                        createdAt: Date.now(),
                        completedAt: Date.now(),
                        status: 'approved',
                        decision: 'approved',
                    },
                },
            } satisfies AgentState));

            return { decision: 'approved' };
        }

        return new Promise<PermissionResult>((resolve, reject) => {
            // Store the pending request
            this.pendingRequests.set(toolCallId, {
                resolve,
                reject,
                toolName,
                input,
                policyAutoApprove: options?.policyAutoApprove === true,
            });

            // Update agent state with pending request
            this.addPendingRequestToState(toolCallId, toolName, input);

            logger.debug(`${this.getLogPrefix()} Permission request sent for tool: ${toolName} (${toolCallId})`);
        });
    }
}
