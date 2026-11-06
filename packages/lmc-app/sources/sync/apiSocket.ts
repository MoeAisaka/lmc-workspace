import { isSessionStartRpc, SESSION_START_ACK_TIMEOUT_MS } from 'lmc-wire';
import { io, Socket } from 'socket.io-client';
import { AppState, Platform } from 'react-native';
import Constants from 'expo-constants';
import { TokenStorage } from '@/auth/tokenStorage';
import { Encryption } from './encryption/encryption';
import { storage } from './storage';
import { t } from '@/text';
import { translateLmcServerMessage } from '@/utils/lmc/serverErrorText';

export function getLmcClientId(): string {
    let platform: string = Platform.OS; // 'ios' | 'android' | 'web'
    if (platform === 'web' && typeof window !== 'undefined' && '__TAURI__' in window) {
        platform = 'desktop';
    }
    const version = Constants.expoConfig?.version || '0.0.0';
    return `${platform}/${version}`;
}

/**
 * Compute the current "active" or "background" state for the current platform.
 * Mobile uses AppState. Web/desktop uses document.visibilityState + window focus —
 * "active" means the tab is visible AND has focus, so a backgrounded tab or an
 * unfocused window correctly counts as background and won't suppress mobile pushes.
 */
export function getCurrentAppState(): 'active' | 'background' {
    if (Platform.OS === 'web') {
        if (typeof document === 'undefined') {
            return 'active';
        }
        const visible = document.visibilityState === 'visible';
        const focused = typeof document.hasFocus === 'function' ? document.hasFocus() : true;
        return visible && focused ? 'active' : 'background';
    }
    return AppState.currentState === 'active' ? 'active' : 'background';
}

//
// Types
//

export interface SyncSocketConfig {
    endpoint: string;
    token: string;
}

export interface SyncSocketState {
    isConnected: boolean;
    connectionStatus: 'disconnected' | 'connecting' | 'connected' | 'error';
    lastError: Error | null;
}

export type SyncSocketListener = (state: SyncSocketState) => void;

// Ordinary calls allow reconnect plus a 30s operation. Session creation uses
// its own longer, shared budget below so cold startup is not reported as failure.
const RPC_ACK_TIMEOUT_MS = 50_000;

//
// Main Class
//

class ApiSocket {

    // State
    private socket: Socket | null = null;
    private config: SyncSocketConfig | null = null;
    private encryption: Encryption | null = null;
    private messageHandlers: Map<string, (data: any) => void> = new Map();
    private reconnectedListeners: Set<() => void> = new Set();
    private statusListeners: Set<(status: 'disconnected' | 'connecting' | 'connected' | 'error') => void> = new Set();
    private currentStatus: 'disconnected' | 'connecting' | 'connected' | 'error' = 'disconnected';
    private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    private reconnectDelay = 1_000;

    //
    // Initialization
    //

    initialize(config: SyncSocketConfig, encryption: Encryption) {
        this.config = config;
        this.encryption = encryption;
        this.connect();
    }

    //
    // Connection Management
    //

    connect() {
        if (!this.config || this.socket) {
            return;
        }

        this.updateStatus('connecting');

        this.socket = io(this.config.endpoint, {
            path: '/v1/updates',
            // A callback, not an object literal: socket.io re-invokes it for
            // every connect AND reconnect, so appState is read fresh each time.
            // With a literal, a socket that first connected while foregrounded
            // would keep announcing `active` on later reconnects, and the server
            // would suppress pushes for a backgrounded user until the follow-up
            // `app-state` event landed.
            auth: (cb) => cb({
                token: this.config!.token,
                clientType: 'user-scoped' as const,
                lmcClient: getLmcClientId(),
                appState: getCurrentAppState(),
            }),
            transports: ['websocket'],
            reconnection: true,
            reconnectionDelay: 1000,
            reconnectionDelayMax: 5000,
            reconnectionAttempts: Infinity
        });

        this.setupEventHandlers();
    }

    disconnect() {
        this.clearRejectedReconnect();
        const socket = this.socket;
        this.socket = null;
        socket?.disconnect();
        this.updateStatus('disconnected');
    }

