import * as React from 'react';
import { AppState } from 'react-native';
import { engineLoginRequest } from '@/sync/engineLogin';
import { loginIsTerminal, type EngineLoginError, type EngineLoginSnapshot } from 'lmc-wire';

export function useEngineLogin(sessionId: string, enabled = true) {
    const [flow, setFlow] = React.useState<EngineLoginSnapshot | null>(null);
    const [error, setError] = React.useState<EngineLoginError>();
    const [busy, setBusy] = React.useState(false);
    const sequence = React.useRef(0);
    const mounted = React.useRef(true);
    const actionPending = React.useRef(0);
    const statusPending = React.useRef(0);
    React.useEffect(() => { mounted.current = true; return () => { mounted.current = false; sequence.current++; }; }, []);
    React.useEffect(() => {
        sequence.current++; actionPending.current = 0; statusPending.current = 0;
        setFlow(null); setError(undefined); setBusy(false);
    }, [sessionId]);
    const request = React.useCallback(async (action: 'status' | 'start' | 'check' | 'auto' | 'submit' | 'cancel', extra?: { id?: string; code?: string }) => {
        if (actionPending.current || (action === 'status' && statusPending.current)) return;
        const seq = ++sequence.current;
        if (action !== 'status') { actionPending.current = seq; setBusy(true); }
        else statusPending.current = seq;
        try {
            const reply = await engineLoginRequest(sessionId, action, extra);
            if (!mounted.current || seq !== sequence.current) return;
            if (reply.flow) setFlow(reply.flow);
            else if (!reply.error) setFlow(null);
            setError(previous => action === 'status' && !reply.flow && !reply.error ? 'stale' : action === 'status' && !reply.error && previous !== 'offline' ? previous : reply.error);
        } finally {
            if (statusPending.current === seq) statusPending.current = 0;
            if (actionPending.current === seq) { actionPending.current = 0; if (mounted.current) setBusy(false); }
        }
    }, [sessionId]);
    const polling = enabled || (!!flow && !loginIsTerminal(flow.state));
    React.useEffect(() => {
        if (!polling) return;
        const poll = () => { if (AppState.currentState !== 'background' && AppState.currentState !== 'inactive') void request('status'); };
        poll();
        const timer = setInterval(poll, 2500);
        const subscription = AppState.addEventListener('change', state => { if (state === 'active') poll(); });
        return () => { clearInterval(timer); subscription.remove(); };
    }, [polling, request]);
    return { flow, error, busy, request };
}
