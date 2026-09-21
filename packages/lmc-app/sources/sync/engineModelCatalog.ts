import type { Metadata } from './storageTypes';
import type { ModelMode } from '@/components/modelModeOptions';
import { getAvailableModels } from '@/components/modelModeOptions';
import type { SwitchableEngine } from './engineSwitch';

export type EngineModelGroup = {
    engine: SwitchableEngine;
    /** The engine's own name, as the transcript and the handoff spell it. */
    label: string;
    /** True for the engine actually running the session. */
    current: boolean;
    models: ModelMode[];
};

export const ENGINE_NAMES: Record<SwitchableEngine, string> = { claude: 'Claude Code', codex: 'Codex' };

/**
 * Every model a session could be answered by, grouped by the engine that would
 * run it.
 *
 * Picking a model is how a session changes engine, so the list has to show both
 * engines at once. The device discovers both catalogs, with compatibility
 * tables retained for older Agents and unavailable discovery.
 *
 * Returns null for anything that is not a plain Claude or Codex session. Rig,
 * Gemini and the rest have one engine for life, and offering to switch them
 * would offer something no runner implements.
 */
export function engineModelGroups(
    flavor: string | null | undefined,
    metadata: Metadata | null | undefined,
    translate: (key: any) => string,
    selectedKey?: string | null,
): EngineModelGroup[] | null {
    if (flavor !== 'claude' && flavor !== 'codex') return null;
    const other: SwitchableEngine = flavor === 'claude' ? 'codex' : 'claude';
    const groups: EngineModelGroup[] = [
        {
            engine: flavor,
            label: ENGINE_NAMES[flavor],
            current: true,
            models: getAvailableModels(flavor, metadata, translate, selectedKey),
        },
        {
            engine: other,
            label: ENGINE_NAMES[other],
            current: false,
            models: getAvailableModels(other, { ...metadata, models: undefined } as Metadata, translate),
        },
    ];
    return groups.every((group) => group.models.length > 0) ? groups : null;
}

/** The engine that would run a given model key, or null when no group claims it. */
export function engineForModelKey(groups: EngineModelGroup[], key: string): SwitchableEngine | null {
    for (const group of groups) {
        if (group.models.some((model) => model.key === key)) return group.engine;
    }
    return null;
}
