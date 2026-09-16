/**
 * Refresh failures that know which step they belong to.
 *
 * A refresh has four visible steps — wait for the turn, check the login,
 * relaunch, verify — and the error text alone does not say which one failed.
 * Carrying the step lets the app stop the progress card on the right line
 * rather than on a guess.
 */
export type RefreshErrorKind = 'auth' | 'preflight' | 'relaunch' | 'verify';

/**
 * The login check failing the one way the person reading it can fix: the
 * engine is not logged in on the device, and the fix is a command in a
 * terminal there. Distinguished from every other preflight failure so the
 * app can print that command instead of a paragraph.
 */
export class EngineAuthPreflightError extends Error {
    readonly kind = 'auth' as const;
    constructor(message: string, readonly engine: 'claude' | 'codex') {
        super(message);
        this.name = 'EngineAuthPreflightError';
    }
}

/** Any other failure, tagged with the step it happened in. */
export class RefreshStepError extends Error {
    constructor(message: string, readonly kind: Exclude<RefreshErrorKind, 'auth'>, readonly cause?: unknown) {
        super(message);
        this.name = 'RefreshStepError';
    }
}

export function refreshErrorKind(error: unknown): RefreshErrorKind | undefined {
    if (error instanceof EngineAuthPreflightError || error instanceof RefreshStepError) return error.kind;
    return undefined;
}

/** Tags an error with a step unless it already names one. */
export function tagRefreshError(error: unknown, kind: Exclude<RefreshErrorKind, 'auth'>): Error {
    if (refreshErrorKind(error)) return error as Error;
    return new RefreshStepError(error instanceof Error ? error.message : String(error), kind, error);
}