    //
    // Listener Management
    //

    onReconnected = (listener: () => void) => {
        this.reconnectedListeners.add(listener);
        return () => this.reconnectedListeners.delete(listener);
    };

    onStatusChange = (listener: (status: 'disconnected' | 'connecting' | 'connected' | 'error') => void) => {
        this.statusListeners.add(listener);
        // Immediately notify with current status
        listener(this.currentStatus);
        return () => this.statusListeners.delete(listener);
    };

    //
    // Message Handling
    //

    onMessage(event: string, handler: (data: any) => void) {
        this.messageHandlers.set(event, handler);
        return () => this.messageHandlers.delete(event);
    }

    offMessage(event: string, handler: (data: any) => void) {
        this.messageHandlers.delete(event);
    }

    /**
     * The server answers every rpc-call it hears, but an emit made while the
     * socket is down is buffered by socket.io and its ack never arrives, so a
     * bare emitWithAck waits for the rest of the app's life. The server's own
     * budget includes reconnect plus execution. Session creation has a larger
     * bounded budget than ordinary RPCs because engine startup may be slow.
     */
    private async rpcCall(method: string, params: unknown): Promise<any> {
        // disconnect() nulls the socket, so this is a state a caller can really
        // reach. Read it once and say what happened, rather than letting a
        // property access on null surface as a TypeError.
        const socket = this.socket;
        if (!socket) {
            throw new Error('Not connected to the server');
        }
        return await socket
            .timeout(isSessionStartRpc(method) ? SESSION_START_ACK_TIMEOUT_MS : RPC_ACK_TIMEOUT_MS)
            .emitWithAck('rpc-call', { method, params })
            .catch(() => {
                throw new Error('The computer did not respond');
            });
    }

    /**
     * RPC call for sessions - uses session-specific encryption
     */
    async sessionRPC<R, A>(sessionId: string, method: string, params: A): Promise<R> {
        const sharedSession = storage.getState().sessions[sessionId];
        const sessionEncryption = this.encryption!.getSessionEncryption(sessionId);
        if (!sessionEncryption) {
            throw new Error(`Session encryption not found for ${sessionId}`);
        }

        if (sharedSession?.shared) {
            const action = method === 'abort' ? 'stop' : ['permission', 'communication'].includes(method) ? 'approve' : null;
            if (!action || !sharedSession.accessActions?.includes(action)) throw new Error(t('lmc.sharing.sharedActionUnauthorized'));
            const response = await this.request(`/v1/lmc/sessions/${encodeURIComponent(sessionId)}/action`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(40000),
                body: JSON.stringify({ method, params: await sessionEncryption.encryptRaw(params) }),
            });
            const data = await response.json();
            if (!response.ok) throw new Error(translateLmcServerMessage(data.error, data.code) || t('lmc.sharing.sharedActionIncomplete'));
            return await sessionEncryption.decryptRaw(data.result) as R;
        }

        const result = await this.rpcCall(
            `${sessionId}:${method}`,
            await sessionEncryption.encryptRaw(params),
        );

