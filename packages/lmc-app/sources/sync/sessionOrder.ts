/** Stable default on every client, including sessions created in the same millisecond. */
export function compareSessionCreation(a: { id: string; createdAt: number }, b: { id: string; createdAt: number }): number {
    return a.createdAt - b.createdAt || compareStableIds(a.id, b.id);
}

export function compareStableIds(a: string, b: string): number {
    return a < b ? -1 : a > b ? 1 : 0;
}

export function orderSessions<T extends { id: string }>(items: readonly T[], saved?: readonly string[] | null): T[] {
    const rank = new Map((saved ?? []).map((id, index) => [id, index]));
    return [...items].sort((a, b) => (rank.get(a.id) ?? Infinity) - (rank.get(b.id) ?? Infinity));
}
export function moveSession(ids: readonly string[], id: string, target: string, after: boolean): string[] {
    if (id === target || !ids.includes(id) || !ids.includes(target)) return [...ids];
    const next = ids.filter(value => value !== id);
    next.splice(next.indexOf(target) + Number(after), 0, id);
    return next;
}
