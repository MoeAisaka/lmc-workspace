import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import {
    assertSafeSharedAccountId,
    prepareAgySharedAccountIsolation,
    resolveClaudeSharedAccountIsolation,
    resolveCodexSharedAccountIsolation,
} from './sharedAccountIsolation';
import { cleanupHookSettingsFile, generateHookSettingsFile } from '@/claude/utils/generateHookSettings';

describe('sharedAccountIsolation', () => {
    const tempDirs: string[] = [];
    const linkCleanups: Array<() => void> = [];
    const hookFiles: string[] = [];

    const makeTempDir = (prefix: string): string => {
        const dir = mkdtempSync(join(os.tmpdir(), prefix));
        tempDirs.push(dir);
        return dir;
    };

    afterEach(() => {
        while (hookFiles.length > 0) {
            const p = hookFiles.pop();
            if (p) cleanupHookSettingsFile(p);
        }
        while (linkCleanups.length > 0) {
            const fn = linkCleanups.pop();
            try {
                fn?.();
            } catch {}
        }
        while (tempDirs.length > 0) {
            const dir = tempDirs.pop();
            if (dir) {
                rmSync(dir, { recursive: true, force: true });
            }
        }
    });

    it('rejects unsafe shared account identifiers', () => {
        expect(assertSafeSharedAccountId('cmi123_alice-01')).toBe('cmi123_alice-01');
        expect(() => assertSafeSharedAccountId('')).toThrow(/Invalid shared account identifier/);
        expect(() => assertSafeSharedAccountId('../escape')).toThrow(/Invalid shared account identifier/);
        expect(() => assertSafeSharedAccountId('alice/bob')).toThrow(/Invalid shared account identifier/);
        expect(() => assertSafeSharedAccountId('alice\\bob')).toThrow(/Invalid shared account identifier/);
    });

    describe('Claude shared-account isolation', () => {
        it('blocks host global settings/MCPs/plugins/skills by default while isolating per-account workspace configs', () => {
            const root = makeTempDir('lmc-claude-iso-');
            const aliceWorkspace = join(root, 'shared-workspaces', 'acct_alice');
            const bobWorkspace = join(root, 'shared-workspaces', 'acct_bob');
            mkdirSync(aliceWorkspace, { recursive: true });
            mkdirSync(bobWorkspace, { recursive: true });

            // Bob has no custom config: must inherit zero host MCPs/plugins/skills
            const bobIso = resolveClaudeSharedAccountIsolation(bobWorkspace);
            expect(bobIso).toEqual({
                settingSources: ['project', 'local'],
                strictMcpConfig: true,
                mcpServers: {},
                plugins: [],
                skills: [],
            });

            // Alice configures her own `.mcp.json`, local plugin, and skills
            writeFileSync(
                join(aliceWorkspace, '.mcp.json'),
                JSON.stringify({
                    mcpServers: {
                        'alice-search': { command: 'npx', args: ['-y', '@alice/search-mcp'] },
                    },
                }),
            );
            const alicePluginDir = join(aliceWorkspace, '.claude', 'plugins', 'alice-kit');
            mkdirSync(join(alicePluginDir, '.claude-plugin'), { recursive: true });
            writeFileSync(join(alicePluginDir, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'alice-kit' }));
            writeFileSync(
                join(alicePluginDir, '.mcp.json'),
                JSON.stringify({
                    'plugin-mcp': { url: 'https://mcp.alice.example/sse' },
                }),
            );
            mkdirSync(join(alicePluginDir, 'skills', 'deploy-helper'), { recursive: true });
            writeFileSync(join(alicePluginDir, 'skills', 'deploy-helper', 'SKILL.md'), '# Deploy\n');

            mkdirSync(join(aliceWorkspace, '.claude', 'skills', 'alice-review'), { recursive: true });
            writeFileSync(join(aliceWorkspace, '.claude', 'skills', 'alice-review', 'SKILL.md'), '# Review\n');
            mkdirSync(join(aliceWorkspace, '.agents', 'skills', 'alice-spec'), { recursive: true });
            writeFileSync(join(aliceWorkspace, '.agents', 'skills', 'alice-spec', 'SKILL.md'), '# Spec\n');

            const aliceIso = resolveClaudeSharedAccountIsolation(aliceWorkspace);
            expect(aliceIso.settingSources).toEqual(['project', 'local']);
            expect(aliceIso.strictMcpConfig).toBe(true);
            expect(aliceIso.mcpServers).toEqual({
                'alice-search': { command: 'npx', args: ['-y', '@alice/search-mcp'] },
                'plugin-mcp': { url: 'https://mcp.alice.example/sse' },
            });
            expect(aliceIso.plugins).toEqual([{ type: 'local', path: alicePluginDir }]);
            expect(aliceIso.skills).toEqual([
                'alice-kit:deploy-helper',
                'alice-review',
                'alice-spec',
                'deploy-helper',
            ]);

            // Re-checking Bob confirms Alice's config never bleeds into Bob
            expect(resolveClaudeSharedAccountIsolation(bobWorkspace).mcpServers).toEqual({});
        });

        it('disables Claude.ai cloud plugin/skill/connector sync only for isolated shared accounts', () => {
            const ownerHookPath = generateHookSettingsFile(41001);
            hookFiles.push(ownerHookPath);
            const ownerSettings = JSON.parse(readFileSync(ownerHookPath, 'utf8'));
            expect(ownerSettings.syncClaudeAiPlugins).toBeUndefined();
            expect(ownerSettings.disableClaudeAiConnectors).toBeUndefined();

            const sharedHookPath = generateHookSettingsFile(41002, { isolatedSharedAccount: true });
            hookFiles.push(sharedHookPath);
            const sharedSettings = JSON.parse(readFileSync(sharedHookPath, 'utf8'));
            expect(sharedSettings.syncClaudeAiPlugins).toBe(false);
            expect(sharedSettings.syncClaudeAiSkills).toBe(false);
            expect(sharedSettings.disableClaudeAiConnectors).toBe(true);
        });
    });

    describe('Codex shared-account isolation', () => {
        it('disables host global MCPs, plugins, hooks, apps, and skills while keeping workspace configs and happy', () => {
            const root = makeTempDir('lmc-codex-iso-');
            const fakeHome = join(root, 'host-home');
            const fakeCodexHome = join(fakeHome, '.codex');
            const aliceWorkspace = join(root, 'shared-workspaces', 'acct_alice');
            const bobWorkspace = join(root, 'shared-workspaces', 'acct_bob');
            mkdirSync(fakeCodexHome, { recursive: true });
            mkdirSync(aliceWorkspace, { recursive: true });
            mkdirSync(bobWorkspace, { recursive: true });

            // Host has private global MCPs, plugins, and skills
            const hostSkillA = join(fakeCodexHome, 'skills', 'private-ops', 'SKILL.md');
            const hostSkillB = join(fakeHome, '.agents', 'skills', 'host-prd', 'SKILL.md');
            mkdirSync(join(fakeCodexHome, 'skills', 'private-ops'), { recursive: true });
            mkdirSync(join(fakeHome, '.agents', 'skills', 'host-prd'), { recursive: true });
            writeFileSync(hostSkillA, '# Private Ops\n');
            writeFileSync(hostSkillB, '# Host PRD\n');

            writeFileSync(
                join(fakeCodexHome, 'config.toml'),
                [
                    '[mcp_servers.nowledge-mem]',
                    'command = "nmem"',
                    'args = ["mcp"]',
                    '',
                    '[mcp_servers.shared-name]',
                    'url = "https://host-private.example/mcp"',
                    'http_headers = { Authorization = "Bearer HOST_SECRET" }',
                    '',
                    '[plugins."github@openai-curated"]',
                    'enabled = true',
                ].join('\n'),
            );

            // Workspace skill inside Alice's workspace must NOT be disabled
            mkdirSync(join(aliceWorkspace, '.agents', 'skills', 'alice-skill'), { recursive: true });
            const aliceSkillPath = join(aliceWorkspace, '.agents', 'skills', 'alice-skill', 'SKILL.md');
            writeFileSync(aliceSkillPath, '# Alice Skill\n');

            // Bob has default empty workspace
            const happyBridge = { command: 'node', args: ['happy-mcp.mjs'] };
            const bobIso = resolveCodexSharedAccountIsolation({
                workspaceDir: bobWorkspace,
                homeDir: fakeHome,
                codexHomeDir: fakeCodexHome,
                sessionMcpServers: { happy: happyBridge },
            });
            expect(bobIso.startupCliArgs).toEqual([
                '-c', 'features.apps=false',
                '-c', 'features.hooks=false',
                '-c', 'features.plugin_hooks=false',
                '-c', 'features.plugins=false',
            ]);
            expect(bobIso.threadConfig['features.plugins']).toBe(false);
            expect(bobIso.threadConfig.mcp_servers).toEqual({
                'nowledge-mem': { enabled: false },
                'shared-name': { enabled: false },
                happy: happyBridge,
            });
            const bobDisabledPaths = (bobIso.threadConfig.skills as { config: Array<{ path: string; enabled: boolean }> }).config;
            expect(bobDisabledPaths.some((entry) => entry.path.endsWith('private-ops/SKILL.md') || entry.path.endsWith('private-ops\\SKILL.md'))).toBe(true);
            expect(bobDisabledPaths.some((entry) => entry.path.endsWith('host-prd/SKILL.md') || entry.path.endsWith('host-prd\\SKILL.md'))).toBe(true);
            expect(bobDisabledPaths.every((entry) => entry.enabled === false)).toBe(true);

            // Alice defines her own MCP (including colliding name `shared-name`) and her own plugin
            writeFileSync(
                join(aliceWorkspace, '.mcp.json'),
                JSON.stringify({
                    mcpServers: {
                        'shared-name': {
                            url: 'https://alice.example/mcp',
                            headers: { 'X-Alice': '1' },
                        },
                    },
                }),
            );
            mkdirSync(join(aliceWorkspace, '.codex'), { recursive: true });
            writeFileSync(
                join(aliceWorkspace, '.codex', 'config.toml'),
                [
                    '[plugins."alice-plugin@local"]',
                    'enabled = true',
                ].join('\n'),
            );

            const aliceIso = resolveCodexSharedAccountIsolation({
                workspaceDir: aliceWorkspace,
                homeDir: fakeHome,
                codexHomeDir: fakeCodexHome,
                sessionMcpServers: { happy: happyBridge },
            });
            expect(aliceIso.startupCliArgs).not.toContain('features.plugins=false');
            expect(aliceIso.threadConfig.plugins).toEqual({
                'github@openai-curated': { enabled: false },
                'alice-plugin@local': { enabled: true },
            });
            expect((aliceIso.threadConfig.mcp_servers as Record<string, unknown>)['nowledge-mem']).toEqual({ enabled: false });
            expect((aliceIso.threadConfig.mcp_servers as Record<string, unknown>)['shared-name']).toEqual({
                enabled: true,
                http_headers: { 'X-Alice': '1' },
                env_http_headers: {},
                env: {},
                args: [],
                url: 'https://alice.example/mcp',
            });
            const aliceSkillOverrides = (aliceIso.threadConfig.skills as { config: Array<{ path: string; enabled: boolean }> }).config;
            expect(aliceSkillOverrides.some((entry) => entry.path === aliceSkillPath)).toBe(false);
        });
    });

    describe('Antigravity (agy) shared-account isolation', () => {
        it('isolates darwin profile config & MCPs without copying host credentials or host mcp_config.json', () => {
            const root = makeTempDir('lmc-agy-darwin-');
            const hostHome = join(root, 'host-home');
            const lmcHome = join(root, 'lmc-home');
            const aliceWorkspace = join(lmcHome, 'shared-workspaces', 'acct_alice');
            const bobWorkspace = join(lmcHome, 'shared-workspaces', 'acct_bob');
            mkdirSync(join(hostHome, '.gemini', 'antigravity-cli', 'bin'), { recursive: true });
            mkdirSync(join(hostHome, '.gemini', 'antigravity-cli', 'builtin'), { recursive: true });
            mkdirSync(join(hostHome, '.gemini', 'config'), { recursive: true });
            mkdirSync(join(hostHome, 'Library', 'Keychains'), { recursive: true });
            mkdirSync(aliceWorkspace, { recursive: true });
            mkdirSync(bobWorkspace, { recursive: true });

            // Host private MCP config & fake credential marker
            writeFileSync(
                join(hostHome, '.gemini', 'config', 'mcp_config.json'),
                JSON.stringify({
                    mcpServers: {
                        'dingtalk-ai-table': { serverUrl: 'https://mcp-gw.dingtalk.com/private-key' },
                        'nowledge-mem': { command: '/opt/homebrew/bin/nmem', args: ['mcp'] },
                    },
                }),
            );
            writeFileSync(join(hostHome, '.gemini', 'antigravity-cli', 'secret-token'), 'DO_NOT_COPY');

            const aliceIso = prepareAgySharedAccountIsolation({
                accountId: 'acct_alice',
                workspaceDir: aliceWorkspace,
                lmcHomeDir: lmcHome,
                hostHomeDir: hostHome,
                platform: 'darwin',
                nodeExecutable: '/usr/local/bin/node',
                bridgeScriptPath: '/opt/lmc/antigravity-mcp.cjs',
            });
            linkCleanups.push(() => aliceIso.cleanupLinksForTesting?.());

            const bobIso = prepareAgySharedAccountIsolation({
                accountId: 'acct_bob',
                workspaceDir: bobWorkspace,
                lmcHomeDir: lmcHome,
                hostHomeDir: hostHome,
                platform: 'darwin',
                nodeExecutable: '/usr/local/bin/node',
                bridgeScriptPath: '/opt/lmc/antigravity-mcp.cjs',
            });
            linkCleanups.push(() => bobIso.cleanupLinksForTesting?.());

            expect(aliceIso.env).toEqual({ HOME: aliceIso.profileHomeDir });
            expect(existsSync(join(aliceIso.agyCliHomeDir, 'secret-token'))).toBe(false);
            expect(lstatSync(join(aliceIso.agyCliHomeDir, 'bin')).isSymbolicLink()).toBe(true);
            expect(lstatSync(join(aliceIso.profileHomeDir, 'Library')).isSymbolicLink()).toBe(true);

            // Default isolated MCP config contains ONLY `lmc`, zero host MCPs
            const bobMcp = JSON.parse(readFileSync(bobIso.mcpConfigPath, 'utf8'));
            expect(Object.keys(bobMcp.mcpServers)).toEqual(['lmc']);

            // Alice adds `.mcp.json` to her workspace and syncs before her next turn
            writeFileSync(
                join(aliceWorkspace, '.mcp.json'),
                JSON.stringify({
                    mcpServers: {
                        'alice-docs': { url: 'https://docs.alice.example/mcp' },
                    },
                }),
            );
            aliceIso.syncWorkspaceMcpConfig();

            const aliceMcp = JSON.parse(readFileSync(aliceIso.mcpConfigPath, 'utf8'));
            expect(Object.keys(aliceMcp.mcpServers).sort()).toEqual(['alice-docs', 'lmc']);
            expect(Object.keys(JSON.parse(readFileSync(bobIso.mcpConfigPath, 'utf8')).mcpServers)).toEqual(['lmc']);
        });

        it('isolates win32 .gemini/config per account while linking antigravity-cli without copying oauth token', () => {
            const root = makeTempDir('lmc-agy-win32-');
            const hostHome = join(root, 'host-home');
            const lmcHome = join(root, 'lmc-home');
            const workspace = join(lmcHome, 'shared-workspaces', 'acct_win');
            mkdirSync(join(hostHome, '.gemini', 'antigravity-cli'), { recursive: true });
            mkdirSync(join(hostHome, '.gemini', 'config'), { recursive: true });
            mkdirSync(workspace, { recursive: true });

            writeFileSync(join(hostHome, '.gemini', 'antigravity-cli', 'antigravity-oauth-token'), 'WIN_TOKEN');
            writeFileSync(
                join(hostHome, '.gemini', 'config', 'mcp_config.json'),
                JSON.stringify({ mcpServers: { 'host-only': { command: 'host-mcp' } } }),
            );

            const winIso = prepareAgySharedAccountIsolation({
                accountId: 'acct_win',
                workspaceDir: workspace,
                lmcHomeDir: lmcHome,
                hostHomeDir: hostHome,
                platform: 'win32',
                nodeExecutable: 'C:\\Program Files\\nodejs\\node.exe',
                bridgeScriptPath: 'C:\\Users\\host\\.lmc\\antigravity-mcp.cjs',
            });
            linkCleanups.push(() => winIso.cleanupLinksForTesting?.());

            expect(winIso.env).toEqual({
                HOME: winIso.profileHomeDir,
                USERPROFILE: winIso.profileHomeDir,
            });
            expect(lstatSync(join(winIso.profileHomeDir, '.gemini', 'antigravity-cli')).isSymbolicLink()).toBe(true);
            const winMcp = JSON.parse(readFileSync(winIso.mcpConfigPath, 'utf8'));
            expect(Object.keys(winMcp.mcpServers)).toEqual(['lmc']);
        });
    });
});
