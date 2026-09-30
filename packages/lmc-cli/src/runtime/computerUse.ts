/** Optional device-local computer tools. No provider credentials or private configuration are imported. */
import { accessSync, constants, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { z } from 'zod';
import { configuration } from '@/configuration';
import { logger } from '@/ui/logger';

const configSchema = z.object({
    version: z.literal(1),
    enabled: z.boolean(),
    engines: z.array(z.enum(['claude', 'codex'])).min(1),
    chrome: z.boolean().optional(),
    desktop: z.object({
        command: z.string().min(1).refine(isAbsolute),
        args: z.array(z.string()).max(64).default(['mcp']),
    }).strict().optional(),
}).strict();

type ComputerUseSetup = {
    chrome?: boolean;
    mcpServers: Record<string, { command: string; args: string[] }>;
};

export function readComputerUseSetup(engine: 'claude' | 'codex', options: { configPath?: string; platform?: NodeJS.Platform } = {}): ComputerUseSetup {
    const empty: ComputerUseSetup = { mcpServers: {} };
    const configPath = options.configPath ?? join(configuration.lmcHomeDir, 'computer-use.json');
    try {
        const parsed = configSchema.safeParse(JSON.parse(readFileSync(configPath, 'utf8')));
        if (!parsed.success) {
            logger.debug('[computer-use] Invalid device configuration; computer tools disabled');
            return empty;
        }
        const config = parsed.data;
        if (!config.enabled || !config.engines.includes(engine)) return empty;
        const setup: ComputerUseSetup = { mcpServers: {}, ...(engine === 'claude' ? { chrome: config.chrome } : {}) };
        if ((options.platform ?? process.platform) === 'darwin' && config.desktop) {
            try {
                accessSync(config.desktop.command, constants.X_OK);
                setup.mcpServers['lmc-computer'] = config.desktop;
            } catch {
                logger.debug('[computer-use] Desktop executable unavailable; computer tools disabled');
            }
        }
        return setup;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') logger.debug('[computer-use] Cannot read device configuration; computer tools disabled');
        return empty;
    }
}

/** Preserve explicit per-session choices; only this provider flag crosses into SDK options. */
export function claudeChromeChoice(args?: string[]): boolean | undefined {
    const flag = args?.filter(arg => arg === '--chrome' || arg === '--no-chrome').at(-1);
    return flag === undefined ? undefined : flag === '--chrome';
}

export function withClaudeChromeDefault(args: string[] | undefined, enabled: boolean | undefined): string[] | undefined {
    if (enabled === undefined || claudeChromeChoice(args) !== undefined) return args;
    return [...(args ?? []), enabled ? '--chrome' : '--no-chrome'];
}
