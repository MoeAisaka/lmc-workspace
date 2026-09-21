import { expect, it, vi } from 'vitest'

const port = vi.hoisted(() => ({ on: vi.fn(), postMessage: vi.fn() }))
vi.mock('node:worker_threads', () => ({ parentPort: port, workerData: {
    storagePath: '/tmp/lmc-worker-test-unused', serverUrl: 'https://center.example',
    webappUrl: 'https://center.example', clientId: 'audit',
} }))
vi.mock('node:fs/promises', () => ({
    readFile: vi.fn().mockRejectedValue(Object.assign(new Error('missing'), {code:'ENOENT'})),
    mkdir: vi.fn(), rename: vi.fn(), unlink: vi.fn(), writeFile: vi.fn(),
}))

it('starts device pairing using the configured center and a stable polling proof', async () => {
    const fetch = vi.fn().mockResolvedValue({ok:true, json:async()=>({state:'requested'})})
    vi.stubGlobal('fetch', fetch)
    const listeners = process.listeners('uncaughtException')
    let handler: ((msg: unknown) => void) | undefined
    try {
        await import('./worker')
        handler = port.on.mock.calls.find(call=>call[0]==='message')?.[1]
        handler!({kind:'startLinkDevice',requestId:'test'})
        await vi.waitFor(()=>expect(fetch.mock.calls.length).toBeGreaterThanOrEqual(2))
        const [url, init] = fetch.mock.calls[0]
        const body = JSON.parse(init.body)
        expect(url).toBe('https://center.example/v1/auth/request')
        expect(body.pollSecret).toMatch(/^[A-Za-z0-9_-]{43}$/)
        expect(body.supportsV2).toBe(false)
        expect(JSON.parse(fetch.mock.calls[1][1].body)).toEqual(body)
        const response = port.postMessage.mock.calls.map(call=>call[0]).find(msg=>msg.kind==='response' && msg.requestId==='test')
        expect(response.ok).toBe(true)
        expect(response.state.authFlow.authUrl).toMatch(/^https:\/\/center\.example\/terminal\/connect#key=/)
    } finally {
        handler?.({kind:'cancelAuth',requestId:'cancel'})
        vi.unstubAllGlobals()
        for (const listener of process.listeners('uncaughtException')) {
            if (!listeners.includes(listener)) process.removeListener('uncaughtException', listener)
        }
    }
})
