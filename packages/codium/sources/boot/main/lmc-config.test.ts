import { describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { agentSettingsPath, resolveCentreUrls } from './lmc-config'

const settingsWith = (body: string): string => {
    const dir = mkdtempSync(join(tmpdir(), 'codium-lmc-'))
    const p = join(dir, 'settings.json')
    writeFileSync(p, body)
    return p
}

describe('which centre Codium talks to', () => {
    it('takes the centre the CLI is configured for', () => {
        const p = settingsWith(JSON.stringify({ serverUrl: 'https://centre.example:11455', webappUrl: 'https://web.example' }))
        expect(resolveCentreUrls({}, p)).toEqual({ serverUrl: 'https://centre.example:11455', webappUrl: 'https://web.example' })
    })

    it('lets the environment win over the settings file', () => {
        const p = settingsWith(JSON.stringify({ serverUrl: 'https://centre.example', webappUrl: 'https://web.example' }))
        expect(resolveCentreUrls({ LMC_SERVER_URL: 'https://env.example' }, p).serverUrl).toBe('https://env.example')
    })

    it('ignores the pre-rename variables, exactly as the CLI does', () => {
        const p = settingsWith(JSON.stringify({ serverUrl: 'https://centre.example' }))
        expect(resolveCentreUrls({ HAPPY_SERVER_URL: 'https://upstream.example' } as NodeJS.ProcessEnv, p).serverUrl)
            .toBe('https://centre.example')
    })

    it('trails webappUrl behind serverUrl when only one is configured', () => {
        const p = settingsWith(JSON.stringify({ serverUrl: 'https://centre.example' }))
        expect(resolveCentreUrls({}, p).webappUrl).toBe('https://centre.example')
    })

    it('falls back to a local centre, never upstream, when there is nothing to read', () => {
        const urls = resolveCentreUrls({}, join(tmpdir(), 'does-not-exist-' + Date.now(), 'settings.json'))
        expect(urls).toEqual({ serverUrl: 'http://127.0.0.1:4193', webappUrl: 'http://127.0.0.1:4193' })
    })

    it('survives a settings file that is not JSON', () => {
        expect(resolveCentreUrls({}, settingsWith('not json at all')).serverUrl).toBe('http://127.0.0.1:4193')
    })

    it('looks where the CLI actually writes', () => {
        expect(agentSettingsPath('/home/alice')).toBe('/home/alice/.lmc/agent/settings.json')
    })
})
