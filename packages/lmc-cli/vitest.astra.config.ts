import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

// Offline boundary tests only. The regular config builds the CLI in globalSetup;
// this verification entry deliberately has no build, daemon or server lifecycle.
export default defineConfig({
    test: {
        environment: 'node',
        include: [
            'src/codex/__tests__/remoteModeState.test.ts',
            'src/codex/codexAppServerClient.test.ts',
            'src/codex/utils/serialAsyncHandler.test.ts',
            'src/daemon/spawnModeArgs.test.ts',
            'src/codex/contextLimits.test.ts',
            'src/codex/sessionRefresh.test.ts',
            'src/daemon/sessionRefresh.test.ts',
            'src/api/apiSession.test.ts',
            'src/commands/codexCommand.test.ts',
        ],
    },
    resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
});
