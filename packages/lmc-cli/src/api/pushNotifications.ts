import type { Metadata } from './types'

export interface PushToken {
    id: string
    token: string
    createdAt: number
    updatedAt: number
}

export type SessionNotificationKind = 'done' | 'permission' | 'question'

function getSessionTitle(metadata: Metadata | null | undefined): string {
    const summaryText = metadata?.summary?.text?.trim()
    if (summaryText) {
        return summaryText
    }

    const path = metadata?.path?.trim()
    if (!path) {
        return 'Session'
    }

    const segments = path.split(/[\\/]/).filter(Boolean)
    return segments[segments.length - 1] || 'Session'
}

function getSessionNotificationUrl(data: Record<string, any> | undefined): `/session/${string}` | null {
    const sessionId = data?.sessionId
    if (typeof sessionId !== 'string') {
        return null
    }

    const trimmedSessionId = sessionId.trim()
    if (!trimmedSessionId) {
        return null
    }

    return `/session/${encodeURIComponent(trimmedSessionId)}`
}

export function getSessionNotificationTitle(
    kind: SessionNotificationKind
): string {
    switch (kind) {
        case 'done':
            return "It's ready!"
        case 'permission':
            return 'Permission request'
        case 'question':
            return 'Clarification needed'
    }
}

export function getSessionNotificationBody(
    metadata: Metadata | null | undefined
): string {
    return getSessionTitle(metadata)
}

export function getSessionNotificationCopy(
    kind: SessionNotificationKind,
    metadata: Metadata | null | undefined
): { title: string; body: string } {
    return {
        title: getSessionNotificationTitle(kind),
        body: getSessionNotificationBody(metadata),
    }
}

/** Compatibility boundary: Web state arrives over Socket.IO, never Expo. */
export class PushNotificationClient {
    constructor(_token: string, _baseUrl?: string) {}
    async fetchPushTokens(): Promise<PushToken[]> { return []; }
    async sendPushNotifications(_messages: unknown[]): Promise<void> {}
    sendToAllDevices(_title: string, _body?: string, _data?: Record<string, any>): void {}
    sendSessionNotification(_params: { kind: SessionNotificationKind; metadata: Metadata | null | undefined; data?: Record<string, any> }): void {}
}
