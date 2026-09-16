import type { Metadata } from '@/api/types';

type ReportResult = 'reported' | 'timeout' | 'unavailable';

/** Give the failure write a bounded chance to reach the server before socket cleanup. */
export async function reportSessionRefreshFailure(
    error: unknown,
    updateMetadata: (updater: (metadata: Metadata) => Metadata) => Promise<void>,
    timeoutMs = 3000,
): Promise<ReportResult> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        const write = Promise.resolve().then(() => updateMetadata(metadata => ({
            ...metadata,
            sessionConfigState: 'error',
            sessionConfigErrorKind: 'verify',
            sessionConfigError: error instanceof Error ? error.message : 'Session restore failed',
            sessionConfigUpdatedAt: Date.now(),
        }))).then((): ReportResult => 'reported', (): ReportResult => 'unavailable');
        const timeout = new Promise<ReportResult>(resolve => {
            timer = setTimeout(() => resolve('timeout'), timeoutMs);
        });
        return await Promise.race([write, timeout]);
    } finally {
        if (timer !== undefined) clearTimeout(timer);
    }
}