        if (result.ok) {
            return await sessionEncryption.decryptRaw(result.result) as R;
        }
        throw new Error(result.error || 'RPC call failed');
    }

    /**
     * RPC call for machines - uses legacy/global encryption (for now)
     */
    async machineRPC<R, A>(machineId: string, method: string, params: A): Promise<R> {
        const machineEncryption = this.encryption!.getMachineEncryption(machineId);
        if (!machineEncryption) {
            throw new Error(`Machine encryption not found for ${machineId}`);
        }

        const result = await this.rpcCall(
            `${machineId}:${method}`,
            await machineEncryption.encryptRaw(params),
        );

        if (result.ok) {
            return await machineEncryption.decryptRaw(result.result) as R;
        }
        throw new Error(result.error || 'RPC call failed');
    }

    /**
     * Sends app focus state to server for push notification routing.
     * Server uses this to suppress pushes when the mobile app is in foreground.
     */
    sendAppState(state: string) {
        this.socket?.emit('app-state', { state });
    }

    send(event: string, data: any) {
        this.socket!.emit(event, data);
        return true;
    }

    async emitWithAck<T = any>(event: string, data: any, timeoutMs?: number): Promise<T> {
        if (!this.socket) {
            throw new Error('Socket not connected');
        }
        return timeoutMs === undefined
            ? await this.socket.emitWithAck(event, data)
            : await this.socket.timeout(timeoutMs).emitWithAck(event, data);
    }

    //
    // HTTP Requests
    //

    async request(path: string, options?: RequestInit): Promise<Response> {
        if (!this.config) {
            throw new Error('SyncSocket not initialized');
        }

        const credentials = await TokenStorage.getCredentials();
        if (!credentials) {
            throw new Error('No authentication credentials');
        }

        const url = `${this.config.endpoint}${path}`;
        const headers = {
            'Authorization': `Bearer ${credentials.token}`,
            'X-Happy-Client': getLmcClientId(),
            ...options?.headers
        };

        return fetch(url, {
            ...options,
            headers
        });
    }

    //
    // Token Management
    //

    updateToken(newToken: string) {
        if (this.config && this.config.token !== newToken) {
            this.config.token = newToken;

            if (this.socket) {
                this.disconnect();
                this.connect();
            }
        }
    }

    //
    // Private Methods
    //

    private isVerboseLogging(): boolean {
        try {
            return storage.getState().localSettings.verboseLogging;
        } catch {
            return false;
        }
    }

    private updateStatus(status: 'disconnected' | 'connecting' | 'connected' | 'error') {
        if (this.currentStatus !== status) {
            this.currentStatus = status;
            this.statusListeners.forEach(listener => listener(status));
        }
    }

    private clearRejectedReconnect() {
        if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
        this.reconnectDelay = 1_000;
    }

    private retryRejectedConnection(socket: Socket) {
        // Socket.IO retries transport errors, but stops after middleware denial.
        // Auth verification may fail transiently (e.g. a database outage), so
        // retry the authenticated handshake without replacing the socket or
        // losing buffered RPCs. Every attempt still requires server approval.
        if (this.socket !== socket || socket.active || socket.connected || this.reconnectTimer !== null) return;
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            if (this.socket !== socket || socket.active || socket.connected) return;
            this.updateStatus('connecting');
            socket.connect();
        }, this.reconnectDelay);
        this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30_000);
    }

    private setupEventHandlers() {
        const socket = this.socket;
        if (!socket) return;

        // Connection events
        socket.on('connect', () => {
            if (this.socket !== socket) return;
            this.clearRejectedReconnect();
            if (this.isVerboseLogging()) {
                console.log('🔌 SyncSocket: Connected, recovered: ' + this.socket?.recovered);
                console.log('🔌 SyncSocket: Socket ID:', this.socket?.id);
            }
            this.updateStatus('connected');
            if (!this.socket?.recovered) {
                this.reconnectedListeners.forEach(listener => listener());
            }
        });

        socket.on('disconnect', (reason) => {
            if (this.socket !== socket) return;
            if (this.isVerboseLogging()) {
                console.log('🔌 SyncSocket: Disconnected', reason);
            }
            this.updateStatus('disconnected');
        });

        // Error events
        socket.on('connect_error', (error) => {
            if (this.socket !== socket) return;
            if (this.isVerboseLogging()) {
                console.error('🔌 SyncSocket: Connection error', error);
            }
            this.updateStatus('error');
            this.retryRejectedConnection(socket);
        });

        socket.on('error', (error) => {
            if (this.socket !== socket) return;
            if (this.isVerboseLogging()) {
                console.error('🔌 SyncSocket: Error', error);
            }
            this.updateStatus('error');
        });

        // Message handling
        socket.onAny((event, data) => {
            if (this.socket !== socket) return;
            if (this.isVerboseLogging()) {
                console.log(`📥 SyncSocket: Received event '${event}':`, JSON.stringify(data).substring(0, 200));
            }
            const handler = this.messageHandlers.get(event);
            if (handler) {
                handler(data);
            }
        });
    }
}

//
// Singleton Export
//

export const apiSocket = new ApiSocket();
