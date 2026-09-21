import type { Metadata, MachineMetadata } from './storageTypes';

export function withModelCatalogs(metadata: Metadata | null | undefined, machine?: MachineMetadata | null): Metadata | undefined {
    if (!metadata) return undefined;
    if (!metadata.sessionCapabilities?.modelDiscovery) return metadata;
    const catalogs = { ...metadata.modelCatalogs, ...machine?.modelCatalogs };
    const engine = metadata.flavor;
    if (engine === 'claude' || engine === 'codex') {
        const runtime = metadata.engineRuntime;
        if (runtime && catalogs[engine]?.runtimeVersion !== (runtime.packageVersion ?? runtime.version)) {
            const snapshot = metadata.modelCatalogs?.[engine];
            catalogs[engine] = snapshot?.runtimeVersion === (runtime.packageVersion ?? runtime.version) ? snapshot : undefined;
        }
    }
    return { ...metadata, modelCatalogs: catalogs };
}

/** Creation has no session snapshot yet; capabilities come from the target device. */
export function machineModelMetadata(machine: MachineMetadata | null | undefined): Metadata {
    return { path: '', host: '', modelCatalogs: machine?.modelDiscovery ? machine.modelCatalogs : undefined };
}
