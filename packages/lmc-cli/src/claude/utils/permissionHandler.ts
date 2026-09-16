/**
 * Permission Handler for canCallTool integration
 *
 * Uses official SDK's toolUseID from canUseTool callback options.
 * Handles tool permission requests, responses, and state management.
 */

import { logger } from "@/lib";
import type { CanCallToolOptions, PermissionResult } from "../sdk/types";
import { Session } from "../session";
import { EnhancedMode, PermissionMode } from "../loop";
import { getToolDescriptor } from "./getToolDescriptor";
import { isClaudeBypassEquivalent, mapToClaudeMode } from "./permissionMode";

export interface PermissionResponse {
    id: string;
    approved: boolean;
    reason?: string;
    mode?: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan';
    allowTools?: string[];
    updatedInput?: Record<string, unknown>;
    receivedAt?: number;
}


interface PendingRequest {
    resolve: (value: PermissionResult) => void;
    reject: (error: Error) => void;
    toolName: string;
    input: unknown;
    settled?: boolean;
    deciding?: boolean;
}

type PermissionResponseForLookup = Pick<PermissionResponse, 'approved' | 'mode' | 'reason'>;
export type PermissionResponseLookup = Pick<ReadonlyMap<string, PermissionResponseForLookup>, 'get' | 'has'>;

export class PermissionHandler {
    private responses = new Map<string, PermissionResponse>();
    private pendingRequests = new Map<string, PendingRequest>();
    private session: Session;
    private allowedTools = new Set<string>();
    private allowedBashLiterals = new Set<string>();
    private allowedBashPrefixes = new Set<string>();
    private permissionMode: PermissionMode = 'default';
    private onPermissionRequestCallback?: (toolCallId: string) => void;
    /** Callback to change permission mode on the active query (set by claudeRemote) */
    private setPermissionModeCallback?: (mode: PermissionMode) => Promise<void>;
    private desiredMode: PermissionMode | undefined;
    private modeRevision = 0;
    private queryEpoch = 0;
    private modeUpdate: Promise<void> | null = null;

    hasPendingRequests(): boolean { return this.pendingRequests.size > 0; }

    constructor(session: Session) {
        this.session = session;
        this.setupClientHandler();
    }

    /**
     * Set callback to trigger when permission request is made
     */
    setOnPermissionRequest(callback: (toolCallId: string) => void) {
        this.onPermissionRequestCallback = callback;
    }

    handleModeChange(mode: PermissionMode | undefined): Promise<void> {
        if (this.desiredMode === mode && this.modeUpdate) return this.modeUpdate;
        this.desiredMode = mode;
        const revision = ++this.modeRevision;
        const epoch = this.queryEpoch;
        const setter = this.setPermissionModeCallback;
        const next = mode ?? 'default';
        if (!setter || mode === undefined) {
            this.permissionMode = next;
            this.reevaluatePending();
            return Promise.resolve();
        }
        // A requested mode is not an effective mode. Tighten the runner while
        // waiting; only the matching query/revision may widen after setter ACK.
        this.permissionMode = 'default';
        const apply = async () => {
            if (epoch !== this.queryEpoch || revision !== this.modeRevision) return;
            await setter(mapToClaudeMode(mode));
            if (epoch !== this.queryEpoch || revision !== this.modeRevision) return;
            this.permissionMode = next;
            this.reevaluatePending();
        };
        const update = this.modeUpdate ? this.modeUpdate.catch(() => undefined).then(apply) : apply();
        this.modeUpdate = update;
        const release = () => { if (this.modeUpdate === update) this.modeUpdate = null; };
        void update.then(release, release);
        return update;
    }

    /**
     * Set callback to dynamically change permission mode on the active query.
     * Called by claudeRemote after the Query object is created.
     */
    setPermissionModeUpdater(callback: ((mode: PermissionMode) => Promise<void>) | undefined) {
        this.queryEpoch++;
        this.setPermissionModeCallback = callback;
        this.modeUpdate = null;
        if (callback && this.desiredMode !== undefined) {
            void this.handleModeChange(this.desiredMode).catch(error => logger.debug('Could not synchronize the new query permission mode', error));
        }
    }

