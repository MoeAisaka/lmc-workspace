export const SESSION_OWNERSHIP_CONFLICT = 'SESSION_OWNERSHIP_CONFLICT';
export class SessionOwnershipConflict extends Error {
    readonly code = SESSION_OWNERSHIP_CONFLICT;
}

export function processIsAlive(pid: number): boolean {
    try { process.kill(pid, 0); return true; }
    catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
}

export function assertSessionOwnerAvailable(
    sessionId: string,
    pid: number,
    owners: Iterable<{ happySessionId?: string; pid: number }>,
    isAlive: (pid: number) => boolean = processIsAlive,
): void {
    for (const owner of owners) {
        if (owner.happySessionId === sessionId && owner.pid !== pid && isAlive(owner.pid)) {
            throw new SessionOwnershipConflict(`Session ${sessionId} is already owned by another live runner (PID ${owner.pid}); refusing duplicate registration.`);
        }
    }
}
