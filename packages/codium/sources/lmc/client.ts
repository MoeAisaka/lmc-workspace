import { useSyncExternalStore } from 'react'
import type {
    LmcAuthenticatedClientStatus,
    LmcStateSnapshot,
} from '@/shared/lmc-protocol'

const initialState: LmcStateSnapshot = {
    status: 'starting',
    serverUrl: '',
    webappUrl: '',
    clientReady: false,
    updatedAt: Date.now(),
}

let snapshot = initialState
let unsubscribeIpc: (() => void) | null = null
let initialized = false
const listeners = new Set<() => void>()

function emit(next: LmcStateSnapshot): void {
    snapshot = next
    for (const listener of listeners) listener()
}

function setError(message: string): void {
    emit({
        ...snapshot,
        status: 'error',
        error: message,
        updatedAt: Date.now(),
    })
}

function ensureStarted(): void {
    if (initialized) return
    initialized = true
    try {
        unsubscribeIpc = window.lmc.onState(emit)
        void window.lmc.getState().then(emit).catch((err) => {
            setError(err instanceof Error ? err.message : String(err))
        })
    } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
    }
}

export const lmcClient = {
    start(): void {
        ensureStarted()
    },
    getSnapshot(): LmcStateSnapshot {
        return snapshot
    },
    subscribe(listener: () => void): () => void {
        ensureStarted()
        listeners.add(listener)
        return () => {
            listeners.delete(listener)
            if (listeners.size === 0 && unsubscribeIpc) {
                unsubscribeIpc()
                unsubscribeIpc = null
                initialized = false
            }
        }
    },
    async createAccount(): Promise<LmcStateSnapshot> {
        ensureStarted()
        const next = await window.lmc.createAccount()
        emit(next)
        return next
    },
    async startLinkDevice(): Promise<LmcStateSnapshot> {
        ensureStarted()
        const next = await window.lmc.startLinkDevice()
        emit(next)
        return next
    },
    async restoreSecret(secretKey: string): Promise<LmcStateSnapshot> {
        ensureStarted()
        const next = await window.lmc.restoreSecret(secretKey)
        emit(next)
        return next
    },
    async cancelAuth(): Promise<LmcStateSnapshot> {
        ensureStarted()
        const next = await window.lmc.cancelAuth()
        emit(next)
        return next
    },
    async logout(): Promise<LmcStateSnapshot> {
        ensureStarted()
        const next = await window.lmc.logout()
        emit(next)
        return next
    },
    async clientStatus(): Promise<LmcAuthenticatedClientStatus> {
        ensureStarted()
        return window.lmc.clientStatus()
    },
}

export function useLmcState(): LmcStateSnapshot {
    return useSyncExternalStore(
        lmcClient.subscribe,
        lmcClient.getSnapshot,
        lmcClient.getSnapshot,
    )
}
