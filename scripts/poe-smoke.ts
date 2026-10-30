/** Explicit opt-in live check: one synthetic, max-16-token Messages request; no project data. */
import { readPoeSettings, fetchPoeJson, poeClaudeEnvironment } from '../packages/lmc-cli/src/runtime/poe';
import { parsePoePoints } from '../packages/lmc-cli/src/daemon/poeBalance';
import { configuration } from '../packages/lmc-cli/src/configuration';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

async function main() {
    if (!['--live', '--auth', '--cli'].includes(process.argv[2])) throw new Error('Pass --live for one billable request, --cli for a synthetic Claude CLI request, or --auth for the local auth preflight.');
    const settings = readPoeSettings();
    if (!settings?.enabled) throw new Error('Poe is not enabled.');
    if (process.argv[2] === '--auth' || process.argv[2] === '--cli') {
        const selection = JSON.parse(readFileSync(join(configuration.lmcHomeDir, 'runtime-selection.json'), 'utf8'));
        const executable = join(selection.claude.directory, 'node_modules', `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`, process.platform === 'win32' ? 'claude.exe' : 'claude');
        if (process.argv[2] === '--cli') {
            const dir = mkdtempSync(join(tmpdir(), 'lmc-poe-cli-smoke-'));
            try {
                const { stdout } = await promisify(execFile)(executable, [
                    '--print', '--model', 'claude-haiku-4.5', '--tools', '', '--disable-slash-commands',
                    '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--setting-sources', '',
                    '--no-session-persistence', '--output-format', 'json', '--system-prompt', 'You are an API connectivity check.',
                    'Reply with exactly POE_OK and nothing else.',
                ], { cwd: dir, env: { ...process.env, ...poeClaudeEnvironment(settings),
                    CLAUDE_CONFIG_DIR: dir, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', CLAUDE_CODE_MAX_OUTPUT_TOKENS: '32', MAX_THINKING_TOKENS: '0' },
                    timeout: 45_000, maxBuffer: 262_144, windowsHide: true });
                const reply = JSON.parse(stdout);
                const ok = reply.is_error === false && reply.result?.trim() === 'POE_OK';
                console.log(JSON.stringify({ at: new Date().toISOString(), check: 'managed-claude-print', markerMatched: ok }));
                if (!ok) process.exitCode = 1;
            } catch (error) {
                const failure = error as { code?: number; stdout?: string; stderr?: string };
                let details = failure.stderr ?? '';
                try { details = JSON.parse(failure.stdout ?? '{}').result ?? details; } catch { /* no raw stdout */ }
                const sanitized = String(details).split(settings.apiKey).join('[REDACTED]').replace(/(?:Bearer\s+|sk-)[\w.-]+/gi, '[REDACTED]').slice(0, 1200);
                console.log(JSON.stringify({ check: 'managed-claude-print', exitCode: failure.code ?? null, diagnostic: sanitized }));
                process.exitCode = 1;
            } finally { rmSync(dir, { recursive: true, force: true }); }
            return;
        }
        const { stdout } = await promisify(execFile)(executable, ['auth', 'status', '--json'], {
            env: { ...process.env, ...poeClaudeEnvironment(settings) }, timeout: 15_000, maxBuffer: 16_384, windowsHide: true,
        });
        const ready = JSON.parse(stdout).loggedIn === true;
        console.log(JSON.stringify({ at: new Date().toISOString(), check: 'managed-claude-auth-status', ready }));
        if (!ready) process.exitCode = 1;
        return;
    }
    const model = 'claude-haiku-4.5';
    const response = await fetch('https://api.poe.com/v1/messages', {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30_000),
        headers: { Authorization: `Bearer ${settings.apiKey}`, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, max_tokens: 16, messages: [{ role: 'user', content: 'Reply with exactly POE_OK and nothing else.' }] }),
    });
    if (!response.ok) { await response.body?.cancel(); throw new Error(`Messages HTTP ${response.status}`); }
    const data = await response.json() as { content?: { type?: string; text?: string }[] };
    const ok = data.content?.filter(c => c.type === 'text').map(c => c.text ?? '').join('').trim() === 'POE_OK';
    const points = parsePoePoints(await fetchPoeJson('/usage/current_balance', settings.apiKey));
    console.log(JSON.stringify({ at: new Date().toISOString(), endpoint: '/v1/messages', model, markerMatched: ok, balancePoints: points }));
    if (!ok) process.exitCode = 1;
}
main().catch(error => {
    // Fetch errors can include provider details: never log raw errors or response bodies.
    console.error(error instanceof Error && /^(Pass --live|Poe is not enabled|Messages HTTP)/.test(error.message) ? error.message : 'Poe live check failed.');
    process.exitCode = 1;
});
