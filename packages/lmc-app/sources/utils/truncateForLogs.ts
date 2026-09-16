const DEFAULT_MAX_STRING_LENGTH = 500;
const MAX_DEPTH = 10;
// Depth and per-string limits alone do not bound the result: one wide array or
// one object with many keys still serializes in full, and every such line is
// held in the in-memory log ring. These cap the breadth as well.
const MAX_ARRAY_ITEMS = 50;
const MAX_OBJECT_KEYS = 50;
// Last line of defence on the size of a single log entry, applied after
// serialization so that indentation and punctuation count towards it too.
const MAX_SERIALIZED_LENGTH = 8000;

function truncateString(value: string, maxLength: number): string {
    if (value.length <= maxLength) return value;
    const prefixLen = Math.ceil(maxLength * 0.4);
    const suffixLen = Math.floor(maxLength * 0.3);
    return value.slice(0, prefixLen) + ' [... TRUNCATED FOR LOGS] ' + value.slice(-suffixLen);
}

export function truncateForLogs(value: unknown, maxStringLength = DEFAULT_MAX_STRING_LENGTH, _depth = 0): unknown {
    if (value === null || value === undefined) return value;
    if (typeof value === 'string') return truncateString(value, maxStringLength);
    if (typeof value !== 'object') return value;
    if (_depth >= MAX_DEPTH) return '[...]';

    if (Array.isArray(value)) {
        const kept = value.slice(0, MAX_ARRAY_ITEMS)
            .map(item => truncateForLogs(item, maxStringLength, _depth + 1));
        if (value.length > MAX_ARRAY_ITEMS) kept.push(`[... ${value.length - MAX_ARRAY_ITEMS} more items]`);
        return kept;
    }

    const result: Record<string, unknown> = {};
    const entries = Object.entries(value as Record<string, unknown>);
    for (const [key, val] of entries.slice(0, MAX_OBJECT_KEYS)) {
        result[key] = truncateForLogs(val, maxStringLength, _depth + 1);
    }
    if (entries.length > MAX_OBJECT_KEYS) result['[...]'] = `${entries.length - MAX_OBJECT_KEYS} more keys`;
    return result;
}

export function serializeForLogs(value: unknown, maxStringLength = DEFAULT_MAX_STRING_LENGTH): string {
    if (typeof value === 'string') return truncateString(value, maxStringLength);

    const truncated = truncateForLogs(value, maxStringLength);
    let serialized: string;
    try {
        serialized = JSON.stringify(truncated, null, 2) ?? String(truncated);
    } catch {
        serialized = String(truncated);
    }
    return truncateString(serialized, MAX_SERIALIZED_LENGTH);
}
