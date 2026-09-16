/**
 * The Agent only delivers files contained in the session's project directory.
 * Deciding that here means an out-of-scope file is labelled before the user
 * commits to an action, instead of failing after two taps.
 */
export function isInsideSessionProject(path: string, root: string | undefined | null): boolean {
    if (!root || !path) return false;
    const clean = (value: string) => {
        const collapsed = value.replace(/\/+/g, '/');
        return collapsed.length > 1 ? collapsed.replace(/\/$/, '') : collapsed;
    };
    const base = clean(root);
    const target = clean(path);
    // Relative paths are resolved against the project root by the Agent.
    if (!target.startsWith('/')) return !target.split('/').includes('..');
    return target === base || target.startsWith(base === '/' ? '/' : base + '/');
}
