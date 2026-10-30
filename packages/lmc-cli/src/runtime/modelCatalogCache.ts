import { runtimeRelease } from './managedRuntime';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ModelCatalogsSchema, findCatalogModel, type ModelCatalogs } from 'lmc-wire';
import { configuration } from '@/configuration';
import { readPoeSettings } from './poe';

export const modelCatalogPath = () => join(configuration.lmcHomeDir, 'model-catalogs.json');
export function readModelCatalogs(): ModelCatalogs {
    try {
        const catalogs = ModelCatalogsSchema.parse(JSON.parse(readFileSync(modelCatalogPath(), 'utf8')));
        try {
            if ((catalogs.claude?.source === 'poe') !== !!readPoeSettings()?.enabled) delete catalogs.claude;
        } catch { delete catalogs.claude; } // A broken Claude connector cannot hide Codex's catalog.
        return catalogs;
    }
    catch { return {}; }
}
export function cachedModel(engine: 'claude' | 'codex', model: string | null | undefined) {
    const catalog = readModelCatalogs()[engine];
    const release = runtimeRelease(engine);
    if (release && catalog?.runtimeVersion !== release.version) return undefined;
    return findCatalogModel(catalog, model);
}

/** Adapt an implicit default only. Explicit user choices are validated separately. */
export function cachedDefaultEffort(engine: 'claude' | 'codex', model: string | undefined, preferred: string): string | undefined {
    const entry = cachedModel(engine, model);
    if (!entry?.efforts) return preferred;
    if (entry.efforts.includes(preferred)) return preferred;
    return entry.defaultEffort && entry.efforts.includes(entry.defaultEffort) ? entry.defaultEffort : entry.efforts[0];
}