    private reevaluatePending(): void {
        for (const [id, pending] of this.pendingRequests) {
            if (pending.deciding) continue;
            const descriptor = getToolDescriptor(pending.toolName);
            const worker = this.session.client.getMetadata()?.orchestration;
            if (pending.toolName === 'AskUserQuestion' || descriptor.exitPlan) {
                if (worker?.role === 'worker' && worker.hub.autonomy === true) {
                    if (descriptor.exitPlan && isClaudeBypassEquivalent(this.permissionMode)) this.finishPending(id, pending, { id, approved: true });
                    else this.referPendingToHub(id, pending);
                }
                continue;
            }
            if (isClaudeBypassEquivalent(this.permissionMode)
                || (this.permissionMode === 'acceptEdits' && descriptor.edit)
                || (this.permissionMode === 'plan' && !descriptor.dangerous)) {
                this.finishPending(id, pending, { id, approved: true });
            } else this.referPendingToHub(id, pending);
        }
    }

    private referPendingToHub(id: string, pending: PendingRequest): void {
        void this.session.client.requestHubDecision?.(id, pending.toolName, pending.input).then(sent => {
            if (sent && !pending.settled) this.finishPending(id, pending, { id, approved: false, reason: this.hubReferralMessage() });
        });
    }

    private hubReferralMessage(): string {
        return 'This decision has been delivered to your hub. Do not ask the person here, repeat the report, or continue the blocked action. End this turn and wait for a new task from the hub with its answer.';
    }

    /** All answers, policy re-evaluations and aborts settle an instance once. */
    private finishPending(id: string, pending: PendingRequest, response: PermissionResponse, error?: Error): void {
        if (pending.settled) return;
        pending.settled = true;
        if (this.pendingRequests.get(id) === pending) this.pendingRequests.delete(id);
        this.responses.set(id, { ...response, receivedAt: Date.now() });
        if (error) pending.reject(error);
        else if (response.approved) pending.resolve({ behavior: 'allow', updatedInput: { ...(pending.input as Record<string, unknown> || {}), ...response.updatedInput } });
        else pending.resolve({ behavior: 'deny', message: response.reason || 'Tool use was rejected. Wait for a new instruction.' });
        this.session.client.updateAgentState(current => {
            const request = current.requests?.[id];
            if (!request) return current;
            const requests = { ...current.requests }; delete requests[id];
            return { ...current, requests, completedRequests: { ...current.completedRequests, [id]: {
                ...request, completedAt: Date.now(), status: error ? 'canceled' : response.approved ? 'approved' : 'denied',
                reason: response.reason, mode: response.mode, allowTools: response.allowTools, allowedTools: response.allowTools,
            } } };
        });
    }

    /**
     * Handler response
     */
    private async handlePermissionResponse(
        response: PermissionResponse,
        pending: PendingRequest
    ): Promise<void> {

        // A failed/obsolete mode change must not widen a separate tool whitelist.
        if (response.mode) await this.handleModeChange(response.mode);
        if (pending.settled) return;
        if (response.approved && response.allowTools && response.allowTools.length > 0) {
            response.allowTools.forEach(tool => {
                if (tool.startsWith('Bash(') || tool === 'Bash') {
                    this.parseBashPermission(tool);
                } else {
                    this.allowedTools.add(tool);
                }
            });
        }

        // Handle
        if (pending.toolName === 'exit_plan_mode' || pending.toolName === 'ExitPlanMode') {
            logger.debug('Plan mode result received', response);
            if (response.approved) {
                // Switch permission mode via SDK before allowing ExitPlanMode
                const newMode = (response.mode && ['default', 'acceptEdits', 'bypassPermissions'].includes(response.mode))
                    ? response.mode
                    : this.permissionMode === 'plan' ? 'default' : this.permissionMode;

                logger.debug(`Plan approved - switching to ${newMode} mode and allowing ExitPlanMode`);

                if (!response.mode) await this.handleModeChange(newMode);
                this.finishPending(response.id, pending, response);
            } else {
                this.finishPending(response.id, pending, response);
            }
        } else {
            // Handle default case for all other tools
            this.finishPending(response.id, pending, response);
        }
    }

