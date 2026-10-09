import type { EngineModelCatalog, ModelCatalogs } from 'lmc-wire';
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

// Claude's managed runtime reports its SDK package version (0.3.N), which
// bundles CLI 2.1.N; a system install reports the CLI version itself.
function runtimeRank(engine: 'claude' | 'codex', version: string): number[] {
    const parts = version.split('.').map(part => Number.parseInt(part, 10) || 0);
    return engine === 'claude' && parts[0] === 0 ? [2, 1, parts[2] ?? 0] : parts;
}

/**
 * Account-wide settings have no single device. Use the catalog of the newest
 * engine: every device re-captures on its own clock, so "most recent capture"
 * would let a device pinned to an old engine replace the current model list.
 */
export function newestModelCatalogs(machines: Array<MachineMetadata | null | undefined>): ModelCatalogs {
    const pick = (engine: 'claude' | 'codex'): EngineModelCatalog | undefined => machines
        .map(machine => machine?.modelDiscovery ? machine.modelCatalogs?.[engine] : undefined)
        .filter((catalog): catalog is EngineModelCatalog => !!catalog?.models.length)
        .sort((a, b) => {
            const left = runtimeRank(engine, a.runtimeVersion), right = runtimeRank(engine, b.runtimeVersion);
            for (let i = 0; i < Math.max(left.length, right.length); i++) {
                if ((left[i] ?? 0) !== (right[i] ?? 0)) return (right[i] ?? 0) - (left[i] ?? 0);
            }
            return b.capturedAt - a.capturedAt;
        })[0];
    return { claude: pick('claude'), codex: pick('codex') };
}
