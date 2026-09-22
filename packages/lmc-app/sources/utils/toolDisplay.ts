import { ToolCall } from '@/sync/typesMessage';
import { t } from '@/text';
import { stringifyToolCommand } from './toolCommand';

const TERMINAL_TOOL_NAMES = new Set([
    'Bash',
    'CodexBash',
    'GeminiBash',
    'shell',
    'execute',
    'exec_command',
    'run_terminal_command',
    'write_stdin',
]);

const EDIT_TOOL_NAMES = new Set([
    'Edit',
    'MultiEdit',
    'Write',
    'CodexPatch',
    'GeminiPatch',
    'edit',
    'NotebookEdit',
    'apply_patch',
    'search_replace',
]);

const READ_TOOL_NAMES = new Set([
    'Read',
    'read',
    'NotebookRead',
    'LS',
    'read_file',
    'read_agent_history',
    'view_image',
    'get_provider_usage',
    'get_goal',
    'agent_info',
]);

const SEARCH_TOOL_NAMES = new Set([
    'Grep',
    'Glob',
    'grep',
    'search',
    'WebSearch',
    'list_dir',
    'list_agents',
    'list_projects',
    'list_workspaces',
    'list_workspace_sessions',
    'TaskList',
]);

const WEB_TOOL_NAMES = new Set([
    'WebFetch',
]);

const TASK_TOOL_NAMES = new Set([
    'Task',
    'Agent',
    'TaskCreate',
    'TaskOutput',
    'TaskStop',
    'TaskUpdate',
    'Workflow',
    'archive_workspace',
    'create_goal',
    'create_workspace',
    'delegate_to_workspace',
    'followup_task',
    'interrupt_agent',
    'schedule_message',
    'send_message',
    'agent_me',
    'agent_send',
    'spawn_agent',
    'stop_workflow',
    'update_goal',
    'update_plan',
    'wait_agent',
    'wait_for_workflow',
    'workflow',
    'workflow_status',
]);

const INTERACTIVE_QUESTION_TOOL_NAMES = new Set([
    'AskUserQuestion',
    'request_user_input',
]);

export type ToolSummaryCategory = 'terminal' | 'edit' | 'read' | 'search' | 'web' | 'task' | 'other';

/** Formats `mcp__linear__create_issue` as `MCP: Linear Create Issue`. */
export function formatMCPTitle(toolName: string): string {
    const parts = toolName.replace(/^mcp__/, '').split('__');
    const formattedParts = parts.map(formatSnakeCaseTitle);
    return `MCP: ${formattedParts.join(' ')}`;
}

export function isTerminalToolName(name: string): boolean {
    return TERMINAL_TOOL_NAMES.has(name);
}

/**
 * Patch tools draw a header per changed file, naming the file and its stats.
 * A card header above that would only repeat the same name, so it is dropped.
 */
const SELF_HEADING_TOOL_NAMES = new Set(['CodexPatch', 'GeminiPatch']);

export function shouldRenderToolCardHeader(toolName: string, _platformOS: string): boolean {
    return !SELF_HEADING_TOOL_NAMES.has(toolName);
}

/**
 * Compact mode is deliberately name-agnostic so newly introduced provider
 * tools do not fall back to a half-screen raw JSON card. User attachments and
 * controls that require inline context stay expanded.
 */
export function shouldUseCompactToolRow(
    tool: Pick<ToolCall, 'name' | 'permission'>,
    compactMode: boolean,
): boolean {
    if (!compactMode || tool.name === 'file' || isInteractiveQuestionToolName(tool.name)) {
        return false;
    }

    const isPlanProposal = tool.name === 'ExitPlanMode' || tool.name === 'exit_plan_mode';
    if (isPlanProposal && tool.permission?.status === 'pending') {
        return false;
    }

    return true;
}

export function isInteractiveQuestionToolName(name: string): boolean {
    return INTERACTIVE_QUESTION_TOOL_NAMES.has(name);
}

export function getToolSummaryCategory(toolName: string): ToolSummaryCategory {
    if (TERMINAL_TOOL_NAMES.has(toolName)) {
        return 'terminal';
    }
    if (EDIT_TOOL_NAMES.has(toolName)) {
        return 'edit';
    }
    if (READ_TOOL_NAMES.has(toolName)) {
        return 'read';
    }
    if (SEARCH_TOOL_NAMES.has(toolName)) {
        return 'search';
    }
    if (WEB_TOOL_NAMES.has(toolName)) {
        return 'web';
    }
    if (TASK_TOOL_NAMES.has(toolName)) {
        return 'task';
    }
    return 'other';
}