    /**
     * Creates the canCallTool callback for the SDK.
     * Uses toolUseID from official SDK callback options directly.
     */
    handleToolCall = async (toolName: string, input: unknown, mode: EnhancedMode, options: CanCallToolOptions): Promise<PermissionResult> => {
        const toolCallId = this.getPermissionRequestId(options);

        // AskUserQuestion requires user interaction — never auto-approve, even in bypassPermissions mode.
        // This mirrors Claude SDK's internal requiresUserInteraction() check.
        if (toolName === 'AskUserQuestion') {
            return this.handlePermissionRequest(toolCallId, toolName, input, options.signal, options.toolUseID);
        }

        // Check if tool is explicitly allowed
        if (toolName === 'Bash') {
            const inputObj = input as { command?: string };
            if (inputObj?.command) {
                // Check literal matches
                if (this.allowedBashLiterals.has(inputObj.command)) {
                    return { behavior: 'allow', updatedInput: input as Record<string, unknown> };
                }
                // Check prefix matches
                for (const prefix of this.allowedBashPrefixes) {
                    if (inputObj.command.startsWith(prefix)) {
                        return { behavior: 'allow', updatedInput: input as Record<string, unknown> };
                    }
                }
            }
        } else if (this.allowedTools.has(toolName)) {
            return { behavior: 'allow', updatedInput: input as Record<string, unknown> };
        }

        // Calculate descriptor
        const descriptor = getToolDescriptor(toolName);

        // Independent sessions retain their plan approval. An already granted
        // worker confirms through its live policy, not a second human card.
        if (descriptor.exitPlan) {
            const o = this.session.client.getMetadata()?.orchestration;
            if (o?.role === 'worker' && o.hub.autonomy === true && isClaudeBypassEquivalent(this.permissionMode)) {
                const epoch = this.queryEpoch;
                await this.handleModeChange(this.permissionMode);
                const current = this.session.client.getMetadata()?.orchestration;
                if (options.signal.aborted || epoch !== this.queryEpoch || !isClaudeBypassEquivalent(this.permissionMode)
                    || current?.role !== 'worker' || current.hub.autonomy !== true
                    || current.hub.sessionId !== o.hub.sessionId || current.hub.boundAt !== o.hub.boundAt) {
                    return { behavior: 'deny', message: 'The permission policy changed while the plan was being confirmed. Wait for the current instruction.' };
                }
                return { behavior: 'allow', updatedInput: input as Record<string, unknown> };
            }
            return this.handlePermissionRequest(toolCallId, toolName, input, options.signal, options.toolUseID);
        }

        //
        // Handle special cases
        //

        if (isClaudeBypassEquivalent(this.permissionMode)) {
            return { behavior: 'allow', updatedInput: input as Record<string, unknown> };
        }

        if (this.permissionMode === 'acceptEdits' && descriptor.edit) {
            return { behavior: 'allow', updatedInput: input as Record<string, unknown> };
        }

        // Plan mode: auto-approve read-only tools (Read, Glob, Grep, etc.)
        // Dangerous tools (Bash, Edit, Write) still require approval
        if (this.permissionMode === 'plan' && !descriptor.dangerous) {
            return { behavior: 'allow', updatedInput: input as Record<string, unknown> };
        }

        //
        // Approval flow
        //

        return this.handlePermissionRequest(toolCallId, toolName, input, options.signal, options.toolUseID);
    }

    private getPermissionRequestId(options: CanCallToolOptions): string {
        return options.agentID ? `${options.agentID}:${options.toolUseID}` : options.toolUseID;
    }

    /**
     * Handles individual permission requests
     */
    private async handlePermissionRequest(
        id: string,
        toolName: string,
        input: unknown,
        signal: AbortSignal,
        toolUseId: string
    ): Promise<PermissionResult> {
        const worker = this.session.client.getMetadata()?.orchestration;
        if (worker?.role === 'worker' && worker.hub.autonomy === true
            && this.session.client.requestHubDecision && await this.session.client.requestHubDecision(id, toolName, input)) {
            return { behavior: 'deny', message: this.hubReferralMessage() };
        }
        return new Promise<PermissionResult>((resolve, reject) => {
            // Set up abort signal handling
            const abortHandler = () => {
                this.finishPending(id, pending, { id, approved: false, reason: 'Permission request aborted' }, new Error('Permission request aborted'));
            };
            signal.addEventListener('abort', abortHandler, { once: true });

            // Store the pending request
            const pending: PendingRequest = {
                resolve: (result: PermissionResult) => {
                    signal.removeEventListener('abort', abortHandler);
                    resolve(result);
                },
                reject: (error: Error) => {
                    signal.removeEventListener('abort', abortHandler);
                    reject(error);
                },
                toolName,
                input
            };
            this.pendingRequests.set(id, pending);

            // Trigger callback to send delayed messages immediately
            if (this.onPermissionRequestCallback) {
                this.onPermissionRequestCallback(id);
            }

            // Send push notification
            this.session.api.push().sendSessionNotification({
                kind: 'permission',
                metadata: this.session.client.getMetadata(),
                data: {
                    sessionId: this.session.client.sessionId,
                    requestId: id,
                    tool: toolName,
                    type: 'permission_request',
                    provider: 'claude',
                }
            });

            // Update agent state. toolUseId carries the raw provider id so the
            // app can attach the permission card to its tool call even when
            // the request id is subagent-scoped (`agentID:toolUseID`).
            this.session.client.updateAgentState((currentState) => ({
                ...currentState,
                completedRequests: Object.fromEntries(Object.entries(currentState.completedRequests ?? {}).filter(([key]) => key !== id)),
                requests: {
                    ...currentState.requests,
                    [id]: {
                        tool: toolName,
                        arguments: input,
                        createdAt: Date.now(),
                        ...(toolUseId !== id ? { toolUseId } : {})
                    }
                }
            }));

            logger.debug(`Permission request sent for tool call ${id}: ${toolName}`);
            if (signal.aborted) abortHandler();
        });
    }


