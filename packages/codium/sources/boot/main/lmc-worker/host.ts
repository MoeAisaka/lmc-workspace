import { app, BrowserWindow, ipcMain } from 'electron'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Worker } from 'node:worker_threads'
import type {
    LmcStateSnapshot,
    LmcWorkerMessage,
    LmcWorkerRequest,
    LmcWorkerRequestWithId,
} from '../../../shared/lmc-protocol'
import { storageFilePath } from '../app-storage'
import { resolveCentreUrls } from '../lmc-config'

const __dirname = dirname(fileURLToPath(import.meta.url))

type PendingRequest = {
    resolve: (value: unknown) => void
    reject: (error: Error) => void
}


let worker: Worker | null = null
let latestState: LmcStateSnapshot = {
    status: 'starting',
    ...resolveCentreUrls(),
    clientReady: false,
    updatedAt: Date.now(),
}
const pending = new Map<string, PendingRequest>()

function workerEntryPath(): string {
    const p = join(__dirname, 'lmc-worker.js')
    if (!existsSync(p)) {
        // eslint-disable-next-line no-console
        console.error('[lmc-host] worker bundle missing at', p)
    }
    return p
}

function ensureWorker(): Worker {
    if (worker) return worker
    const w = new Worker(workerEntryPath(), {
        workerData: {
            storagePath: storageFilePath('happy-auth.json'),
            ...resolveCentreUrls(),
            clientId: `codium/${app.getVersion() || '0.0.0'}`,
        },
    })
    w.on('message', (msg: LmcWorkerMessage) => {
        if (msg.kind === 'state') {
            latestState = msg.state
            broadcastState()
            return
        }
        if (msg.kind === 'response') {
            latestState = msg.state
            broadcastState()
            const entry = pending.get(msg.requestId)
            if (!entry) return
            pending.delete(msg.requestId)
            if (msg.ok) {
                entry.resolve({ state: msg.state, value: msg.value })
            } else {
                entry.reject(new Error(msg.error))
            }
            return
        }
        if (msg.kind === 'fatal') {
            // eslint-disable-next-line no-console
            console.error('[lmc-worker] fatal:', msg.error)
        }
    })
    w.on('error', (err) => {
        // eslint-disable-next-line no-console
        console.error('[lmc-worker] error:', err)
        failPending(err.message || 'LMC worker crashed')
        latestState = {
            ...latestState,
            status: 'error',
            clientReady: false,
            error: err.message || 'LMC worker crashed',
            updatedAt: Date.now(),
        }
        broadcastState()
        worker = null
    })
    w.on('exit', (code) => {
        if (code !== 0) {
            const message = `LMC worker exited with code ${code}`
            // eslint-disable-next-line no-console
            console.error('[lmc-worker]', message)
            failPending(message)
            latestState = {
                ...latestState,
                status: 'error',
                clientReady: false,
                error: message,
                updatedAt: Date.now(),
            }
            broadcastState()
        }
        worker = null
    })
    worker = w
    return w
}

function failPending(reason: string): void {
    for (const entry of pending.values()) {
        entry.reject(new Error(reason))
    }
    pending.clear()
}

function broadcastState(): void {
    for (const win of BrowserWindow.getAllWindows()) {
        win.webContents.send('lmc:state', latestState)
    }
}

function sendRequest(request: LmcWorkerRequest): Promise<unknown> {
    const requestId = randomUUID()
    const msg: LmcWorkerRequestWithId = { ...request, requestId }
    const w = ensureWorker()
    return new Promise((resolve, reject) => {
        pending.set(requestId, { resolve, reject })
        w.postMessage(msg)
    })
}

export function registerLmcIpc(): void {
    ipcMain.handle('lmc:state:get', async () => {
        const result = await sendRequest({ kind: 'getState' }) as { state: LmcStateSnapshot }
        return result.state
    })
    ipcMain.handle('lmc:create-account', async () => {
        const result = await sendRequest({ kind: 'createAccount' }) as { state: LmcStateSnapshot }
        return result.state
    })
    ipcMain.handle('lmc:start-link-device', async () => {
        const result = await sendRequest({ kind: 'startLinkDevice' }) as { state: LmcStateSnapshot }
        return result.state
    })
    ipcMain.handle('lmc:restore-secret', async (_e, secretKey: string) => {
        const result = await sendRequest({ kind: 'restoreSecret', secretKey }) as { state: LmcStateSnapshot }
        return result.state
    })
    ipcMain.handle('lmc:cancel-auth', async () => {
        const result = await sendRequest({ kind: 'cancelAuth' }) as { state: LmcStateSnapshot }
        return result.state
    })
    ipcMain.handle('lmc:logout', async () => {
        const result = await sendRequest({ kind: 'logout' }) as { state: LmcStateSnapshot }
        return result.state
    })
    ipcMain.handle('lmc:client-status', async () => {
        const result = await sendRequest({ kind: 'clientStatus' }) as {
            state: LmcStateSnapshot
            value?: unknown
        }
        return result.value
    })
    app.on('before-quit', () => {
        try {
            worker?.terminate()
        } catch {
            /* ignored */
        }
        worker = null
    })
}
