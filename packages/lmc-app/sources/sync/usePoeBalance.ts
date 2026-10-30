import * as React from 'react';
import { AppState, Platform } from 'react-native';
import { PoeBalanceSchema, type PoeBalance } from 'lmc-wire';
import { useAllMachines } from './storage';
import { apiSocket } from './apiSocket';

// A balance is account-wide: select one device, never add readings together.
const cache = new Map<string, PoeBalance>();
export function usePoeBalance() {
    const machines = useAllMachines({ includeOffline: true });
    const candidates = machines.filter(m => m.active && m.metadata?.poeBalance === true).map(m => m.id).sort();
    const key = candidates.join(',');
    const supported = machines.some(m => m.metadata?.poeBalance === true);
    const [state, setState] = React.useState<{ balance: PoeBalance | null; failed: boolean; loading: boolean }>({ balance: null, failed: false, loading: false });
    const [now, setNow] = React.useState(Date.now());
    const refreshRef = React.useRef<() => void>(() => {});
    React.useEffect(() => {
        let disposed = false, busy = false;
        const ids = key ? key.split(',') : [];
        const cached = ids.map(id => cache.get(id)).find(Boolean) ?? null;
        setState({ balance: cached, failed: !ids.length, loading: false });
        const refresh = async () => {
            if (busy || !ids.length || (Platform.OS === 'web' && document.hidden)) return;
            busy = true;
            setState(s => ({ ...s, loading: true }));
            try {
                let fallback: PoeBalance | null = null;
                let failed = false;
                for (const id of ids) {
                    try {
                        const reply = await apiSocket.machineRPC<unknown, Record<string, never>>(id, 'poe-balance', {});
                        const balance = PoeBalanceSchema.parse(reply);
                        if (disposed) return;
                        if (balance.status === 'unconfigured') { cache.delete(id); fallback ??= balance; continue; }
                        // A configured source's stale/error state remains visible instead of silently switching accounts.
                        cache.clear(); cache.set(id, balance);
                        setState({ balance, failed: false, loading: false });
                        return;
                    } catch { failed = true; }
                }
                if (!disposed) setState(s => ({ balance: failed ? s.balance : fallback, failed, loading: false }));
            } finally {
                busy = false;
                if (!disposed) { setNow(Date.now()); setState(s => ({ ...s, loading: false })); }
            }
        };
        refreshRef.current = () => { void refresh(); };
        void refresh();
        const timer = setInterval(() => { setNow(Date.now()); void refresh(); }, 60_000);
        const subscription = AppState.addEventListener('change', state => { if (state === 'active') void refresh(); });
        const visible = () => { if (!document.hidden) void refresh(); };
        if (Platform.OS === 'web') document.addEventListener('visibilitychange', visible);
        return () => { disposed = true; clearInterval(timer); subscription.remove(); if (Platform.OS === 'web') document.removeEventListener('visibilitychange', visible); };
    }, [key]);
    return { ...state, now, supported, available: candidates.length > 0, refresh: () => refreshRef.current() };
}