    /**
     * Parses Bash permission strings into literal and prefix sets
     */
    private parseBashPermission(permission: string): void {
        // Ignore plain "Bash"
        if (permission === 'Bash') {
            return;
        }

        // Match Bash(command) or Bash(command:*)
        const bashPattern = /^Bash\((.+?)\)$/;
        const match = permission.match(bashPattern);

        if (!match) {
            return;
        }

        const command = match[1];

        // Check if it's a prefix pattern (ends with :*)
        if (command.endsWith(':*')) {
            const prefix = command.slice(0, -2); // Remove :*
            this.allowedBashPrefixes.add(prefix);
        } else {
            // Literal match
            this.allowedBashLiterals.add(command);
        }
    }

    /**
     * Checks if a tool call is rejected
     */
    isAborted(toolCallId: string): boolean {
        // If tool not approved, it's aborted
        if (this.getResponseForToolUseId(toolCallId)?.approved === false) {
            return true;
        }

        // Tool call is not aborted
        return false;
    }

    /**
     * Resets all state for new sessions
     */
    reset(reason: string = 'Session switched to local mode'): void {
        this.setPermissionModeUpdater(undefined);
        this.modeRevision++;
        this.desiredMode = undefined;
        this.responses.clear();
        this.allowedTools.clear();
        this.allowedBashLiterals.clear();
        this.allowedBashPrefixes.clear();
        this.permissionMode = 'default';

        // Cancel all pending requests
        for (const [, pending] of this.pendingRequests.entries()) {
            pending.settled = true;
            pending.reject(new Error('Session reset'));
        }
        this.pendingRequests.clear();

        // Move all pending requests to completedRequests with canceled status
        this.session.client.updateAgentState((currentState) => {
            const pendingRequests = currentState.requests || {};
            const completedRequests = { ...currentState.completedRequests };

            // Move each pending request to completed with canceled status
            for (const [id, request] of Object.entries(pendingRequests)) {
                completedRequests[id] = {
                    ...request,
                    completedAt: Date.now(),
                    status: 'canceled',
                    reason
                };
            }

            return {
                ...currentState,
                requests: {}, // Clear all pending requests
                completedRequests
            };
        });
    }

    /**
     * Sets up the client handler for permission responses
     */
    private setupClientHandler(): void {
        this.session.client.rpcHandlerManager.registerHandler<PermissionResponse, void>('permission', async (message) => {
            logger.debug(`Permission response: ${JSON.stringify(message)}`);

            const id = message.id;
            const pending = this.pendingRequests.get(id);

            if (!pending || pending.deciding) {
                logger.debug('Permission request not found or already resolved');
                return;
            }

            pending.deciding = true;
            try {
                await this.handlePermissionResponse(message, pending);
            } catch (error) {
                pending.deciding = false;
                throw error; // Preserve the pending request; a failed setter is not an approval.
            }
        });
    }

    /**
     * Gets the responses map (for compatibility with existing code)
     */
    getResponses(): Map<string, PermissionResponse> {
        return this.responses;
    }

    getResponseForToolUseId(toolCallId: string): PermissionResponse | undefined {
        const exact = this.responses.get(toolCallId);
        if (exact) {
            return exact;
        }

        let match: PermissionResponse | undefined;
        const suffix = `:${toolCallId}`;
        for (const [id, response] of this.responses.entries()) {
            if (!id.endsWith(suffix)) {
                continue;
            }
            if (match) {
                return undefined;
            }
            match = response;
        }
        return match;
    }

    getResponseLookup(): PermissionResponseLookup {
        return {
            get: (toolCallId: string) => this.getResponseForToolUseId(toolCallId),
            has: (toolCallId: string) => this.getResponseForToolUseId(toolCallId) !== undefined,
        };
    }
}
