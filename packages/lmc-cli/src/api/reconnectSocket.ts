import type { Socket } from 'socket.io-client';

/** Retry clients with automatic reconnection disabled, without overlapping namespace handshakes. */
export function reconnectSocketIfIdle(socket: Pick<Socket, 'active' | 'connected' | 'io' | 'disconnect' | 'connect'>): boolean {
    if (socket.active && socket.connected) return false;
    // active alone is insufficient: it stays true after a transport failure when
    // Manager reconnection is disabled. An open/opening engine means a handshake
    // is still in flight, and connect() would send another namespace CONNECT.
    const transport = socket.io.engine?.readyState;
    if (socket.active && transport && transport !== 'closed') return false;
    // A late CONNECT_ERROR can destroy subscriptions without clearing connected.
    // Reset that stale flag before connect(), which otherwise returns early.
    if (socket.connected) socket.disconnect();
    socket.connect();
    return true;
}
