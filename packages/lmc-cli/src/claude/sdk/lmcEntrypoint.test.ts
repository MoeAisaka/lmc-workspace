import { describe, expect, it } from 'vitest'

import { LMC_DEFAULT_ENTRYPOINT, resolveLmcEntrypoint } from './lmcEntrypoint'

describe('resolveLmcEntrypoint', () => {
    it('keeps the official TypeScript SDK identity when no override is set', () => {
        expect(resolveLmcEntrypoint(undefined)).toBe('sdk-ts')
        expect(resolveLmcEntrypoint('')).toBe('sdk-ts')
    })

    it('keeps a value the operator already exported', () => {
        expect(resolveLmcEntrypoint('cli')).toBe('cli')
        expect(resolveLmcEntrypoint('claude-vscode')).toBe('claude-vscode')
        expect(resolveLmcEntrypoint('sdk-ts')).toBe('sdk-ts')
    })

    it('uses a default Claude Code recognises as a valid entrypoint', () => {
        // Mirrors `zO9` allowlist in the Claude Code binary (v2.1.x). If the
        // value falls outside this set, several internal helpers drop it.
        const claudeKnownEntrypoints = new Set([
            'cli',
            'mcp',
            'sdk-cli',
            'sdk-ts',
            'sdk-py',
            'bench',
            'claude-vscode',
            'claude-code-github-action',
            'local-agent',
            'claude-desktop',
            'remote',
            'remote_baku',
            'remote_desktop',
            'remote_mobile',
            'claude_in_slack',
            'claude-desktop-3p',
            'ssh-remote',
        ])
        expect(claudeKnownEntrypoints.has(LMC_DEFAULT_ENTRYPOINT)).toBe(true)
    })
})
