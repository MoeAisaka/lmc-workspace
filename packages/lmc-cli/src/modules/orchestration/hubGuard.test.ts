import { createMcpServer, startHappyServer, HAPPY_MCP_TOOL_NAMES } from '@/claude/utils/startHappyServer';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { describe, expect, it, vi } from 'vitest';
import { hubCodexPermissionMode, hubDisallowedTools, hubCodexApprovalDenied, HUB_CODEX_DENIAL, hubCodexMcpTools } from './hubGuard';
const hub = { orchestration: { role: 'hub', workers: [] } } as any;
const worker = { orchestration: { role: 'worker', hub: { sessionId: 'H', boundAt: 1, by: 'auto' } } } as any;
describe('hub guard', () => {
    it('leaves a hub\'s own disallowedTools untouched: identity is not a restriction', () => {
        expect(hubDisallowedTools(hub, undefined)).toBeUndefined();
        expect(hubDisallowedTools(hub, ['WebSearch'])).toEqual(['WebSearch']);
        expect(hubDisallowedTools(worker, ['X'])).toEqual(['X']);
        expect(hubDisallowedTools(null, undefined)).toBeUndefined();
    });
    it('does not override a hub\'s requested Codex permission mode', () => {
        expect(hubCodexPermissionMode(hub, 'yolo')).toBe('yolo');
        expect(hubCodexPermissionMode(worker, 'yolo')).toBe('yolo');
    });
});


describe('Codex hub guard', () => {
    it('never denies approvals on hub role or a late turnWasHub flag alone', () => {
        expect(hubCodexApprovalDenied(hub)).toBe(false);
        expect(hubCodexApprovalDenied(worker, true)).toBe(false);
        expect(hubCodexApprovalDenied(null, true)).toBe(false);
        expect(hubCodexApprovalDenied(worker)).toBe(false);
        expect(hubCodexApprovalDenied(null)).toBe(false);
    });
    it('leaves every requested Codex permission mode unchanged for hub and worker alike', () => {
        for (const mode of ['yolo', 'safe-yolo', 'auto', 'default', 'read-only']) {
            expect(hubCodexPermissionMode(hub, mode)).toBe(mode);
            expect(hubCodexPermissionMode(worker, mode)).toBe(mode);
        }
    });
});


it('trusts only the named Happy bridge tools for hubs, leaving normal sessions unchanged', () => {
    const tools = hubCodexMcpTools(hub)!;
    expect(Object.keys(tools).sort()).toEqual([...HAPPY_MCP_TOOL_NAMES].sort());
    expect(Object.values(tools).every(value => value.approval_mode === 'approve')).toBe(true);
    expect(tools.exec_command).toBeUndefined();
    expect(tools.apply_patch).toBeUndefined();
    expect(hubCodexMcpTools(worker)).toEqual({ report_task: { approval_mode: 'approve' } });
    expect(hubCodexMcpTools(null)).toBeUndefined();
});


it.each([
    { name: 'all dependencies', mail: true, handoff: true, orchestration: true },
    { name: 'no mail or orchestration', mail: false, handoff: false, orchestration: false },
    { name: 'mail without orchestration', mail: true, handoff: true, orchestration: false },
])('matches actual registration with $name', async (dependencies) => {
    const register = vi.spyOn(McpServer.prototype, 'registerTool');
    let server: McpServer | undefined;
    let running: Awaited<ReturnType<typeof startHappyServer>> | undefined;
    const mail = dependencies.mail ? {} as any : null;
    const handoff = dependencies.handoff ? { isPending: () => false, submit: () => false } : null;
    try {
        // startHappyServer always supplies the transcript callback.
        server = createMcpServer(async () => ({ success: true }), mail, handoff,
            async () => ({ entries: [], hasMore: false }), () => null, null,
            dependencies.orchestration ? {} as any : null);
        running = await startHappyServer({ sessionId: 'test' } as any, mail, handoff,
            dependencies.orchestration ? { cwd: '/tmp', machineId: 'test' } : null);
        const registered = register.mock.calls.map(call => call[0] as string).sort();
        expect(running.toolNames.sort()).toEqual(registered);
        if (dependencies.orchestration) {
            expect(Object.keys(hubCodexMcpTools(hub)!).sort()).toEqual(registered);
            expect([...HAPPY_MCP_TOOL_NAMES].sort()).toEqual(registered);
        }
    } finally {
        running?.stop();
        register.mockRestore();
        await server?.close();
    }
});
