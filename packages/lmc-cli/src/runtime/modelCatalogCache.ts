import { runtimeRelease } from './managedRuntime';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ModelCatalogsSchema, findCatalogModel, type ModelCatalogs } from 'lmc-wire';
import { configuration } from '@/configuration';

export const modelCatalogPath = () => join(configuration.lmcHomeDir, 'model-catalogs.json');
export function readModelCatalogs(): ModelCatalogs {
    try { return ModelCatalogsSchema.parse(JSON.parse(readFileSync(modelCatalogPath(), 'utf8'))); }
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
