/**
 * Derived default, not a stored permission pick. Removing the worker binding
 * removes this default without overwriting a user's explicit choice.
 * Keep this small projection in sync with the other package's workerPermission
 * (the parity test exercises both); only the CLI runtime enforces it.
 */
export function resolveWorkerPermissionMode(metadata: {
    permissionMode?: string | null;
    permissionModeSource?: 'ambient' | 'explicit';
    orchestration?: { role: string; hub?: { autonomy?: boolean } };
}, engine: string): string | null | undefined {
    const full = engine === 'claude' ? 'bypassPermissions' : engine === 'codex' ? 'yolo' : undefined;
    if (!full) return metadata.permissionMode;
    const isWorker = metadata.orchestration?.role === 'worker';
    if (isWorker && metadata.orchestration?.hub?.autonomy === true
        && metadata.permissionModeSource === 'ambient') return full;
    // Unknown legacy provenance is retained, not guessed from a mode's name.
    const mode = metadata.permissionMode;
    return isWorker && (mode === 'yolo' || mode === 'bypassPermissions') ? full : mode;
}
