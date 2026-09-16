import { lmcClient } from '@/lmc/client'
import type {
    AuthState,
    Capability,
    Plugin,
    PluginContext,
} from '../types'
import type { LmcStateSnapshot } from '@/shared/lmc-protocol'

function mapAuth(state: LmcStateSnapshot): AuthState {
    switch (state.status) {
        case 'authenticated':
            return { status: 'connected', account: state.accountId }
        case 'authenticating':
        case 'starting':
            return { status: 'connecting' }
        case 'error':
            return { status: 'error', message: state.error ?? 'LMC authentication failed' }
        case 'unconfigured':
            return { status: 'unconfigured' }
    }
}

class LmcPlugin implements Plugin {
    id = 'happy'
    name = 'LMC'
    description = 'Encrypted LMC account connection for future sync and remote session support.'
    vendor = 'LMC'
    category = 'integrations' as const
    accent = '#2563eb'

    private auth: AuthState = { status: 'connecting' }
    private capabilities: Capability[] = []
    private unsubscribe: (() => void) | null = null

    async activate(ctx: PluginContext) {
        lmcClient.start()
        this.auth = mapAuth(lmcClient.getSnapshot())
        this.unsubscribe = lmcClient.subscribe(() => {
            this.auth = mapAuth(lmcClient.getSnapshot())
            ctx.onAuthChanged()
        })
    }

    async connect(_credential: string, ctx: PluginContext): Promise<AuthState> {
        this.auth = { status: 'connecting' }
        ctx.onAuthChanged()
        const next = await lmcClient.startLinkDevice()
        this.auth = mapAuth(next)
        ctx.onAuthChanged()
        return this.auth
    }

    async disconnect(ctx: PluginContext) {
        await lmcClient.logout()
        this.auth = mapAuth(lmcClient.getSnapshot())
        ctx.onAuthChanged()
    }

    getAuthState(): AuthState { return this.auth }
    getCapabilities(): readonly Capability[] { return this.capabilities }

    dispose(): void {
        this.unsubscribe?.()
        this.unsubscribe = null
    }
}

export const lmcPlugin: Plugin = new LmcPlugin()
