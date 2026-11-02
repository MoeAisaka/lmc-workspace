import {
    existsSync,
    lstatSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    realpathSync,
    symlinkSync,
    unlinkSync,
    writeFileSync,
} from 'node:fs';
import os from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { configuration } from '@/configuration';
import { projectPath } from '@/projectPath';
import { logger } from '@/ui/logger';
import { resolveNodeExecutable } from '@/utils/nodeExecutable';

const SAFE_ACCOUNT_ID = /^[\w-]{1,191}$/;
const SKILL_FILENAME = 'SKILL.md';
const MAX_SKILL_SCAN_DEPTH = 6;

const AGY_ONBOARDING_PBTXT = [
    'post_onboarding: {',
    '  completed_steps: POST_ONBOARDING_STEP_TYPE_MANAGER_WELCOME',
    '  completed_steps: POST_ONBOARDING_STEP_TYPE_USAGE_MODE',
    '  completed_steps: POST_ONBOARDING_STEP_TYPE_AGENT_CONFIGURATION',
    '  completed_steps: POST_ONBOARDING_STEP_TYPE_ADD_WORKSPACE',
    '}',
    '',
].join('\n');

function isPlainRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

export function assertSafeSharedAccountId(accountId: string): string {
    if (!SAFE_ACCOUNT_ID.test(accountId)) {
        throw new Error('Invalid shared account identifier');
    }
    return accountId;
}

function tryCanonicalPath(targetPath: string): string {
    const resolved = resolve(targetPath);
    let current = resolved;
    const suffix: string[] = [];
    while (true) {
        try {
            const realBase = realpathSync(current);
            return suffix.length > 0 ? join(realBase, ...suffix.reverse()) : realBase;
        } catch {
            const parent = dirname(current);
            if (parent === current) {
                return resolved;
            }
            suffix.push(basename(current));
            current = parent;
        }
    }
}

