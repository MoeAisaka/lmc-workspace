import { findCatalogModel, type EngineModelCatalog } from 'lmc-wire';
import { defaultAgyModelEffort } from './modelDiscovery';

/** Effort is part of the native model ID; never invent a suffixed ID. */
export function resolveAgySelection(model: string | null | undefined, effort: string | null | undefined, catalog?: EngineModelCatalog) {
    if (!model || model === 'default') {
        if (effort) throw new Error('Select an Antigravity model before setting its effort.');
        return { model: 'default', effort: undefined as string | undefined };
    }
    const entry = findCatalogModel(catalog, model);
    if (!entry) throw new Error(`Antigravity model is not in this machine’s native catalog: ${model}`);
    const nativeEffort = Object.entries(entry.effortModels ?? {}).find(([, id]) => id === model)?.[0];
    const selected = effort || nativeEffort || defaultAgyModelEffort(entry);
    if (entry.effortModels) {
        const native = selected && entry.effortModels[selected];
        if (!native) throw new Error(`Antigravity does not advertise effort ${selected ?? '(default)'} for ${entry.id}.`);
        return { model: native, effort: selected };
    }
    if (effort) throw new Error(`Antigravity does not advertise effort variants for ${entry.id}.`);
    return { model: entry.id, effort: undefined as string | undefined };
}
