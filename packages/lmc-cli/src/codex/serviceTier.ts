export type CodexServiceTier = 'fast' | 'default';

export function validateCodexServiceTier(value: unknown): CodexServiceTier | undefined {
    if (value === undefined) return undefined;
    if (value !== 'fast' && value !== 'default') throw new Error('Invalid Codex service tier: use fast or default');
    return value;
}

export function codexServiceTierArgs(value: unknown): string[] {
    const tier = validateCodexServiceTier(value);
    return tier === undefined ? [] : ['--service-tier', tier];
}
