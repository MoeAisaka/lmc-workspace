import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SERVER_PACKAGE_NAME, SERVER_PACKAGE_NAMES } from './serverPackageNames';

const workspacePackageJson = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../../lmc-server-self-host/package.json',
);

describe('self-host server package names', () => {
    it('requires the server under the name the workspace actually publishes', () => {
        // The CLI require()s this name at runtime. When the package was renamed
        // and this constant was not, `lmc server` stopped finding an installed
        // server entirely and fell through to "Could not locate happy-server".
        const published = JSON.parse(readFileSync(workspacePackageJson, 'utf-8')).name;
        expect(SERVER_PACKAGE_NAME).toBe(published);
    });

    it('still accepts the pre-rename name, so existing installs keep working', () => {
        expect(SERVER_PACKAGE_NAMES).toContain('happy-server-self-host');
        expect(SERVER_PACKAGE_NAMES[0]).toBe(SERVER_PACKAGE_NAME);
    });
});