export function getToolSummaryDetail(tool: Pick<ToolCall, 'name' | 'input' | 'description'>): string | null {
    const terminalCommand = getTerminalToolCommand(tool);
    if (terminalCommand) {
        return terminalCommand;
    }

    const filePath = tool.input?.file_path ?? tool.input?.target_file;
    if (typeof filePath === 'string' && filePath.trim().length > 0) {
        return filePath.trim();
    }

    const patchFiles = getPatchFiles(tool.input);
    if (patchFiles.length > 0) {
        if (patchFiles.length === 1) {
            return patchFiles[0];
        }
        return `${patchFiles[0]} +${patchFiles.length - 1}`;
    }

    const path = tool.input?.path ?? tool.input?.target_directory;
    if (typeof path === 'string' && path.trim().length > 0) {
        return path.trim();
    }

    const pattern = tool.input?.pattern;
    if (typeof pattern === 'string' && pattern.trim().length > 0) {
        return pattern.trim();
    }

    const url = tool.input?.url;
    if (typeof url === 'string' && url.trim().length > 0) {
        return url.trim();
    }

    return tool.description?.trim() || null;
}

/**
 * A concise, human-readable label for a tool activity row. Prefer a
 * provider-supplied description when it adds information beyond the raw
 * command/path, then fall back to a localized action and its detail.
 */
export function getToolActivityLabel(tool: Pick<ToolCall, 'name' | 'input' | 'description'>): string {
    const summaryDetail = getToolSummaryDetail(tool);
    const detail = isGenericToolDescription(tool.name, summaryDetail) ? null : summaryDetail;
    const providerDescription = getProviderActivityDescription(tool, detail);
    if (providerDescription) {
        return providerDescription;
    }

    const action = getToolActivityAction(getToolSummaryCategory(tool.name), tool.name);
    if (!detail || normalizeActivityText(detail) === normalizeActivityText(action)) {
        return action;
    }
    return `${action}: ${detail}`;
}

