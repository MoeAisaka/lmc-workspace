#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';

export function runChecks(checks) {
    for (const check of checks) {
        console.log(`Checking ${check.name}`);
        const result = spawnSync(process.execPath, check.args, {
            cwd: check.cwd, stdio: 'inherit', timeout: 300_000,
        });
        if (result.error || result.signal || result.status !== 0) {
            console.error(`FAILED: ${check.name}${result.error ? ` (${result.error.message})` : ''}`);
            return result.status || 1;
        }
    }
    return 0;
}

function main() {
    if (process.argv.includes('--help')) {
        console.log('Usage: node scripts/verify-astra-p0.mjs\nRuns offline Astra boundary tests and app/CLI typechecks. No install, build, deployment, or live model requests.');
        return 0;
    }
    if (process.argv.length > 2) {
        console.error('Unknown argument. Use --help.');
        return 2;
    }
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
    const require = createRequire(join(root, 'package.json'));
    // Resolve installed dependencies; never invoke npx or package installation.
    const vitest = join(dirname(require.resolve('vitest/package.json')), 'vitest.mjs');
    const tsc = join(dirname(require.resolve('typescript/package.json')), 'bin/tsc');
    const app = join(root, 'packages/lmc-app');
    const cli = join(root, 'packages/lmc-cli');
    const checks = [
        { name: 'verifier failure handling', cwd: root, args: ['--test', 'scripts/verify-astra-p0.test.mjs'] },
        { name: 'WebApp metadata, catalog and spawn', cwd: app, args: [vitest, 'run', 'sources/sync/messageMeta.test.ts', 'sources/components/modelModeOptions.test.ts', 'sources/hooks/useStartSessionFromDraft.test.ts', 'sources/sync/sessionConfigPresets.test.ts', 'sources/sync/projectAvatarSettings.test.ts', 'sources/utils/projectAvatarImage.test.ts', 'sources/utils/projectAvatarEligibility.test.ts', 'sources/utils/projectAvatarMutationLock.test.ts', 'sources/sync/sessionOrder.test.ts', 'sources/sync/ops.serviceTier.test.ts', 'sources/components/CodexServiceTierSettings.test.ts', 'sources/components/SessionHeaderActions.test.ts', 'sources/utils/pointerEvents.test.ts', 'sources/utils/touchMenuRelease.test.ts', 'sources/sync/ops.contextLimits.test.ts', 'sources/sync/codexContextLimits.test.ts', 'sources/components/CodexContextSettings.test.ts', 'sources/sync/ops.codexFork.test.ts', 'sources/sync/ops.rigSpawn.test.ts', 'sources/sync/sessionNames.test.ts', 'sources/sync/sessionRename.test.ts', 'sources/sync/settings.spec.ts', 'sources/text/localFeatures.test.ts', 'sources/keyboard/shortcuts.test.ts'] },
        { name: 'CLI state, launch and RPC transport', cwd: cli, args: [vitest, 'run', '--config', 'vitest.astra.config.ts'] },
        { name: 'WebApp TypeScript', cwd: app, args: [tsc, '--noEmit', '--incremental', 'false'] },
        { name: 'CLI TypeScript', cwd: cli, args: [tsc, '--noEmit', '--incremental', 'false'] },
    ];
    const result = runChecks(checks);
    if (result === 0) console.log('Offline checks passed. Deployment, browser acceptance and live model availability are NOT verified.');
    return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    try { process.exitCode = main(); }
    catch (error) { console.error(error.message); process.exitCode = 1; }
}
