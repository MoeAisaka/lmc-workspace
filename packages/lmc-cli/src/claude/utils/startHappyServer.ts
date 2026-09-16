/**
 * Happy MCP server
 * Provides LMC CLI specific tools including chat session title management
 *
 * Uses stateless StreamableHTTP: each request gets a fresh McpServer + transport.
 * This is required by MCP SDK >=1.27 which rejects reuse of an already-connected transport.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { renderTranscript, type TranscriptEntry } from '@/utils/sessionTranscript';
import { relationTo, type Relation } from '@/modules/orchestration/roles';
import { boardUpdate } from '@/modules/orchestration/board';
import { ORCHESTRATION_TOOL_DEFS, ORCHESTRATION_TOOL_NAMES } from '@/modules/orchestration/toolSchemas';
import { assignTask, configureWorker, reportTask, reviewReport, spawnWorker, type OrchestrationPort } from '@/modules/orchestration/tools';
import { spawnDaemonSessionWith } from '@/daemon/controlClient';
import type { TaskMeter } from '@/modules/orchestration/meter';
import { createServer } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { AddressInfo } from "node:net";
import { z } from "zod";
import { logger } from "@/ui/logger";
import { ApiSessionClient } from "@/api/apiSession";
import { AGENT_MAIL_MAX_HOPS, type AgentMailClient } from "@/modules/agentMail/agentMail";
import { randomUUID } from "node:crypto";

/**
 * What the handoff tool needs from the session it belongs to: whether a switch
 * is waiting on one, and somewhere to put it. Kept as a port rather than the
 * session client itself, so the tool can be tested without a live session.
 */
export interface HandoffPort {
    isPending(): boolean;
    /** Returns false when the submission said nothing worth handing over. */
    submit(document: unknown): boolean;
}

/** Full capability set; the registration test keeps this aligned with the actual server. */
export const HAPPY_MCP_TOOL_NAMES = [
    'change_title', 'list_sessions', 'send_to_session', 'submit_handoff', 'read_session_transcript',
    ...ORCHESTRATION_TOOL_NAMES,
] as const;

