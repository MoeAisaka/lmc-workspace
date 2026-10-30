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

export const ENGINE_NAMES: Record<SwitchableEngine, string> = { claude: 'Claude Code', codex: 'Codex', agy: 'Antigravity' };

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
    if (flavor !== 'claude' && flavor !== 'codex' && flavor !== 'agy') return null;
    if (flavor === 'agy' && !metadata?.sessionCapabilities?.engineHandoff) return null;
    const engines: SwitchableEngine[] = ['claude', 'codex'];
    if (metadata?.sessionCapabilities?.engineHandoff && metadata.modelCatalogs?.agy?.models.length) engines.push('agy');
    if (!engines.includes(flavor)) engines.unshift(flavor);
    return ([flavor, ...engines.filter(engine => engine !== flavor)] as SwitchableEngine[]).map(engine => ({
        engine, label: ENGINE_NAMES[engine], current: engine === flavor,
        models: getAvailableModels(engine, engine === flavor ? metadata : { ...metadata, models: undefined } as Metadata, translate, engine === flavor ? selectedKey : undefined),
    })).filter(group => group.models.length > 0);

}

/** The engine that would run a given model key, or null when no group claims it. */
export function engineForModelKey(groups: EngineModelGroup[], key: string): SwitchableEngine | null {
    for (const group of groups) {
        if (group.models.some((model) => model.key === key || model.aliases?.includes(key))) return group.engine;
    }
    return null;
}
