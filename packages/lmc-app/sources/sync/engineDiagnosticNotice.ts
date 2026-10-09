import type { EngineDiagnostics } from 'lmc-wire';

/** Session-only notice; this never changes a list's status/icon contract. */
export function engineDiagnosticNotice(diagnostics: EngineDiagnostics | null | undefined, now: number) {
    if (!diagnostics?.delivery && !diagnostics?.noProgress && !diagnostics?.nativeExit) return null;
    const noProgress = diagnostics.noProgress;
    const delivery = diagnostics.delivery;
    const systemPrompt = [noProgress?.systemPrompt, delivery?.systemPrompt]
        .filter(value => value !== undefined).sort((a, b) => b!.checkedAt - a!.checkedAt)[0]!;
    return { delivery, noProgress, nativeExit: diagnostics.nativeExit,
        minutes: noProgress ? Math.max(0, Math.floor((now - noProgress.since) / 60_000)) : undefined,
        systemPrompt };
}
