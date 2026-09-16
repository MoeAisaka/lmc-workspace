/**
 * Happy MCP STDIO Bridge
 *
 * Minimal STDIO MCP server exposing a single tool `change_title`.
 * On invocation it forwards the tool call to an existing Happy HTTP MCP server
 * using the StreamableHTTPClientTransport.
 *
 * Configure the target HTTP MCP URL via env var `HAPPY_HTTP_MCP_URL` or
 * via CLI flag `--url <http://127.0.0.1:PORT>`.
 *
 * Note: This process must not print to stdout as it would break MCP STDIO.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { z } from 'zod';
import { ORCHESTRATION_TOOL_DEFS, ORCHESTRATION_TOOL_NAMES } from '@/modules/orchestration/toolSchemas';

function parseArgs(argv: string[]): { url: string | null } {
  let url: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--url' && i + 1 < argv.length) {
      url = argv[i + 1];
      i++;
    }
  }
  return { url };
}

async function main() {
  // Resolve target HTTP MCP URL
  const { url: urlFromArgs } = parseArgs(process.argv.slice(2));
  const baseUrl = urlFromArgs || process.env.HAPPY_HTTP_MCP_URL || '';

  if (!baseUrl) {
    // Write to stderr; never stdout.
    process.stderr.write(
      '[happy-mcp] Missing target URL. Set HAPPY_HTTP_MCP_URL or pass --url <http://127.0.0.1:PORT>\n'
    );
    process.exit(2);
  }

  let httpClient: Client | null = null;

  async function ensureHttpClient(): Promise<Client> {
    if (httpClient) return httpClient;
    const client = new Client(
      { name: 'happy-stdio-bridge', version: '1.0.0' },
      { capabilities: {} }
    );

    const transport = new StreamableHTTPClientTransport(new URL(baseUrl));
    await client.connect(transport);
    httpClient = client;
    return client;
  }

  // Create STDIO MCP server
  const server = new McpServer({
    name: 'Happy MCP Bridge',
    version: '1.0.0',
  });

  // Register the single tool and forward to HTTP MCP
  server.registerTool(
    'change_title',
    {
      description: 'Change the title of the current chat session',
      title: 'Change Chat Title',
      inputSchema: {
        title: z.string().describe('The new title for the chat session'),
      },
    },
    async (args) => {
      try {
        const client = await ensureHttpClient();
        const response = await client.callTool({ name: 'change_title', arguments: args });
        // Pass-through response from HTTP server
        return response as any;
      } catch (error) {
        return {
          content: [
            { type: 'text', text: `Failed to change chat title: ${error instanceof Error ? error.message : String(error)}` },
          ],
          isError: true,
        };
      }
    }
  );

  // Agent mail, forwarded the same way. Declared here rather than discovered
  // from the HTTP server because this bridge is spawned by Codex before the
  // session's server is necessarily reachable; a tool the center does not
  // support answers with its own error rather than going missing.
  const forward = (name: string) => async (args: Record<string, unknown>) => {
    try {
      const client = await ensureHttpClient();
      return await client.callTool({ name, arguments: args }) as any;
    } catch (error) {
      return {
        content: [{ type: 'text', text: `${name} failed: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true,
      };
    }
  };

  server.registerTool(
    'list_sessions',
    {
      description: 'List the other live agent sessions on this account, so one can be written to with send_to_session.',
      title: 'List Agent Sessions',
      inputSchema: {},
    },
    forward('list_sessions'),
  );

  server.registerTool(
    'send_to_session',
    {
      description: 'Write to another agent session on this account. The recipient sees it as agent mail, not as its user speaking.',
      title: 'Write To Another Session',
      inputSchema: {
        sessionId: z.string().describe('Recipient session id, from list_sessions'),
        text: z.string().describe('What to say'),
        hop: z.number().int().min(1).max(4).optional()
          .describe('Relay count. Omit when writing on your own initiative; when answering agent mail, pass the number the incoming message told you.'),
      },
    },
    forward('send_to_session'),
  );

  server.registerTool(
    'submit_handoff',
    {
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
    },
    forward('submit_handoff'),
  );

  server.registerTool(
    'read_session_transcript',
    {
      description: 'Read this session\'s own transcript — the one record covering every engine that has worked on it, on any machine. Use it after taking a session over when the handoff briefing is not enough, or to check what was actually said or done earlier. Returns the most recent messages first; pass before_seq to page further back.',
      title: 'Read Session Transcript',
      inputSchema: {
        count: z.number().int().min(1).max(200).optional().describe('How many messages to read (default 60).'),
        before_seq: z.number().int().min(1).optional().describe('Read the messages before this sequence number; the previous page tells you which value to pass.'),
      },
    },
    forward('read_session_transcript'),
  );

  // Hub-and-workers tools, one definition shared with the HTTP server.
  for (const name of ORCHESTRATION_TOOL_NAMES) {
    server.registerTool(name, ORCHESTRATION_TOOL_DEFS[name], forward(name));
  }

  // Start STDIO transport
  const stdio = new StdioServerTransport();
  await server.connect(stdio);
}

// Start and surface fatal errors to stderr only
main().catch((err) => {
  try {
    process.stderr.write(`[happy-mcp] Fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  } finally {
    process.exit(1);
  }
});

