import * as React from 'react';
import { AppState, Platform } from 'react-native';
import { apiSocket, getCurrentAppState } from '@/sync/apiSocket';
import { NativeAppApprovalController, nativeApprovalReceiptStore, type NativeApprovalState } from '@/sync/nativeAppApproval';

export function useNativeAppApproval(sessionId: string, supported: boolean, online: boolean) {
    const empty: NativeApprovalState = { prompt: null, busy: false, unavailable: false, submitted: false, issue: null };
    const [snapshot, setSnapshot] = React.useState({ sessionId, state: empty });
    const state = snapshot.sessionId === sessionId && supported ? snapshot.state : empty;
    const controller = React.useRef<NativeAppApprovalController | null>(null);
    const live = React.useRef({ online, sessionId, supported });
    live.current = { online, sessionId, supported };
    React.useEffect(() => {
        setSnapshot({ sessionId, state: { prompt: null, busy: false, unavailable: false, submitted: false, issue: null } });
        if (!supported) return;
        let connected = false, disposed = false;
        let timer: ReturnType<typeof setTimeout>;
        const monitor = new NativeAppApprovalController(
            params => apiSocket.sessionRPC(sessionId, 'native-computer', params),
            () => connected && live.current.online && live.current.sessionId === sessionId && live.current.supported && getCurrentAppState() === 'active',
            state => setSnapshot({ sessionId, state }), nativeApprovalReceiptStore(sessionId),
        );
        controller.current = monitor;
        const poll = async () => {
            clearTimeout(timer);
            await monitor.poll();
            if (!disposed) { clearTimeout(timer); timer = setTimeout(poll, 2_000); }
        };
        const wake = () => { monitor.connectionChanged(); void poll(); };
        const unsubscribe = apiSocket.onStatusChange(status => { connected = status === 'connected'; wake(); });
        const appState = AppState.addEventListener('change', wake);
        if (Platform.OS === 'web') { document.addEventListener('visibilitychange', wake); window.addEventListener('focus', wake); window.addEventListener('blur', wake); }
        return () => {
            disposed = true; monitor.stop(); clearTimeout(timer); unsubscribe(); appState.remove();
            if (Platform.OS === 'web') { document.removeEventListener('visibilitychange', wake); window.removeEventListener('focus', wake); window.removeEventListener('blur', wake); }
            if (controller.current === monitor) controller.current = null;
        };
    }, [sessionId, supported]);
    React.useEffect(() => { controller.current?.connectionChanged(); void controller.current?.poll(); }, [online]);
    return { ...state, unavailable: state.unavailable || !online,
        respond: (choice: 'allow' | 'deny') => controller.current?.respond(choice) };
}
