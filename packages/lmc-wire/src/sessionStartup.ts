// Cold Windows startup can exceed 30s before the first local registration.
// Keep each enclosing transport budget longer than the operation it carries.
export const SESSION_REGISTRATION_TIMEOUT_MS = 90_000;
export const SESSION_START_RPC_TIMEOUT_MS = 120_000;
export const SESSION_START_ACK_TIMEOUT_MS = 150_000;

export function isSessionStartRpc(method: string): boolean {
    const name = method.slice(method.lastIndexOf(':') + 1);
    return name === 'spawn-happy-session' || name === 'spawn-lmc-session';
}
