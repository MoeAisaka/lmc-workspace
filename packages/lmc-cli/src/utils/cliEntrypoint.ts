import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';

export function isCliEntrypoint(script: string | undefined, root: string): boolean {
    if (!script) return false;
    const canonical = (path: string) => {
        try { return realpathSync(path); } catch { return resolve(path); }
    };
    const actual = canonical(script);
    return ['dist/index.mjs', 'dist/index.cjs', 'bin/happy.mjs', 'src/index.ts']
        .some(entry => canonical(resolve(root, entry)) === actual);
}
