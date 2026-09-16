export type CodexContextLimits = {
    contextWindow?: number;
    autoCompactTokenLimit?: number;
};

/** Validate before spawning or changing any launch arguments. Unset inherits Codex config. */
export function validateCodexContextLimits(value: unknown): CodexContextLimits {
    if (value === undefined) return {};
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid Codex context settings');
    const source = value as Record<string, unknown>;
    const result: CodexContextLimits = {};
    for (const key of ['contextWindow', 'autoCompactTokenLimit'] as const) {
        const n = source[key];
        if (n === undefined) continue;
        if (typeof n !== 'number' || !Number.isSafeInteger(n) || n <= 0) {
            throw new Error(`${key} must be a positive whole number of tokens`);
        }
        result[key] = n;
    }
    if (result.contextWindow !== undefined && result.autoCompactTokenLimit !== undefined
        && result.autoCompactTokenLimit >= result.contextWindow) {
        throw new Error('Auto-compaction threshold must be smaller than the context window');
    }
    return result;
}

export function codexContextLimitArgs(value: unknown): string[] {
    const limits = validateCodexContextLimits(value);
    return [
        ...(limits.contextWindow === undefined ? [] : ['--context-window', String(limits.contextWindow)]),
        ...(limits.autoCompactTokenLimit === undefined ? [] : ['--auto-compact-token-limit', String(limits.autoCompactTokenLimit)]),
    ];
}