/** Timeline titles deliberately exclude raw arguments, paths and output. */
export function getTimelineToolLabel(tool: Pick<ToolCall, 'name' | 'input' | 'description'>): string {
    const detail = getToolSummaryDetail({ ...tool, description: null });
    for (const description of [tool.input?.description, tool.description]) {
        if (typeof description !== 'string') continue;
        const label = getProviderActivityDescription({ ...tool, description }, detail);
        // Only short prose supplied by the provider is a trustworthy purpose.
        if (label && label.length <= 64 && !/[\n\r`/\\;|<>{}=]/u.test(label)
            && !/^(?:ran|running|executed?|执行了?)\s*\d*\s*(?:commands?|个?命令)[:：]/iu.test(label)
            && !label.includes(' --')) return label;
    }
    const category = getToolSummaryCategory(tool.name);
    let target: string | null = null;
    if (category === 'terminal') {
        target = commandExecutable(getTerminalToolCommand(tool));
    } else if (category === 'read' || category === 'edit') {
        const path = tool.input?.file_path ?? tool.input?.target_file ?? tool.input?.path ?? getPatchFiles(tool.input)[0];
        if (typeof path === 'string') target = path.trim().split(/[\\/]/u).filter(Boolean).pop() ?? null;
    } else if (category === 'web') {
        try { target = new URL(tool.input?.url).hostname; } catch { /* No reliable host. */ }
    }
    const action = category === 'other' || category === 'task'
        ? getToolActivityAction(category, tool.name)
        : t(`toolGroup.timeline.${category}Action`);
    return target ? `${action} · ${target}` : action;
}

function commandExecutable(command: string | null): string | null {
    if (!command) return null;
    // Unwrap only an explicit shell -c argument, never interpret shell code.
    const wrapped = command.match(/^(?:\S*\/)?(?:ba|z|da)?sh\s+-[a-z]*c\s+([\s\S]+)$/u);
    let source = wrapped ? wrapped[1].trim() : command;
    if (wrapped && ((source.startsWith("'") && source.endsWith("'")) || (source.startsWith('"') && source.endsWith('"')))) source = source.slice(1, -1);
    source = source.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=[^\s]+\s+)*/u, '');
    const token = source.match(/^\/?(?:[\w.~-]+\/)*([A-Za-z0-9_][A-Za-z0-9_.+-]*)(?=\s|$)/u)?.[1];
    return token ?? null;
}

export function getTerminalToolCommand(tool: Pick<ToolCall, 'name' | 'input'>): string | null {
    if (!isTerminalToolName(tool.name)) {
        return null;
    }

    const parsedCmd = tool.input?.parsed_cmd;
    if (Array.isArray(parsedCmd) && parsedCmd.length > 0) {
        const cmd = parsedCmd.find((item) => typeof item?.cmd === 'string' && item.cmd.trim().length > 0)?.cmd;
        if (cmd) {
            return cmd.trim();
        }
    }

    const directCommand = stringifyToolCommand(tool.input?.command ?? tool.input?.cmd);
    if (directCommand) {
        return directCommand;
    }

    const title = tool.input?.toolCall?.title;
    if (typeof title === 'string') {
        const bracketIdx = title.indexOf(' [');
        const command = bracketIdx > 0 ? title.substring(0, bracketIdx) : title;
        const trimmed = command.trim();
        if (trimmed.length > 0) {
            return trimmed;
        }
    }

    return null;
}

function getProviderActivityDescription(
    tool: Pick<ToolCall, 'name' | 'description'>,
    detail: string | null,
): string | null {
    const description = tool.description?.trim();
    if (!description || normalizeActivityText(description) === normalizeActivityText(detail ?? '')) {
        return null;
    }

    const normalizedDescription = normalizeActivityText(description);
    const genericDescriptions = new Set([
        normalizeActivityText(tool.name),
        normalizeActivityText(`Running ${formatToolName(tool.name)}`),
        'terminal',
        'bash',
        'run command',
        'running command',
        'search',
        'web search',
        'read',
        'read file',
        'edit',
        'edit file',
        'write',
        'write file',
        'fetch url',
        'task',
    ]);
    if (genericDescriptions.has(normalizedDescription)) {
        return null;
    }

    return description;
}

function getToolActivityAction(category: ToolSummaryCategory, toolName: string): string {
    switch (category) {
        case 'terminal':
            return t('toolGroup.ranCommands', { count: 1 });
        case 'edit':
            return t('toolGroup.editedFiles', { count: 1 });
        case 'read':
            return t('toolGroup.readFiles', { count: 1 });
        case 'search':
            return t('toolGroup.searched', { count: 1 });
        case 'web':
            return t('toolGroup.fetchedUrls', { count: 1 });
        case 'task':
            return toolName === 'Task' || toolName === 'Agent'
                ? t('toolGroup.ranTasks', { count: 1 })
                : formatToolName(toolName);
        default:
            return toolName.startsWith('mcp__')
                ? formatMCPTitle(toolName)
                : formatToolName(toolName);
    }
}

function normalizeActivityText(value: string): string {
    return value.trim().replace(/\s+/g, ' ').toLowerCase();
}

function isGenericToolDescription(toolName: string, value: string | null): boolean {
    if (!value) {
        return false;
    }
    const normalized = normalizeActivityText(value);
    return normalized === normalizeActivityText(toolName)
        || normalized === normalizeActivityText(formatToolName(toolName))
        || normalized === normalizeActivityText(`Running ${formatToolName(toolName)}`);
}

function formatSnakeCaseTitle(value: string): string {
    return value
        .split('_')
        .filter(Boolean)
        .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
        .join(' ');
}

function formatToolName(value: string): string {
    return value
        .replaceAll(/[_-]+/gu, ' ')
        .replaceAll(/([a-z])([A-Z])/gu, '$1 $2')
        .trim()
        .split(/\s+/u)
        .filter(Boolean)
        .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
        .join(' ');
}

function getPatchFiles(input: any): string[] {
    if (input?.changes && typeof input.changes === 'object' && !Array.isArray(input.changes)) {
        return Object.keys(input.changes);
    }
    if (input?.fileChanges && typeof input.fileChanges === 'object' && !Array.isArray(input.fileChanges)) {
        return Object.keys(input.fileChanges);
    }
    if (Array.isArray(input?.changes)) {
        return input.changes
            .map((change: unknown) => {
                if (!change || typeof change !== 'object' || Array.isArray(change)) {
                    return null;
                }
                const path = (change as { path?: unknown }).path;
                return typeof path === 'string' && path.trim().length > 0 ? path.trim() : null;
            })
            .filter((path: string | null): path is string => path !== null);
    }
    if (Array.isArray(input?.fileChanges)) {
        return input.fileChanges
            .map((change: unknown) => {
                if (!change || typeof change !== 'object' || Array.isArray(change)) {
                    return null;
                }
                const path = (change as { path?: unknown }).path;
                return typeof path === 'string' && path.trim().length > 0 ? path.trim() : null;
            })
            .filter((path: string | null): path is string => path !== null);
    }
    return [];
}
