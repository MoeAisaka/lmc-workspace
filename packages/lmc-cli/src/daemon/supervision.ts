/**
 * The launchd job passes this flag; nothing else does. Supervision cannot be
 * read from the environment — launchd exports XPC_SERVICE_NAME to its job and
 * every descendant inherits it, so a daemon started by a session would claim
 * to be supervised and the real launchd job would then stand down on every
 * tick, restarting forever without ever owning the daemon.
 */
export const SUPERVISED_FLAG = '--supervised';

/** Arguments the service manager must pass to start the daemon it supervises. */
export const SUPERVISED_DAEMON_ARGS = ['daemon', 'start-sync', SUPERVISED_FLAG] as const;

export function startedBySupervisor(argv: readonly string[]): boolean {
    return argv.includes(SUPERVISED_FLAG);
}
