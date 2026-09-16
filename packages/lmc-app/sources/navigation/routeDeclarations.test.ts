import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Every <Stack.Screen name="..."> must have a route file behind it. Expo Router
 * does not fail on a name that resolves to nothing: it warns, on every render of
 * the layout, and the warning carries the full list of sibling route names. That
 * warning goes through console.warn, which is captured into the in-memory log
 * ring whether or not console output is enabled — so one stale declaration left
 * behind after a file is deleted quietly grows the tab's memory for as long as
 * it stays open. Cheap to assert here, expensive to find in a heap snapshot.
 */
const APP_DIR = join(process.cwd(), 'sources/app/(app)');
const CANDIDATE_SUFFIXES = ['.tsx', '.ts', '.web.tsx', '.web.ts', '/index.tsx', '/index.ts'];

function declaredScreenNames(layoutSource: string): string[] {
    return [...layoutSource.matchAll(/<Stack\.Screen\s+name="([^"]+)"/g)].map(match => match[1]);
}

describe('route declarations', () => {
    it('extracts only Stack.Screen names, not other name props', () => {
        const sample = `
            <Ionicons name="menu-outline" />
            <Stack.Screen name="dev/colors" options={{}} />
            <Stack.Screen
                name="session/[id]"
            />
        `;
        expect(declaredScreenNames(sample)).toEqual(['dev/colors', 'session/[id]']);
    });

    it('every declared screen resolves to a route file', () => {
        const layout = readFileSync(join(APP_DIR, '_layout.tsx'), 'utf8');
        const names = declaredScreenNames(layout);
        expect(names.length).toBeGreaterThan(0);
        const orphans = names.filter(name =>
            !CANDIDATE_SUFFIXES.some(suffix => existsSync(join(APP_DIR, `${name}${suffix}`))));
        expect(orphans).toEqual([]);
    });
});
