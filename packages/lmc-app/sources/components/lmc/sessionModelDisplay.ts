import { withModelCatalogs } from '@/sync/modelCatalogMetadata';
import type { MachineMetadata } from '@/sync/storageTypes';
import type { Session } from '@/sync/storageTypes';
import type { AgentDefaultOverrides } from '@/sync/agentDefaults';
import { resolveAgentDefaultConfig } from '@/sync/agentDefaults';
import { getAvailableModels, getEffortLevelsForModel, getCatalogDefaultEffort, preserveCodexEffortSelection, resolveCurrentOption } from '@/components/modelModeOptions';

/** Display the same configured selection as the composer, even before a pick
 * has been saved. This is a read-only projection, not a runtime model report. */
export function resolveSessionModelDisplay(
    session: Session,
    overrides: AgentDefaultOverrides | null | undefined,
    translate: Parameters<typeof getAvailableModels>[2],
    machine?: MachineMetadata | null,
): { modelName: string | null; effortName: string | null } {
    session = { ...session, metadata: withModelCatalogs(session.metadata, machine) ?? session.metadata };
    const flavor = session.metadata?.flavor;
    if (flavor !== 'claude' && flavor !== 'codex') return { modelName: null, effortName: null };
    const defaults = resolveAgentDefaultConfig(overrides, flavor, session.metadata?.version);
    const selectedModel = session.modelMode ?? session.metadata?.modelMode;
    const models = getAvailableModels(flavor, session.metadata, translate, selectedModel ?? defaults.modelMode);
    const model = resolveCurrentOption(models, [selectedModel, defaults.modelMode, session.metadata?.currentModelCode]);
    const selectedEffort = session.effortLevel ?? session.metadata?.effortLevel;
    const efforts = getEffortLevelsForModel(flavor, model?.key ?? 'default', session.metadata, translate);
    const defaultEffort = getCatalogDefaultEffort(flavor, model?.key, session.metadata, defaults.effortLevel);
    const effort = preserveCodexEffortSelection(flavor, selectedEffort ?? defaultEffort,
        resolveCurrentOption(efforts, [selectedEffort, defaultEffort]));
    return { modelName: model?.name ?? null, effortName: effort?.name ?? null };
}
