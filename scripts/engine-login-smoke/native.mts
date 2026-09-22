/** Explicit, isolated native CLI compatibility check. Does not authorize an account. */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startNativeEngineLogin, type LoginChild } from '../../packages/lmc-cli/src/daemon/nativeEngineLogin';
import { checkEngineAuth } from '../../packages/lmc-cli/src/utils/engineAuth';
import { engineLoginEnvironment } from '../../packages/lmc-cli/src/utils/engineLoginContext';
import type { LoginEngine } from 'lmc-wire';

for (const engine of ['claude', 'codex'] as LoginEngine[]) {
    const directory = await mkdtemp(join(tmpdir(), 'lmc-native-login-check-'));
    const context = { engine, cwd: directory, homeDir: directory, configDir: directory, configOverride: directory, key: 'isolated-check', supported: true };
    try {
        const before = await checkEngineAuth(engine, directory, engineLoginEnvironment(context) as Record<string, string>, false);
        if (before !== 'required') throw new Error(`${engine}: empty credential scope was not confirmed; refusing to start probe`);
        await new Promise<void>((resolve, reject) => {
            let child: LoginChild;
            const timer = setTimeout(() => { child?.cancel(); reject(new Error(`${engine}: no supported login prompt within 20 seconds`)); }, 20_000);
            child = startNativeEngineLogin(context, {
                ready(url, userCode) {
                    clearTimeout(timer);
                    child.cancel();
                    const parsed = new URL(url);
                    // Never print the authorization URL query, state, or device code.
                    console.log(JSON.stringify({ engine, endpoint: parsed.origin + parsed.pathname, deviceCodePresent: !!userCode, promptParsed: true }));
                    resolve();
                },
                exit() { clearTimeout(timer); reject(new Error(`${engine}: exited before a supported login prompt`)); },
            });
        });
    } finally {
        // Let bounded cancellation finish even when the prompt probe times out.
        await new Promise(resolve => setTimeout(resolve, 2200));
        await rm(directory, { recursive: true, force: true });
    }
}