function isPathInsideDirectory(candidatePath: string, directoryPath: string): boolean {
    const rel = relative(tryCanonicalPath(directoryPath), tryCanonicalPath(candidatePath));
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * Read MCP servers declared in `<dir>/.mcp.json` (accepts either `{ mcpServers: { ... } }`
 * or top-level server map when `mcpServers` is omitted in plugin `.mcp.json`).
 */
export function readMcpJsonServers(
    mcpJsonPath: string,
    opts: { allowTopLevelMap?: boolean } = {},
): Record<string, Record<string, unknown>> {
    if (!existsSync(mcpJsonPath)) return {};
    try {
        const parsed = JSON.parse(readFileSync(mcpJsonPath, 'utf8'));
        if (!isPlainRecord(parsed)) return {};
        const rawMap = isPlainRecord(parsed.mcpServers)
            ? parsed.mcpServers
            : (opts.allowTopLevelMap ? parsed : null);
        if (!rawMap) return {};
        const servers: Record<string, Record<string, unknown>> = {};
        for (const [name, entry] of Object.entries(rawMap)) {
            if (!name || name === 'mcpServers' || !isPlainRecord(entry)) continue;
            if (typeof entry.command !== 'string' && typeof entry.url !== 'string' && typeof entry.serverUrl !== 'string') {
                continue;
            }
            servers[name] = { ...entry };
        }
        return servers;
    } catch (error) {
        logger.debug(`[sharedAccountIsolation] Ignoring unreadable MCP config at ${mcpJsonPath}:`, error);
        return {};
    }
}

function normalizeMcpServersForCodex(
    servers: Record<string, Record<string, unknown>>,
): Record<string, Record<string, unknown>> {
    const out: Record<string, Record<string, unknown>> = {};
    for (const [name, entry] of Object.entries(servers)) {
        if (typeof entry.command === 'string' && entry.command.trim().length > 0) {
            const mapped: Record<string, unknown> = { command: entry.command };
            if (Array.isArray(entry.args)) {
                mapped.args = entry.args.filter((item): item is string => typeof item === 'string');
            }
            if (isPlainRecord(entry.env)) {
                const envMap: Record<string, string> = {};
                for (const [k, v] of Object.entries(entry.env)) {
                    if (typeof v === 'string') envMap[k] = v;
                }
                mapped.env = envMap;
            }
            if (typeof entry.cwd === 'string' && entry.cwd.trim().length > 0) {
                mapped.cwd = entry.cwd;
            }
            out[name] = mapped;
        } else {
            const url = typeof entry.url === 'string'
                ? entry.url
                : (typeof entry.serverUrl === 'string' ? entry.serverUrl : undefined);
            if (url && url.trim().length > 0) {
                const mapped: Record<string, unknown> = { url };
                if (isPlainRecord(entry.headers)) {
                    const headers: Record<string, string> = {};
                    for (const [k, v] of Object.entries(entry.headers)) {
                        if (typeof v === 'string') headers[k] = v;
                    }
                    mapped.http_headers = headers;
                } else if (isPlainRecord(entry.http_headers)) {
                    mapped.http_headers = entry.http_headers;
                }
                out[name] = mapped;
            }
        }
    }
    return out;
}

function collectSkillNamesUnderRoot(
    rootDir: string,
    names: Set<string>,
    prefix?: string,
): void {
    const walk = (dir: string, depth: number) => {
        if (!existsSync(dir)) return;
        let entries;
        try {
            entries = readdirSync(dir, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries) {
            if (entry.name.startsWith('.')) continue;
            const fullPath = join(dir, entry.name);
            if ((entry.isFile() || entry.isSymbolicLink()) && entry.name === SKILL_FILENAME) {
                const skillDirName = basename(dirname(fullPath));
                if (skillDirName) {
                    names.add(prefix ? `${prefix}:${skillDirName}` : skillDirName);
                }
                continue;
            }
            if (entry.isDirectory() && depth < MAX_SKILL_SCAN_DEPTH) {
                walk(fullPath, depth + 1);
            }
        }
    };
    walk(rootDir, 0);
}

function discoverLocalClaudePluginDirs(workspaceDir: string): string[] {
    const pluginsRoot = join(workspaceDir, '.claude', 'plugins');
    if (!existsSync(pluginsRoot)) return [];
    let entries;
    try {
        entries = readdirSync(pluginsRoot, { withFileTypes: true });
    } catch {
        return [];
    }
    const dirs: string[] = [];
    for (const entry of entries) {
        if (entry.name.startsWith('.') || !entry.isDirectory()) continue;
        const candidate = join(pluginsRoot, entry.name);
        const hasManifestOrContent =
            existsSync(join(candidate, '.claude-plugin', 'plugin.json')) ||
            existsSync(join(candidate, 'plugin.json')) ||
            existsSync(join(candidate, '.mcp.json')) ||
            existsSync(join(candidate, 'skills')) ||
            existsSync(join(candidate, 'commands')) ||
            existsSync(join(candidate, 'agents'));
        if (hasManifestOrContent) {
            dirs.push(candidate);
        }
    }
    return dirs.sort((a, b) => a.localeCompare(b));
}

export interface ClaudeSharedAccountIsolation {
    settingSources: ('project' | 'local')[];
    strictMcpConfig: true;
    mcpServers: Record<string, Record<string, unknown>>;
    plugins: Array<{ type: 'local'; path: string }>;
    skills: string[];
}

/**
 * Build Claude SDK isolation options for a non-owner shared account session.
 * Blocks host `~/.claude` settings, `~/.claude.json` MCPs, `~/.claude/skills`,
 * and host plugins while preserving the account's own workspace configuration.
 */
export function resolveClaudeSharedAccountIsolation(workspaceDir: string): ClaudeSharedAccountIsolation {
    const resolvedWorkspace = resolve(workspaceDir);
    const pluginDirs = discoverLocalClaudePluginDirs(resolvedWorkspace);
    const mcpServers: Record<string, Record<string, unknown>> = {};

    for (const pluginDir of pluginDirs) {
        Object.assign(
            mcpServers,
            readMcpJsonServers(join(pluginDir, '.mcp.json'), { allowTopLevelMap: true }),
        );
    }
    Object.assign(mcpServers, readMcpJsonServers(join(resolvedWorkspace, '.mcp.json')));

    const skillNames = new Set<string>();
    collectSkillNamesUnderRoot(join(resolvedWorkspace, '.claude', 'skills'), skillNames);
    collectSkillNamesUnderRoot(join(resolvedWorkspace, '.agents', 'skills'), skillNames);
    for (const pluginDir of pluginDirs) {
        const pluginName = basename(pluginDir);
        collectSkillNamesUnderRoot(join(pluginDir, 'skills'), skillNames);
        collectSkillNamesUnderRoot(join(pluginDir, 'skills'), skillNames, pluginName);
    }

    return {
        settingSources: ['project', 'local'],
        strictMcpConfig: true,
        mcpServers,
        plugins: pluginDirs.map((path) => ({ type: 'local' as const, path })),
        skills: [...skillNames].sort((a, b) => a.localeCompare(b)),
    };
}

function readParsedTomlFile(filePath: string): Record<string, unknown> {
    if (!existsSync(filePath)) return {};
    try {
        const parsed = parseToml(readFileSync(filePath, 'utf8'));
        return isPlainRecord(parsed) ? parsed : {};
    } catch (error) {
        logger.debug(`[sharedAccountIsolation] Ignoring unreadable TOML config at ${filePath}:`, error);
        return {};
    }
}

function expandLeadingTilde(rawPath: string, homeDir: string): string {
    if (rawPath === '~') return homeDir;
    if (rawPath.startsWith('~/') || rawPath.startsWith(`~${sep}`)) {
        return join(homeDir, rawPath.slice(2));
    }
    return rawPath;
}

function collectSkillFilesUnderRoot(rootDir: string, outPaths: Set<string>): void {
    const walk = (dir: string, depth: number) => {
        if (!existsSync(dir)) return;
        let entries;
        try {
            entries = readdirSync(dir, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries) {
            if (entry.name.startsWith('.')) continue;
            const fullPath = join(dir, entry.name);
            let isDir = entry.isDirectory();
            let isFile = entry.isFile();
            if (entry.isSymbolicLink()) {
                try {
                    const real = realpathSync(fullPath);
                    const st = lstatSync(real);
                    isDir = st.isDirectory();
                    isFile = st.isFile();
                } catch {
                    continue;
                }
            }
            if (isFile && entry.name === SKILL_FILENAME) {
                outPaths.add(fullPath);
                try {
                    outPaths.add(realpathSync(fullPath));
                } catch {}
                continue;
            }
            if (isDir && depth < MAX_SKILL_SCAN_DEPTH) {
                walk(fullPath, depth + 1);
            }
        }
    };
    walk(rootDir, 0);
}

export interface ResolveCodexSharedAccountIsolationOptions {
    workspaceDir: string;
    sessionMcpServers?: Record<string, unknown>;
    homeDir?: string;
    codexHomeDir?: string;
}

export interface CodexSharedAccountIsolation {
    startupCliArgs: string[];
    threadConfig: Record<string, unknown>;
}

/**
 * Build Codex app-server CLI flags and per-thread `config` overrides for a
 * non-owner shared account session so host global plugins, MCP servers, hooks,
 * apps, and skills are disabled while keeping host auth and loading the
 * account's own `.mcp.json` / `.codex/config.toml` / `.agents/skills`.
 */
export function resolveCodexSharedAccountIsolation(
    opts: ResolveCodexSharedAccountIsolationOptions,
): CodexSharedAccountIsolation {
    const homeDir = resolve(opts.homeDir ?? os.homedir());
    const codexHomeDir = resolve(
        expandLeadingTilde(opts.codexHomeDir ?? process.env.CODEX_HOME ?? join(homeDir, '.codex'), homeDir),
    );
    const workspaceDir = resolve(opts.workspaceDir);

    const hostConfig = readParsedTomlFile(join(codexHomeDir, 'config.toml'));
    const accountConfig = readParsedTomlFile(join(workspaceDir, '.codex', 'config.toml'));

    const accountPluginsTable = isPlainRecord(accountConfig.plugins) ? accountConfig.plugins : {};
    const accountHasEnabledPlugins = Object.values(accountPluginsTable).some(
        (entry) => isPlainRecord(entry) && entry.enabled === true,
    );

    const startupCliArgs: string[] = [
        '-c', 'features.apps=false',
        '-c', 'features.hooks=false',
        '-c', 'features.plugin_hooks=false',
    ];
    if (!accountHasEnabledPlugins) {
        startupCliArgs.push('-c', 'features.plugins=false');
    }

    const threadConfig: Record<string, unknown> = {
        'features.apps': false,
        'features.hooks': false,
        'features.plugin_hooks': false,
    };

    if (!accountHasEnabledPlugins) {
        threadConfig['features.plugins'] = false;
    } else {
        const pluginsOverride: Record<string, unknown> = {};
        const hostPlugins = isPlainRecord(hostConfig.plugins) ? hostConfig.plugins : {};
        for (const pluginId of Object.keys(hostPlugins)) {
            pluginsOverride[pluginId] = { enabled: false };
        }
        for (const [pluginId, pluginCfg] of Object.entries(accountPluginsTable)) {
            if (isPlainRecord(pluginCfg)) {
                pluginsOverride[pluginId] = { ...pluginCfg };
            }
        }
        if (Object.keys(pluginsOverride).length > 0) {
            threadConfig.plugins = pluginsOverride;
        }
    }

    // Disable host global skills while keeping skills inside the account's workspace.
    const disabledHostSkillPaths = new Set<string>();
    const hostSkillsTable = isPlainRecord(hostConfig.skills) ? hostConfig.skills : {};
    const hostSkillConfigList = Array.isArray(hostSkillsTable.config) ? hostSkillsTable.config : [];
    for (const item of hostSkillConfigList) {
        if (isPlainRecord(item) && typeof item.path === 'string' && item.path.trim().length > 0) {
            const expanded = resolve(expandLeadingTilde(item.path.trim(), homeDir));
            if (!isPathInsideDirectory(expanded, workspaceDir)) {
                disabledHostSkillPaths.add(expanded);
                try {
                    disabledHostSkillPaths.add(realpathSync(expanded));
                } catch {}
            }
        }
    }
    for (const hostSkillRoot of [join(codexHomeDir, 'skills'), join(homeDir, '.agents', 'skills')]) {
        if (!isPathInsideDirectory(hostSkillRoot, workspaceDir)) {
            collectSkillFilesUnderRoot(hostSkillRoot, disabledHostSkillPaths);
        }
    }

    const skillConfigEntries: Array<{ path: string; enabled: boolean }> = [...disabledHostSkillPaths]
        .filter((skillPath) => !isPathInsideDirectory(skillPath, workspaceDir))
        .sort((a, b) => a.localeCompare(b))
        .map((path) => ({ path, enabled: false }));

    const accountSkillsTable = isPlainRecord(accountConfig.skills) ? accountConfig.skills : {};
    const accountSkillConfigList = Array.isArray(accountSkillsTable.config) ? accountSkillsTable.config : [];
    for (const item of accountSkillConfigList) {
        if (isPlainRecord(item) && typeof item.path === 'string' && typeof item.enabled === 'boolean') {
            skillConfigEntries.push({ path: item.path, enabled: item.enabled });
        }
    }
    if (skillConfigEntries.length > 0) {
        threadConfig.skills = { config: skillConfigEntries };
    }

    // Build isolated MCP server map: disable every host MCP server, layer the
    // account's own `.mcp.json` + `.codex/config.toml` servers, then enforce `happy`.
    const accountMcpFromJson = normalizeMcpServersForCodex(
        readMcpJsonServers(join(workspaceDir, '.mcp.json')),
    );
    const accountMcpFromToml: Record<string, Record<string, unknown>> = {};
    if (isPlainRecord(accountConfig.mcp_servers)) {
        for (const [name, entry] of Object.entries(accountConfig.mcp_servers)) {
            if (isPlainRecord(entry)) {
                accountMcpFromToml[name] = { ...entry };
            }
        }
    }
    const combinedAccountMcps: Record<string, Record<string, unknown>> = {
        ...accountMcpFromJson,
        ...accountMcpFromToml,
    };

    const mcpServersOverride: Record<string, unknown> = {};
    const hostMcpServers = isPlainRecord(hostConfig.mcp_servers) ? hostConfig.mcp_servers : {};
    for (const hostMcpName of Object.keys(hostMcpServers)) {
        mcpServersOverride[hostMcpName] = { enabled: false };
    }
    for (const [name, accountEntry] of Object.entries(combinedAccountMcps)) {
        if (Object.prototype.hasOwnProperty.call(hostMcpServers, name)) {
            // Clear host-defined fields on name collision so host headers/env never bleed through.
            mcpServersOverride[name] = {
                enabled: true,
                http_headers: {},
                env_http_headers: {},
                env: {},
                args: [],
                ...accountEntry,
            };
        } else {
            mcpServersOverride[name] = { ...accountEntry };
        }
    }
    for (const [name, sessionServer] of Object.entries(opts.sessionMcpServers ?? {})) {
        mcpServersOverride[name] = sessionServer;
    }

    threadConfig.mcp_servers = mcpServersOverride;
    return { startupCliArgs, threadConfig };
}

function ensureDirectoryLink(targetPath: string, linkPath: string, platform: NodeJS.Platform): void {
    if (!existsSync(targetPath)) return;
    try {
        const st = lstatSync(linkPath);
        if (st.isSymbolicLink()) return;
        return;
    } catch {
        // Does not exist yet; create link below.
    }
    try {
        symlinkSync(targetPath, linkPath, platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
        logger.debug(`[sharedAccountIsolation] Could not link ${linkPath} -> ${targetPath}:`, error);
    }
}

function resolveAgyBridgeScriptPath(lmcHomeDir: string): string {
    const installedBridge = join(lmcHomeDir, 'antigravity-mcp.cjs');
    if (existsSync(installedBridge)) return installedBridge;
    return resolve(projectPath(), 'scripts', 'antigravity-mcp.cjs');
}

function normalizeMcpServersForAgy(
    servers: Record<string, Record<string, unknown>>,
): Record<string, Record<string, unknown>> {
    const out: Record<string, Record<string, unknown>> = {};
    for (const [name, entry] of Object.entries(servers)) {
        if (typeof entry.command === 'string' && entry.command.trim().length > 0) {
            const mapped: Record<string, unknown> = { command: entry.command };
            if (Array.isArray(entry.args)) {
                mapped.args = entry.args.filter((item): item is string => typeof item === 'string');
            }
            if (isPlainRecord(entry.env)) {
                mapped.env = entry.env;
            }
            out[name] = mapped;
        } else {
            const url = typeof entry.url === 'string'
                ? entry.url
                : (typeof entry.serverUrl === 'string' ? entry.serverUrl : undefined);
            if (url && url.trim().length > 0) {
                const mapped: Record<string, unknown> = { url };
                if (isPlainRecord(entry.headers)) {
                    mapped.headers = entry.headers;
                }
                out[name] = mapped;
            }
        }
    }
    return out;
}

export interface PrepareAgySharedAccountIsolationOptions {
    accountId: string;
    workspaceDir: string;
    lmcHomeDir?: string;
    hostHomeDir?: string;
    platform?: NodeJS.Platform;
    nodeExecutable?: string;
    bridgeScriptPath?: string;
}

export interface AgySharedAccountIsolation {
    profileHomeDir: string;
    agyCliHomeDir: string;
    mcpConfigPath: string;
    env: Record<string, string>;
    syncWorkspaceMcpConfig: () => void;
    cleanupLinksForTesting?: () => void;
}

/**
 * Prepare an isolated Antigravity (`agy`) user home for a non-owner shared account.
 *
 * Isolates `~/.gemini/config/` (`mcp_config.json`, `plugins/`, `skills/`, `AGENTS.md`)
 * and `~/.gemini/AGENTS.md` per account without copying any host credentials:
 * - On macOS/Linux: links only `bin` and `builtin` from host `~/.gemini/antigravity-cli`
 *   (plus `~/Library` on macOS so Keychain resolves natively), keeping conversations
 *   and skills isolated per account as well.
 * - On Windows: junctions `.gemini/antigravity-cli` (no admin required, no token copy)
 *   while `.gemini/config` and `.gemini/AGENTS.md` remain isolated per account.
 */
export function prepareAgySharedAccountIsolation(
    opts: PrepareAgySharedAccountIsolationOptions,
): AgySharedAccountIsolation {
    const safeAccountId = assertSafeSharedAccountId(opts.accountId);
    const lmcHomeDir = resolve(opts.lmcHomeDir ?? configuration.lmcHomeDir);
    const hostHomeDir = resolve(opts.hostHomeDir ?? os.homedir());
    const workspaceDir = resolve(opts.workspaceDir);
    const platform = opts.platform ?? process.platform;
    const nodeBin = opts.nodeExecutable ?? resolveNodeExecutable();
    const bridgeScriptPath = opts.bridgeScriptPath ?? resolveAgyBridgeScriptPath(lmcHomeDir);

    const profileRoot = join(lmcHomeDir, 'shared-profiles', safeAccountId);
    const profileHomeDir = join(profileRoot, 'agy-home');
    if (!isPathInsideDirectory(profileHomeDir, join(lmcHomeDir, 'shared-profiles'))) {
        throw new Error('Invalid shared profile directory');
    }

    const geminiDir = join(profileHomeDir, '.gemini');
    const geminiConfigDir = join(geminiDir, 'config');
    mkdirSync(geminiConfigDir, { recursive: true, mode: 0o700 });

    const hostAgyCliDir = join(hostHomeDir, '.gemini', 'antigravity-cli');
    let agyCliHomeDir: string;

    if (platform === 'win32') {
        ensureDirectoryLink(hostAgyCliDir, join(geminiDir, 'antigravity-cli'), platform);
        agyCliHomeDir = hostAgyCliDir;
    } else {
        agyCliHomeDir = join(geminiDir, 'antigravity-cli');
        mkdirSync(agyCliHomeDir, { recursive: true, mode: 0o700 });
        ensureDirectoryLink(join(hostAgyCliDir, 'bin'), join(agyCliHomeDir, 'bin'), platform);
        ensureDirectoryLink(join(hostAgyCliDir, 'builtin'), join(agyCliHomeDir, 'builtin'), platform);
        if (platform === 'darwin') {
            ensureDirectoryLink(join(hostHomeDir, 'Library'), join(profileHomeDir, 'Library'), platform);
        }

        const pbtxtPath = join(agyCliHomeDir, 'jetski_state.pbtxt');
        if (!existsSync(pbtxtPath)) {
            writeFileSync(pbtxtPath, AGY_ONBOARDING_PBTXT, { mode: 0o600 });
        }

        const settingsPath = join(agyCliHomeDir, 'settings.json');
        let settingsObj: Record<string, unknown> = {};
        if (existsSync(settingsPath)) {
            try {
                const parsed = JSON.parse(readFileSync(settingsPath, 'utf8'));
                if (isPlainRecord(parsed)) settingsObj = parsed;
            } catch {}
        }
        const trusted = Array.isArray(settingsObj.trustedWorkspaces)
            ? settingsObj.trustedWorkspaces.filter((item): item is string => typeof item === 'string')
            : [];
        if (!trusted.includes(workspaceDir)) {
            settingsObj.trustedWorkspaces = [...trusted, workspaceDir];
            writeFileSync(settingsPath, JSON.stringify(settingsObj, null, 2), { mode: 0o600 });
        }
    }

    const mcpConfigPath = join(geminiConfigDir, 'mcp_config.json');
    const syncWorkspaceMcpConfig = () => {
        const existingProfileServers = readMcpJsonServers(mcpConfigPath);
        const workspaceServers = normalizeMcpServersForAgy(
            readMcpJsonServers(join(workspaceDir, '.mcp.json')),
        );
        const merged = {
            mcpServers: {
                ...existingProfileServers,
                ...workspaceServers,
                lmc: {
                    command: nodeBin,
                    args: [bridgeScriptPath],
                },
            },
        };
        writeFileSync(mcpConfigPath, JSON.stringify(merged, null, 2), { mode: 0o600 });
    };
    syncWorkspaceMcpConfig();

    const env: Record<string, string> = {
        HOME: profileHomeDir,
    };
    if (platform === 'win32') {
        env.USERPROFILE = profileHomeDir;
    }

    return {
        profileHomeDir,
        agyCliHomeDir,
        mcpConfigPath,
        env,
        syncWorkspaceMcpConfig,
        cleanupLinksForTesting: () => {
            for (const linkCandidate of [
                join(geminiDir, 'antigravity-cli'),
                join(geminiDir, 'antigravity-cli', 'bin'),
                join(geminiDir, 'antigravity-cli', 'builtin'),
                join(profileHomeDir, 'Library'),
            ]) {
                try {
                    if (lstatSync(linkCandidate).isSymbolicLink()) unlinkSync(linkCandidate);
                } catch {}
            }
        },
    };
}
