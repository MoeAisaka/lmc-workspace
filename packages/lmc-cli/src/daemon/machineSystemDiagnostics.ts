import { checkFullDiskAccess } from '@/modules/diagnostics/systemDiagnostics';
import type { FullDiskAccessDiagnostic } from 'lmc-wire';

/** Capability refresh never holds daemon startup or a session's delivery path. */
export function startMachineSystemDiagnostics(publish: (fullDiskAccess: FullDiskAccessDiagnostic) => Promise<unknown>, check = checkFullDiskAccess) {
    let stopped = false;
    let running = false;
    // Machine metadata is shared state: write it when the answer changes, not on every check.
    let published = '';
    const refresh = async () => {
        if (stopped || running) return;
        running = true;
        try {
            const value = await check();
            const fingerprint = `${value.status}:${value.reason ?? ''}`;
            if (stopped || fingerprint === published) return;
            await publish(value);
            published = fingerprint;
        } catch { /* Check degrades to unknown; publication may be offline. */ }
        finally { running = false; }
    };
    void refresh();
    const timer = setInterval(() => { void refresh(); }, 60_000);
    timer.unref?.();
    return () => { stopped = true; clearInterval(timer); };
}
