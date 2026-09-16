/**
 * One in-flight avatar mutation per Project inside this app process.
 *
 * The listener surface lets every workspace header for the same project show
 * the same disabled/busy state. The server still owns final authorization;
 * this lock only prevents accidental overlapping work from one client.
 */
export class ProjectAvatarMutationLock {
    private readonly activeProjectIds = new Set<string>();
    private readonly listeners = new Set<() => void>();

    subscribe = (listener: () => void): (() => void) => {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    };

    isLocked = (projectId: string): boolean => this.activeProjectIds.has(projectId);

    async run<T>(projectId: string, operation: () => Promise<T>): Promise<T> {
        if (this.activeProjectIds.has(projectId)) {
            throw new Error('Project avatar update already in progress');
        }

        this.activeProjectIds.add(projectId);
        this.notify();
        try {
            return await operation();
        } finally {
            this.activeProjectIds.delete(projectId);
            this.notify();
        }
    }

    private notify(): void {
        for (const listener of this.listeners) {
            // A view subscription must never be able to strand the lock.
            try {
                listener();
            } catch {
                // Subscriptions are advisory; mutation safety wins over a broken observer.
            }
        }
    }
}
