import * as z from 'zod';
import type { EngineModelCatalog, ModelCatalogs } from 'lmc-wire';
import { compareVersionsWithPrerelease, isWellFormedVersion } from '@/utils/versionUtils';

export const agentKeys = ['claude', 'codex', 'gemini', 'openclaw', 'agy'] as const;
export type AgentKey = typeof agentKeys[number];

export const AgentDefaultOverrideSchema = z.object({
    permissionMode: z.string().optional(),
    modelMode: z.string().optional(),
    effortLevel: z.string().optional(),
}).passthrough();

export const AgentDefaultOverridesSchema = z.object({
    claude: AgentDefaultOverrideSchema.optional(),
    codex: AgentDefaultOverrideSchema.optional(),
    gemini: AgentDefaultOverrideSchema.optional(),
    openclaw: AgentDefaultOverrideSchema.optional(),
    agy: AgentDefaultOverrideSchema.optional(),
}).passthrough().default({});

export type AgentDefaultOverride = z.infer<typeof AgentDefaultOverrideSchema>;
export type AgentDefaultOverrides = z.infer<typeof AgentDefaultOverridesSchema>;
export type AgentDefaultField = keyof Pick<AgentDefaultOverride, 'permissionMode' | 'modelMode' | 'effortLevel'>;

export type AgentDefaultConfig = {
    permissionMode: string;
    modelMode: string;
    effortLevel: string | null;
};

const codeAgentDefaults: Record<AgentKey, AgentDefaultConfig> = {
    // Auto is the reviewed everyday mode for both shipped code agents. The
    // old CLI fallback is applied only when a machine version is known below;
    // a user override is kept separate and is never rewritten here.
    // The model named here is only the fallback for a device that publishes no
    // catalog. A device that does publish one decides its own default below, so
    // a new engine release moves the default without an app release.
    claude: { permissionMode: 'auto', modelMode: 'claude-opus-5-5', effortLevel: 'medium' },
    codex: { permissionMode: 'auto', modelMode: 'gpt-6.1-sol', effortLevel: 'medium' },
    gemini: { permissionMode: 'default', modelMode: 'gemini-2.5-pro', effortLevel: null },
    openclaw: { permissionMode: 'default', modelMode: 'default', effortLevel: null },
    agy: { permissionMode: 'default', modelMode: 'Gemini 3.1 Pro (High)', effortLevel: null },
};

// `auto` first shipped in happy-cli 1.2.1-beta.2, for Claude and Codex alike.
// Keep this with the code-default resolver so every spawn/send consumer uses
// the same compatibility boundary as the picker catalog.
export const CLI_VERSION_WITH_AUTO = '1.2.1-beta.2';

function resolveCodeDefaultPermissionMode(
    permissionMode: string,
    cliVersion: string | null | undefined,
): string {
    if (permissionMode !== 'auto' || !cliVersion) {
        return permissionMode;
    }
    if (!isWellFormedVersion(cliVersion)) {
        return 'default';
    }
    return compareVersionsWithPrerelease(cliVersion, CLI_VERSION_WITH_AUTO) >= 0
        ? permissionMode
        : 'default';
}

export function normalizeAgentKey(flavor: string | null | undefined): AgentKey {
    if (flavor === 'codex' || flavor === 'gemini' || flavor === 'openclaw' || flavor === 'agy') {
        return flavor;
    }
    return 'claude';
}

/** The model an engine's own catalog marks as its default, if it says. */
export function catalogDefaultModelKey(catalog: EngineModelCatalog | null | undefined): string | null {
    const models = catalog?.models ?? [];
    return (models.find(model => model.isDefault)
        ?? models.find(model => model.id === 'default' || model.aliases?.includes('default')))?.id ?? null;
}

export function getCodeAgentDefaults(
    flavor: string | null | undefined,
    cliVersion?: string | null,
    catalogs?: ModelCatalogs | null,
): AgentDefaultConfig {
    const key = normalizeAgentKey(flavor);
    const defaults = codeAgentDefaults[key];
    const permissionMode = resolveCodeDefaultPermissionMode(defaults.permissionMode, cliVersion);
    // An older engine may not know the fallback model at all; its catalog's
    // own default is the one it can certainly run.
    const modelMode = (key === 'claude' || key === 'codex' ? catalogDefaultModelKey(catalogs?.[key]) : null) ?? defaults.modelMode;
    return permissionMode === defaults.permissionMode && modelMode === defaults.modelMode
        ? defaults
        : { ...defaults, permissionMode, modelMode };
}

/**
 * Permission keys that were offered once and are no longer accepted, mapped to
 * what they meant. `dontAsk` never passed the CLI's message schema, so it was
 * already dropped on the wire; it is retired here so a saved copy cannot make
 * the composer show one mode while sending another.
 */
const RETIRED_PERMISSION_MODES: Record<string, string> = {
    dontAsk: 'acceptEdits',
};

/**
 * Maps a stored permission mode onto one the CLI still accepts. Applies to
 * flavor-based agents only: a harness that publishes its own catalog owns its
 * codes, and none of them collide with a retired Claude key.
 */
export function retirePermissionMode<T extends string | null | undefined>(mode: T): T | string {
    return mode ? RETIRED_PERMISSION_MODES[mode] ?? mode : mode;
}

export function getAgentDefaultOverride(
    overrides: AgentDefaultOverrides | null | undefined,
    flavor: string | null | undefined,
): AgentDefaultOverride {
    const override = overrides?.[normalizeAgentKey(flavor)] ?? {};
    const permissionMode = retirePermissionMode(override.permissionMode);
    return permissionMode === override.permissionMode
        ? override
        : { ...override, permissionMode };
}

export function resolveAgentDefaultConfig(
    overrides: AgentDefaultOverrides | null | undefined,
    flavor: string | null | undefined,
    cliVersion?: string | null,
    catalogs?: ModelCatalogs | null,
): AgentDefaultConfig {
    const codeDefaults = getCodeAgentDefaults(flavor, cliVersion, catalogs);
    const userOverride = getAgentDefaultOverride(overrides, flavor);
    return {
        permissionMode: userOverride.permissionMode ?? codeDefaults.permissionMode,
        modelMode: userOverride.modelMode ?? codeDefaults.modelMode,
        effortLevel: userOverride.effortLevel ?? codeDefaults.effortLevel,
    };
}

export function hasAgentDefaultOverride(
    overrides: AgentDefaultOverrides | null | undefined,
    flavor: string | null | undefined,
    field: AgentDefaultField,
): boolean {
    return getAgentDefaultOverride(overrides, flavor)[field] !== undefined;
}

export function getAgentDefaultOverrideValue(
    overrides: AgentDefaultOverrides | null | undefined,
    flavor: string | null | undefined,
    field: AgentDefaultField,
): string | undefined {
    return getAgentDefaultOverride(overrides, flavor)[field];
}

export function setAgentDefaultOverride(
    overrides: AgentDefaultOverrides | null | undefined,
    flavor: string | null | undefined,
    field: AgentDefaultField,
    value: string | null | undefined,
): AgentDefaultOverrides {
    const key = normalizeAgentKey(flavor);
    const next: AgentDefaultOverrides = { ...(overrides ?? {}) };
    const current: AgentDefaultOverride = { ...(next[key] ?? {}) };

    if (value === null || value === undefined) {
        delete current[field];
    } else {
        current[field] = value;
    }

    if (current.permissionMode === undefined && current.modelMode === undefined && current.effortLevel === undefined) {
        delete next[key];
    } else {
        next[key] = current;
    }

    return next;
}
