import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claudeChromeChoice, readComputerUseSetup, withClaudeChromeDefault } from './computerUse';

const folders: string[] = [];
afterEach(() => { for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true }); });
function fixture(override: Record<string, unknown> = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'lmc-computer-use-')); folders.push(dir);
    const command = join(dir, 'fixture-backend'); writeFileSync(command, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const configPath = join(dir, 'computer-use.json');
    writeFileSync(configPath, JSON.stringify({ version: 1, enabled: true, engines: ['claude', 'codex'], chrome: true, desktop: { command, args: ['mcp'] }, ...override }));
    return { configPath, command, platform: 'darwin' as const };
}
describe('device computer-use setup', () => {
    it('uses the same desktop backend for both engines without sending Claude browser flags to Codex', () => {
        const input = fixture();
        const claude = readComputerUseSetup('claude', input), codex = readComputerUseSetup('codex', input);
        expect(claude.mcpServers).toEqual({ 'lmc-computer': { command: input.command, args: ['mcp'] } });
        expect(codex.mcpServers).toEqual(claude.mcpServers);
        expect(claude.chrome).toBe(true); expect(codex).not.toHaveProperty('chrome');
    });
    it('respects per-engine enablement and leaves an existing native Codex integration alone', () => {
        expect(readComputerUseSetup('codex', fixture({ engines: ['claude'] }))).toEqual({ mcpServers: {} });
        expect(readComputerUseSetup('claude', fixture({ enabled: false }))).toEqual({ mcpServers: {} });
    });
    it('does not launch a missing executable or a macOS backend on Linux', () => {
        const input = fixture();
        expect(readComputerUseSetup('claude', { ...input, platform: 'linux' }).mcpServers).toEqual({});
        chmodSync(input.command, 0o644);
        expect(readComputerUseSetup('claude', input).mcpServers).toEqual({});
    });
    it('fails closed on absent, malformed and unsupported configuration', () => {
        const input = fixture({ version: 2 });
        expect(readComputerUseSetup('claude', input)).toEqual({ mcpServers: {} });
        writeFileSync(input.configPath, '{broken');
        expect(readComputerUseSetup('claude', input)).toEqual({ mcpServers: {} });
        expect(readComputerUseSetup('claude', { ...input, configPath: input.configPath + '.missing' })).toEqual({ mcpServers: {} });
    });
    it('preserves explicit Chrome opt-out and does not forward arbitrary arguments', () => {
        expect(withClaudeChromeDefault(['--no-chrome'], true)).toEqual(['--no-chrome']);
        expect(claudeChromeChoice(['--chrome', '--no-chrome'])).toBe(false);
        expect(claudeChromeChoice(['--model', 'fixture'])).toBeUndefined();
        expect(withClaudeChromeDefault(undefined, true)).toEqual(['--chrome']);
    });
});
