/**
 * Resolves the CLAUDE_CODE_ENTRYPOINT value LMC should use when launching
 * Claude Code via the agent SDK.
 *
 * Keep the official TypeScript SDK identity. A terminal's resume picker may
 * filter SDK sessions, but changing attribution to remote_mobile mislabels
 * the transport. LMC resumes its sessions by their explicit native ID.
 *
 * If the caller already exported CLAUDE_CODE_ENTRYPOINT to something specific,
 * we respect that — the user/operator wins.
 */

export const LMC_DEFAULT_ENTRYPOINT = 'sdk-ts' as const

export function resolveLmcEntrypoint(currentValue: string | undefined): string {
    if (currentValue && currentValue.length > 0) {
        return currentValue
    }
    return LMC_DEFAULT_ENTRYPOINT
}
