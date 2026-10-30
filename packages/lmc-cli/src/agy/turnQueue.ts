import type { EngineModelCatalog } from 'lmc-wire';
import { MessageQueue2 } from '@/utils/MessageQueue2';
import { normalizeRemotePermissionMode } from '@/claude/utils/permissionMode';
import type { PermissionMode } from '@/api/types';
import { resolveAgySelection } from './modelSelection';

export type AgyTurnMode = { model: string; effort?: string; permissionMode: PermissionMode };

/** Keep the settings at send time, even when a later prompt changes them. */
export function resolveAgyTurnMode(meta: { model?: string | null; effort?: string | null; permissionMode?: string } | undefined,
    current: AgyTurnMode, catalog?: EngineModelCatalog): AgyTurnMode {
    const selection = meta && ('model' in meta || 'effort' in meta)
        ? resolveAgySelection('model' in meta ? meta.model : current.model,
            'effort' in meta ? meta.effort : 'model' in meta ? undefined : current.effort, catalog)
        : { model: current.model, effort: current.effort };
    return { ...selection, permissionMode: normalizeRemotePermissionMode(meta?.permissionMode) ?? current.permissionMode };
}

export function createAgyTurnQueue() {
    return new MessageQueue2<AgyTurnMode>(mode => JSON.stringify([mode.model, mode.effort, mode.permissionMode]));
}
