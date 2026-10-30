import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, chmodSync, writeFileSync, statSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readPoeSettings, savePoeSettings, poeClaudeEnvironment, fetchPoeJson } from './poe';
import { normalizePoeModels } from './modelDiscovery';

const dirs: string[] = [];
const home = () => { const dir = mkdtempSync(join(tmpdir(), 'lmc-poe-test-')); dirs.push(dir); return dir; };
const settings = { version: 1 as const, enabled: true, apiKey: 'fixture-only-key' };
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe('Poe local configuration and routing', () => {
    it('stores only in a private device directory and can disable without modifying official credentials', async () => {
        const dir = home(); const path = join(dir, 'poe', 'credentials.json');
        expect(readPoeSettings(path)).toBeNull();
        await savePoeSettings(settings, dir);
        expect(readPoeSettings(path)).toEqual(settings);
        if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o600);
        await savePoeSettings({ ...settings, enabled: false }, dir);
        expect(poeClaudeEnvironment(readPoeSettings(path))).toBeUndefined();
    });
    it('fails closed on corrupt, readable-by-others and symlink credentials with no secret in errors', async () => {
        const dir = home(); const path = join(dir, 'poe', 'credentials.json');
        await savePoeSettings(settings, dir);
        writeFileSync(path, '{"secret":"PRIVATE_VALUE"');
        expect(() => readPoeSettings(path)).toThrow('Poe configuration');
        try { readPoeSettings(path); } catch (e) { expect(String(e)).not.toContain('PRIVATE_VALUE'); }
        if (process.platform !== 'win32') {
            await savePoeSettings(settings, dir); chmodSync(path, 0o644);
            expect(() => readPoeSettings(path)).toThrow(); chmodSync(path, 0o600);
            symlinkSync(path, join(dir, 'link')); expect(() => readPoeSettings(join(dir, 'link'))).toThrow();
        }
    });
    it('routes only the Claude launch environment and suppresses old OAuth and competing providers', () => {
        expect(poeClaudeEnvironment(null)).toBeUndefined();
        const env = poeClaudeEnvironment(settings)!;
        expect(env.ANTHROPIC_BASE_URL).toBe('https://api.poe.com');
        expect(env.ANTHROPIC_API_KEY).toBe('');
        expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('');
        expect(Object.keys(env).some(k => k.startsWith('OPENAI') || k.startsWith('CODEX'))).toBe(false);
    });
    it('uses fixed HTTPS origin and refuses redirects, large bodies and credential-bearing error payloads', async () => {
        const request = (async (url, init) => {
            expect(url).toBe('https://api.poe.com/usage/current_balance');
            expect(init?.redirect).toBe('error');
            return new Response('{"current_point_balance":0}');
        }) as typeof fetch;
        expect(await fetchPoeJson('/usage/current_balance', settings.apiKey, request)).toEqual({ current_point_balance: 0 });
        await expect(fetchPoeJson('/usage/current_balance', settings.apiKey, (async () => new Response('SECRET', { status: 401 })) as typeof fetch)).rejects.toThrow('authentication');
        await expect(fetchPoeJson('/usage/current_balance', settings.apiKey, (async () => new Response('x'.repeat(16385))) as typeof fetch)).rejects.toThrow('unavailable');
    });
    it('excludes community bots and Claude bots without the native Messages endpoint', () => {
        const model = { id: 'claude-test', owned_by: 'Anthropic', supported_endpoints: ['/v1/messages'], parameters: [{ name: 'output_effort', schema: { enum: ['low', 'high', 'none'] }, default_value: 'high' }] };
        expect(normalizePoeModels({ data: [model, { ...model, id: 'community', owned_by: 'someone' }, { ...model, id: 'chat-only', supported_endpoints: ['/v1/chat/completions'] }] })).toEqual([
            { id: 'claude-test', name: 'claude-test', efforts: ['low', 'high'], defaultEffort: 'high' },
        ]);
    });
});
