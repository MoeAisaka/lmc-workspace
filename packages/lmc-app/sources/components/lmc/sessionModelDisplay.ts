import { withModelCatalogs } from '@/sync/modelCatalogMetadata';
import { findCatalogModel } from 'lmc-wire';
import { isRigMetadataV1 } from '@/sync/rig';
import type { MachineMetadata } from '@/sync/storageTypes';
import type { Session } from '@/sync/storageTypes';
import type { AgentDefaultOverrides } from '@/sync/agentDefaults';
import { resolveAgentDefaultConfig } from '@/sync/agentDefaults';
import { getAvailableModels, getEffortLevelsForModel, getCatalogDefaultEffort, preserveCodexEffortSelection, resolveCurrentOption, supportsModelFastMode } from '@/components/modelModeOptions';

/** Display the same configured selection as the composer, even before a pick
 * has been saved. This is a read-only projection, not a runtime model report. */
export function resolveSessionModelDisplay(
    session: Session,
    overrides: AgentDefaultOverrides | null | undefined,
    translate: Parameters<typeof getAvailableModels>[2],
    machine?: MachineMetadata | null,
): { modelName: string | null; effortName: string | null; fastMode: boolean } {
    session = { ...session, metadata: withModelCatalogs(session.metadata, machine) ?? session.metadata };
    const flavor = session.metadata?.flavor;
    if (flavor !== 'claude' && flavor !== 'codex' && flavor !== 'agy') return { modelName: null, effortName: null, fastMode: false };
    const defaults = resolveAgentDefaultConfig(overrides, flavor, session.metadata?.version, session.metadata?.modelCatalogs);
    const selectedModel = session.modelMode ?? session.metadata?.modelMode;
    // Native Antigravity IDs include the effort variant. Use the published
    // mapping, not suffix guessing, to show its family name and exact effort.
    const agyModel = flavor === 'agy' ? findCatalogModel(session.metadata?.modelCatalogs?.agy, selectedModel) : undefined;
    const modelKey = agyModel?.id ?? selectedModel;
    const nativeEffort = agyModel?.effortModels
        ? Object.entries(agyModel.effortModels).find(([, id]) => id === selectedModel)?.[0]
        : undefined;
    const models = getAvailableModels(flavor, session.metadata, translate, modelKey ?? defaults.modelMode);
    const model = resolveCurrentOption(models, [modelKey, defaults.modelMode, session.metadata?.currentModelCode]);
    const selectedEffort = session.effortLevel ?? session.metadata?.effortLevel ?? nativeEffort;
    const efforts = getEffortLevelsForModel(flavor, model?.key ?? 'default', session.metadata, translate);
    const defaultEffort = getCatalogDefaultEffort(flavor, model?.key, session.metadata, defaults.effortLevel);
    const effort = preserveCodexEffortSelection(flavor, selectedEffort ?? defaultEffort,
        resolveCurrentOption(efforts, [selectedEffort, defaultEffort]));
    const fastPick = session.fastMode !== undefined ? session.fastMode : session.metadata?.fastMode;
    const fastMode = fastPick === true && !isRigMetadataV1(session.metadata)
        && supportsModelFastMode(flavor, model?.key, session.metadata);
    return { modelName: model?.name ?? null, effortName: effort?.name ?? null, fastMode };
}
