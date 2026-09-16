export type LmcAuthStatus =
    | 'starting'
    | 'unconfigured'
    | 'authenticating'
    | 'authenticated'
    | 'error'

export type LmcAuthMethod = 'link-device' | 'create-account' | 'restore-secret'

export interface LmcAuthFlowSnapshot {
    method: LmcAuthMethod
    authUrl?: string
    publicKey?: string
    startedAt: number
}

export interface LmcStateSnapshot {
    status: LmcAuthStatus
    serverUrl: string
    webappUrl: string
    clientReady: boolean
    accountId?: string
    tokenExpiresAt?: number
    authFlow?: LmcAuthFlowSnapshot
    error?: string
    updatedAt: number
}

export interface LmcAuthenticatedClientStatus {
    ready: boolean
    serverUrl: string
    accountId?: string
    anonId?: string
    contentPublicKey?: string
}

export type LmcWorkerRequest =
    | { kind: 'getState' }
    | { kind: 'createAccount' }
    | { kind: 'startLinkDevice' }
    | { kind: 'restoreSecret'; secretKey: string }
    | { kind: 'cancelAuth' }
    | { kind: 'logout' }
    | { kind: 'clientStatus' }

export type LmcWorkerRequestWithId = LmcWorkerRequest & { requestId: string }

export type LmcWorkerResponse =
    | {
          kind: 'response'
          requestId: string
          ok: true
          state: LmcStateSnapshot
          value?: unknown
      }
    | {
          kind: 'response'
          requestId: string
          ok: false
          state: LmcStateSnapshot
          error: string
      }

export type LmcWorkerStateMessage = {
    kind: 'state'
    state: LmcStateSnapshot
}

export type LmcWorkerFatalMessage = {
    kind: 'fatal'
    error: string
}

export type LmcWorkerMessage =
    | LmcWorkerResponse
    | LmcWorkerStateMessage
    | LmcWorkerFatalMessage
