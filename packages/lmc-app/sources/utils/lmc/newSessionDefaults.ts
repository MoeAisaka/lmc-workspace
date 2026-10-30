/** Device-local workspace preset. Never reuse another device's draft path. */
export function creationPath(homeDir: string | null | undefined): string {
    return homeDir?.trim() || '~';
}

/** Explicit owner preference for new sessions; map to each CLI's native mode. */
export function creationPermission<T extends { key: string }>(modes: T[]): T | undefined {
    return modes.find(mode => mode.key === 'yolo')
        ?? modes.find(mode => mode.key === 'bypassPermissions');
}
