import * as React from 'react';
import { AppState, Platform } from 'react-native';
import { AccountQuotaSnapshotSchema, type AccountQuotaSnapshot } from 'lmc-wire';
import { useAllMachines, useAllSessions } from './storage';
import { overlaySessionUsage } from './accountQuotaOverlay';
import { apiSocket } from './apiSocket';

// Memory only, keyed by the encrypted source device (never summed across devices).
const cache = new Map<string, AccountQuotaSnapshot>();
export function useAccountQuota() {
    const machines = useAllMachines({ includeOffline: true });
    const sessions = useAllSessions();
    const source = machines.filter(m => m.metadata?.accountQuota === true)
        .sort((a, b) => Number(b.active) - Number(a.active) || a.id.localeCompare(b.id))[0];
    const id = source?.id;
    const online = !!source?.active;
    const [result, setResult] = React.useState<{ id?: string; snapshot: AccountQuotaSnapshot | null; failed: boolean }>({ snapshot: null, failed: false });
    const [loading, setLoading] = React.useState(false);
    const [now, setNow] = React.useState(Date.now());
    const refreshRef = React.useRef<() => void>(() => {});
    React.useEffect(() => {
        let disposed = false, busy = false;
        setResult({ id, snapshot: id ? cache.get(id) ?? null : null, failed: !online });
        setLoading(false);
        const refresh = async () => {
            if (!id || !online || busy || (Platform.OS === 'web' && typeof document !== 'undefined' && document.hidden)) return;
            busy = true;
            setLoading(true);
            try {
                const reply = await apiSocket.machineRPC<{ snapshot?: unknown }, Record<string, never>>(id, 'account-quota', {});
                const parsed = AccountQuotaSnapshotSchema.safeParse(reply?.snapshot);
                if (!parsed.success) throw new Error('Quota unavailable');
                if (!disposed) {
                    cache.clear(); cache.set(id, parsed.data);
                    setResult({ id, snapshot: parsed.data, failed: false });
                }
            } catch {
                if (!disposed) setResult({ id, snapshot: cache.get(id) ?? null, failed: true });
            } finally { busy = false; if (!disposed) { setLoading(false); setNow(Date.now()); } }
        };
        refreshRef.current = () => { void refresh(); };
        void refresh();
        const timer = setInterval(() => { setNow(Date.now()); void refresh(); }, 30_000);
        const subscription = AppState.addEventListener('change', state => { if (state === 'active') void refresh(); });
        const visible = () => { if (!document.hidden) void refresh(); };
        if (Platform.OS === 'web') document.addEventListener('visibilitychange', visible);
        return () => {
            disposed = true; clearInterval(timer); subscription.remove();
            if (Platform.OS === 'web') document.removeEventListener('visibilitychange', visible);
        };
    }, [id, online]);
    const snapshot = result.id === id ? result.snapshot : null;
    const fresh = React.useMemo(() => overlaySessionUsage(snapshot, sessions), [snapshot, sessions]);
    return { snapshot: fresh, failed: result.failed,
        loading, available: online, now, refresh: () => refreshRef.current() };
}
