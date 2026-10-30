/** Device-local Poe credentials, used only by Claude and the account balance reader. */
import { existsSync, readFileSync, lstatSync } from 'node:fs';
import { mkdir, rename, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { userInfo } from 'node:os';
import { z } from 'zod';
import { configuration } from '@/configuration';

const schema = z.object({ version: z.literal(1), enabled: z.boolean(), apiKey: z.string().min(8).max(4096).regex(/^[^\s\x00-\x1f\x7f]+$/) }).strict();
export type PoeSettings = z.infer<typeof schema>;
export const poeSettingsPath = () => join(configuration.lmcHomeDir, 'poe', 'credentials.json');
export const hasPoeSettings = () => existsSync(poeSettingsPath());

export function readPoeSettings(path = poeSettingsPath()): PoeSettings | null {
    try {
        const stat = lstatSync(path);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8192 || (process.platform !== 'win32' && ((stat.mode & 0o077) || stat.uid !== process.getuid?.()))) throw new Error();
        const result = schema.safeParse(JSON.parse(readFileSync(path, 'utf8')));
        if (!result.success) throw new Error();
        return result.data;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        // Never include parse input, filesystem errors or credentials in an error.
        throw new Error('Poe configuration is invalid or not private. Run lmc poe configure.');
    }
}

export async function savePoeSettings(settings: PoeSettings, home = configuration.lmcHomeDir): Promise<void> {
    if (!schema.safeParse(settings).success) throw new Error('Invalid Poe configuration');
    const dir = join(home, 'poe');
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const dirStat = lstatSync(dir);
    if (!dirStat.isDirectory() || dirStat.isSymbolicLink() || (process.platform !== 'win32' && (dirStat.mode & 0o077))) throw new Error('Poe directory is not private');
    if (process.platform === 'win32') {
        // Private directory BEFORE the key is written; mode 0600 alone is not an ACL on Windows.
        execFileSync('icacls.exe', [dir, '/inheritance:r', '/grant:r', `${userInfo().username}:(OI)(CI)F`], { stdio: 'ignore', windowsHide: true });
    }
    const pending = join(dir, `${randomUUID()}.tmp`);
    try {
        await writeFile(pending, JSON.stringify(settings), { mode: 0o600, flag: 'wx' });
        await rename(pending, join(dir, 'credentials.json'));
    } finally { await unlink(pending).catch(() => {}); }
}

/** Explicit routing wins over inherited OAuth; these values never enter session metadata. */
export function poeClaudeEnvironment(settings: PoeSettings | null): Record<string, string> | undefined {
    if (!settings?.enabled) return undefined;
    return {
        ANTHROPIC_BASE_URL: 'https://api.poe.com',
        ANTHROPIC_AUTH_TOKEN: settings.apiKey,
        ANTHROPIC_API_KEY: '',
        CLAUDE_CODE_OAUTH_TOKEN: '',
        CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR: '',
        CLAUDE_CODE_USE_BEDROCK: '0', CLAUDE_CODE_USE_VERTEX: '0', CLAUDE_CODE_USE_FOUNDRY: '0',
    };
}

/** Fixed origin, bounded body, no redirects and no raw provider errors. */
export async function fetchPoeJson(path: '/usage/current_balance' | '/v1/models', apiKey: string, request: typeof fetch = fetch): Promise<unknown> {
    const response = await request(`https://api.poe.com${path}`, {
        headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
        redirect: 'error', signal: AbortSignal.timeout(8000),
    });
    if (!response.ok || !response.body) {
        await response.body?.cancel().catch(() => {});
        throw new Error(response.status === 401 || response.status === 403 ? 'authentication' : 'unavailable');
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > (path === '/v1/models' ? 4 * 1024 * 1024 : 16 * 1024)) throw new Error('unavailable');
            chunks.push(value);
        }
        return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch { throw new Error('unavailable'); }
    finally { await reader.cancel().catch(() => {}); }
}
