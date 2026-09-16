import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Where Codium's LMC integration points.
 *
 * It used to read `HAPPY_SERVER_URL` / `HAPPY_WEBAPP_URL` and fall back to
 * upstream's `api.cluster-fluster.com` and `app.happy.engineering`. Nothing in
 * this system sets those variables any more — the CLI moved to `LMC_*` and its
 * own test asserts the old names are ignored — so Codium could not be pointed at
 * the user's own centre at all, and quietly talked to upstream instead.
 *
 * The chain is the CLI's, so the two agree about the same machine without being
 * told twice: env, then the settings file the CLI writes, then a local centre.
 * `webappUrl` trails `serverUrl` for the CLI's reason — otherwise a self-hosted
 * setup points its API at localhost while auth still opens the production webapp.
 */
const DEFAULT_SERVER_URL = 'http://127.0.0.1:4193'

export interface CentreUrls {
    serverUrl: string
    webappUrl: string
}

/** The settings file the LMC CLI keeps its centre in. */
export function agentSettingsPath(homeDir: string = homedir()): string {
    return join(homeDir, '.lmc', 'agent', 'settings.json')
}

function settingString(path: string, key: keyof CentreUrls): string | undefined {
    try {
        const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
        const value = raw[key]
        return typeof value === 'string' && value.length > 0 ? value : undefined
    } catch {
        // No settings yet, unreadable, or not JSON: fall through to the default.
        return undefined
    }
}

export function resolveCentreUrls(
    env: NodeJS.ProcessEnv = process.env,
    settingsPath: string = agentSettingsPath(),
): CentreUrls {
    const serverUrl = env.LMC_SERVER_URL || settingString(settingsPath, 'serverUrl') || DEFAULT_SERVER_URL
    const webappUrl = env.LMC_WEBAPP_URL || settingString(settingsPath, 'webappUrl') || serverUrl
    return { serverUrl, webappUrl }
}
