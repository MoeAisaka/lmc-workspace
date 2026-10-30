import { existsSync } from 'node:fs';

/**
 * Resolves a stable Node executable path for spawning helper/MCP subprocesses.
 *
 * On macOS with Homebrew (`node` or `node@24`), `process.execPath` resolves via
 * realpath into `/opt/homebrew/Cellar/node.../bin/node` (or `/usr/local/Cellar/...`).
 * If `brew upgrade` upgrades Node or a linked dylib while a long-running daemon
 * or session runner stays alive, spawning `process.execPath` fails in `dyld`.
 * Preferring the stable Homebrew `bin/node` symlink keeps subprocess spawns alive
 * across upgrades without affecting Windows, Linux, nvm, or bundled runtimes.
 */
export function resolveNodeExecutable(
    execPath: string = process.execPath,
    platform: NodeJS.Platform = process.platform,
    checkExists: (path: string) => boolean = existsSync,
): string {
    if (platform === 'darwin' && /\/Cellar\/node(?:@\d+)?\//.test(execPath)) {
        const prefix = execPath.split('/Cellar/')[0];
        const candidates = [
            ...(prefix ? [`${prefix}/bin/node`] : []),
            '/opt/homebrew/bin/node',
            '/usr/local/bin/node',
        ];
        for (const candidate of candidates) {
            if (checkExists(candidate)) return candidate;
        }
    }
    return execPath;
}