export function createMcpServer(
    handler: (title: string) => Promise<{ success: boolean; error?: string }>,
    mail: AgentMailClient | null,
    handoff: HandoffPort | null,
    transcript: ((opts: { limit: number; beforeSeq?: number }) => Promise<{ entries: TranscriptEntry[]; hasMore: boolean }>) | null,
    relation: (otherSessionId: string) => Relation = () => null,
    onBoard: ((update: (m: import('@/api/types').Metadata) => import('@/api/types').Metadata) => Promise<void>) | null = null,
    orchestration: OrchestrationPort | null = null,
): McpServer {
    const mcp = new McpServer({
        name: "Happy MCP",
        version: "1.0.0",
    });

    // The session's own record, for the engine to read. Registered always: a
    // session that has never changed hands still has a past its engine may
    // want to check, and MCP clients read the tool list once at startup.
    if (transcript) {
        mcp.registerTool('read_session_transcript', {
            description: 'Read this session\'s own transcript — the one record covering every engine that has worked on it, on any machine. Use it after taking a session over when the handoff briefing is not enough, or to check what was actually said or done earlier. Returns the most recent messages first; pass before_seq to page further back.',
            title: 'Read Session Transcript',
            inputSchema: {
                count: z.number().int().min(1).max(200).optional().describe('How many messages to read (default 60).'),
                before_seq: z.number().int().min(1).optional().describe('Read the messages before this sequence number; the previous page tells you which value to pass.'),
            },
        }, async (args) => {
            try {
                const page = await transcript({ limit: args.count ?? 60, beforeSeq: args.before_seq });
                const rendered = renderTranscript(page.entries);
                if (!rendered.text) {
                    return { content: [{ type: 'text', text: page.hasMore && rendered.oldestSeq ? `Nothing readable in this page; try before_seq=${rendered.oldestSeq}.` : 'The transcript has nothing earlier.' }], isError: false };
                }
                const footer = page.hasMore && rendered.oldestSeq
                    ? `\n\n(${rendered.shown} messages shown, oldest first. Earlier messages exist: call again with before_seq=${rendered.oldestSeq}.)`
                    : `\n\n(${rendered.shown} messages shown, oldest first. This is the start of the session.)`;
                return { content: [{ type: 'text', text: rendered.text + footer }], isError: false };
            } catch (error) {
                return { content: [{ type: 'text', text: `Could not read the transcript: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
            }
        });
    }

    mcp.registerTool('change_title', {
        description: 'Change the title of the current chat session',
        title: 'Change Chat Title',
        inputSchema: {
            title: z.string().describe('The new title for the chat session'),
        },
    }, async (args) => {
        const response = await handler(args.title);
        logger.debug('[happyMCP] Response:', response);

        if (response.success) {
            return {
                content: [
                    {
                        type: 'text',
                        text: `Successfully changed chat title to: "${args.title}"`,
                    },
                ],
                isError: false,
            };
        } else {
            return {
                content: [
                    {
                        type: 'text',
                        text: `Failed to change chat title: ${response.error || 'Unknown error'}`,
                    },
                ],
                isError: true,
            };
        }
    });

    // Registered whether or not a switch is queued: MCP clients read the tool
    // list once at startup, so a tool that appears later is one the model never
    // sees. Calling it outside a switch is refused by the handler instead.
    if (handoff) {
        mcp.registerTool('submit_handoff', {
            description: 'Hand this session over to the engine taking it next. Call this only when the user has asked to change engine and you have been asked for a handoff. Write for a colleague who has none of your memory and cannot see this conversation — not for your user. State what they need to continue, not what you did.',
            title: 'Submit Handoff',
            inputSchema: {
                goal: z.string().describe('What the user is trying to get. Not what you just did.'),
                done: z.string().describe('What is finished and verified.'),
                pending: z.string().optional().describe('What is started or intended but not finished.'),
                files: z.array(z.string()).optional().describe('Files touched and why — a path alone says nothing.'),
                pitfalls: z.array(z.string()).optional().describe('Dead ends, environment quirks, things not worth trying again.'),
                nextStep: z.string().describe('The specific first action for whoever picks this up.'),
                openQuestions: z.array(z.string()).optional().describe('Anything needing the user to decide.'),
            },
        }, async (args) => {
            if (!handoff.isPending()) {
                return { content: [{ type: 'text', text: 'There is no switch to hand over for. If you were just asked to write a handoff, that request was addressed to the engine that ran this session before you — it has already handed over, and you are the one taking it on. Do not retry; tell the user you have taken over and carry on.' }], isError: true };
            }
            return handoff.submit(args)
                ? { content: [{ type: 'text', text: 'Handoff recorded. The session will move to the other engine once this turn ends.' }], isError: false }
                : { content: [{ type: 'text', text: 'Handoff rejected: it said nothing the next engine could act on. Fill in at least the goal, what is done, and the next step.' }], isError: true };
        });
    }

    // Only when the center supports it, so an older center leaves the agent
    // with the tool set it had.
    if (mail) {
        mcp.registerTool('list_sessions', {
            description: 'List the other live agent sessions on this account, so one can be written to with send_to_session.',
            title: 'List Agent Sessions',
            inputSchema: {},
        }, async () => {
            const entries = await mail.list();
            if (entries.length === 0) {
                return { content: [{ type: 'text', text: 'No other live sessions.' }], isError: false };
            }
            const mark = (id: string) => { const r = relation(id); return r === 'hub' ? ' [your hub]' : r === 'worker' ? ' [your worker]' : ''; };
            const lines = entries.map((entry) => `${entry.sessionId}${mark(entry.sessionId)} — ${entry.descriptor.machine} · ${entry.descriptor.engine} · ${entry.descriptor.title}${entry.descriptor.path ? ` (${entry.descriptor.path})` : ''}`);
            return { content: [{ type: 'text', text: lines.join('\n') }], isError: false };
        });

        mcp.registerTool('send_to_session', {
            description: `Write to another agent session on this account. The recipient sees it as agent mail, not as its user speaking. A message may be relayed at most ${AGENT_MAIL_MAX_HOPS} times, so do not use this to hold a long conversation.`,
            title: 'Write To Another Session',
            inputSchema: {
                sessionId: z.string().describe('Recipient session id, from list_sessions'),
                text: z.string().describe('What to say'),
                hop: z.number().int().min(1).max(AGENT_MAIL_MAX_HOPS).optional()
                    .describe('Relay count. Omit when writing on your own initiative; when answering agent mail, pass the number the incoming message told you.'),
            },
        }, async (args) => {
            // Inside a binding nothing is relayed, so the hop counter does not
            // apply: a hub and its worker may go back and forth as many times
            // as a task needs.
            const bound = relation(args.sessionId) !== null;
            const result = await mail.send(args.sessionId, args.text, bound ? 1 : (args.hop ?? 1));
            // A task or report that went out moves the board.
            if (result.ok && bound) { const update = boardUpdate(args.text, args.sessionId); if (update) await onBoard?.(update); }
            return result.ok
                ? { content: [{ type: 'text', text: `Delivered to ${args.sessionId}.` }], isError: false }
                : { content: [{ type: 'text', text: result.error }], isError: true };
        });

        // Hub and worker tools. Registered for every session that has mail:
        // a session becomes a hub by calling spawn_worker, and a worker that
        // was bound after startup still needs report_task on its list.
        if (orchestration) {
            const wrap = (run: () => Promise<{ text: string; isError: boolean }>) => async () => {
                try { const r = await run(); return { content: [{ type: 'text' as const, text: r.text }], isError: r.isError }; }
                catch (error) { return { content: [{ type: 'text' as const, text: error instanceof Error ? error.message : String(error) }], isError: true }; }
            };
            mcp.registerTool('spawn_worker', ORCHESTRATION_TOOL_DEFS.spawn_worker, (args) => wrap(() => spawnWorker(orchestration, args as any))());
            mcp.registerTool('assign_task', ORCHESTRATION_TOOL_DEFS.assign_task, (args) => wrap(() => assignTask(orchestration, args as any))());
            mcp.registerTool('report_task', ORCHESTRATION_TOOL_DEFS.report_task, (args) => wrap(() => reportTask(orchestration, args as any))());
            mcp.registerTool('review_report', ORCHESTRATION_TOOL_DEFS.review_report, (args) => wrap(() => reviewReport(orchestration, args as any))());
            mcp.registerTool('configure_worker', ORCHESTRATION_TOOL_DEFS.configure_worker, (args) => wrap(() => configureWorker(orchestration, args as any))());
        }
    }

    return mcp;
}

/** What the runner knows that the tools need: where it runs and on which machine. */
export interface OrchestrationHost { cwd: string; machineId: string; meter?: TaskMeter }

export async function startHappyServer(client: ApiSessionClient, mail: AgentMailClient | null = null, handoff: HandoffPort | null = null, host: OrchestrationHost | null = null) {
    logger.debug(`[happyMCP] server:start sessionId=${client.sessionId}`);

    const handler = async (title: string) => {
        logger.debug('[happyMCP] Changing title to:', title);
        try {
            client.sendClaudeSessionMessage({
                type: 'summary',
                summary: title,
                leafUuid: randomUUID()
            });
            return { success: true };
        } catch (error) {
            return { success: false, error: String(error) };
        }
    };

    const orchestration: OrchestrationPort | null = mail && host ? {
        selfId: client.sessionId,
        metadata: () => client.getMetadata(),
        updateMetadata: (update) => client.updateMetadata(update, { strict: true }),
        cwd: host.cwd,
        machineId: host.machineId,
        machineName: () => { const m = client.getMetadata(); return m?.name || m?.host || host.machineId; },
        spawnLocal: (options) => spawnDaemonSessionWith(options),
        sendMail: (sessionId, text) => mail.send(sessionId, text, 1),
        transcript: (opts) => client.readTranscript(opts),
        listPeers: async () => (await mail.list()).map((entry) => ({ sessionId: entry.sessionId, title: entry.descriptor.title })),
        meter: host.meter,
    } : null;
    const server = createServer(async (req, res) => {
        const mcp = createMcpServer(handler, mail, handoff, (opts) => client.readTranscript(opts), (other) => relationTo(client.getMetadata()?.orchestration, other), (update) => client.updateMetadata(update, { strict: true }), orchestration);
        try {
            const transport = new StreamableHTTPServerTransport({
                sessionIdGenerator: undefined
            });
            await mcp.connect(transport);
            await transport.handleRequest(req, res);
            res.on('close', () => {
                transport.close();
                mcp.close();
            });
        } catch (error) {
            logger.debug("Error handling request:", error);
            if (!res.headersSent) {
                res.writeHead(500).end();
            }
            mcp.close();
        }
    });

    const baseUrl = await new Promise<URL>((resolve) => {
        server.listen(0, "127.0.0.1", () => {
            const addr = server.address() as AddressInfo;
            resolve(new URL(`http://127.0.0.1:${addr.port}`));
        });
    });

    logger.debug(`[happyMCP] server:ready sessionId=${client.sessionId} url=${baseUrl.toString()}`);

    return {
        url: baseUrl.toString(),
        toolNames: HAPPY_MCP_TOOL_NAMES.filter(name => {
            if (name === 'submit_handoff') return !!handoff;
            if (name === 'list_sessions' || name === 'send_to_session') return !!mail;
            if ((ORCHESTRATION_TOOL_NAMES as readonly string[]).includes(name)) return !!orchestration;
            return true;
        }),
        stop: () => {
            logger.debug(`[happyMCP] server:stop sessionId=${client.sessionId}`);
            server.close();
        }
    }
}
