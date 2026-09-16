/**
 * A hub setting how its worker runs: model, effort (thinking depth) and
 * permission mode.
 *
 * A hub sends `[config …]` mail or directives in a task's `run` field. The
 * worker records them with a strict metadata write. Runtime subscribers
 * apply accepted changes without injecting an acknowledgement model turn.
 * Metadata is desired configuration, not a provider readback.
 */
import type { ApiSessionClient } from '@/api/apiSession';
import type { Metadata } from '@/api/types';
import { resolveWorkerPermissionMode } from './workerPermission';
import { isRemoteCodexPermissionMode } from '@/codex/executionPolicy';
import { isPermissionMode } from '@/claude/utils/permissionMode';

export interface WorkerConfig {
    model?: string;
    effort?: string;
    permissionMode?: string;
    workerDefault?: boolean;
}

/** Observe accepted configuration without injecting a model/user turn. */
export function watchSessionConfiguration(
    session: Pick<ApiSessionClient, 'on' | 'off' | 'getMetadata' | 'sendSessionEvent'> & Partial<Pick<ApiSessionClient, 'requestHubDecision'>>,
    engine: 'claude' | 'codex',
    apply: (metadata: Pick<Metadata, 'modelMode' | 'effortLevel' | 'permissionMode'>) => void | Promise<void>,
): () => void {
    const keys = ['modelMode', 'effortLevel', 'permissionMode'] as const;
    let previous: Pick<Metadata, typeof keys[number]> | undefined;
    let previousWorker = false;
    let previousBinding: string | undefined;
    let revision = 0;
    let stopped = false;
    const fieldRevision = new Map<string, number>();
    const changed = (metadata: Metadata | null) => {
        if (!metadata || (metadata.flavor && metadata.flavor !== engine)) return;
        metadata = { ...metadata, permissionMode: resolveWorkerPermissionMode(metadata, engine) };
        if (metadata.permissionMode === undefined && previous?.permissionMode !== undefined) {
            metadata.permissionMode = engine === 'codex' ? 'auto' : 'default';
        }
        const entries: Array<[typeof keys[number], string | null | undefined]> = keys
            .filter(key => metadata[key] !== previous?.[key]).map(key => [key, metadata[key]]);
        const worker = metadata.orchestration?.role === 'worker' ? metadata.orchestration.hub : undefined;
        const binding = JSON.stringify([worker?.sessionId, worker?.boundAt, worker?.autonomy, metadata.permissionModeSource]);
        if (previousBinding !== binding && (previousWorker || worker?.autonomy === true) && !entries.some(([key]) => key === 'permissionMode')) {
            entries.push(['permissionMode', metadata.permissionMode ?? (engine === 'codex' ? 'auto' : 'default')]);
        }
        previousWorker = worker?.autonomy === true;
        previousBinding = binding;
        const before = { ...previous };
        previous = Object.fromEntries(keys.map(key => [key, metadata[key]]));
        if (entries.length === 0) return;
        const applyingRevision = ++revision;
        for (const [key] of entries) fieldRevision.set(key, applyingRevision);
        const patch = Object.fromEntries(entries);
        const failed = () => {
            if (stopped) return;
            const failedEntries = entries.filter(([key]) => fieldRevision.get(key) === applyingRevision);
            if (failedEntries.length === 0) return;
            // Retry a failed field on the next accepted metadata event, without
            // replaying unrelated old model picks or spinning in a retry loop.
            for (const [key] of failedEntries) if (previous) previous[key as typeof keys[number]] = before[key as typeof keys[number]];
            session.sendSessionEvent({ type: 'message', message: '[configuration] Settings could not be applied to the active engine. No model turn was started; retry the configuration after resolving the engine error.' });
            const failedPatch = Object.fromEntries(failedEntries);
            void session.requestHubDecision?.('configuration:' + JSON.stringify(failedPatch), 'runtime configuration failure', failedPatch);
        };
        try { void Promise.resolve(apply(patch)).catch(failed); } catch { failed(); }
    };
    session.on('metadata', changed);
    changed(session.getMetadata()); // Covers mail received before the runner finished starting.
    return () => { stopped = true; session.off('metadata', changed); };
}

const HEAD = /^\s*\[config(?:\s+for\s+[A-Za-z0-9]+)?\]\s*$/im;
const TOKEN = /\b(model|effort|permission(?:_mode|Mode)?)(?:\s*[=:]\s*|\s{2,})([A-Za-z0-9._\-\[\]]+)/g;

/** `model=claude-opus-5 effort=high permission=bypassPermissions` anywhere in a text. */
export function configDirectives(text: string | undefined): WorkerConfig {
    const out: WorkerConfig = {};
    if (!text) return out;
    if (/\bworker_default=full\b/.test(text)) out.workerDefault = true;
    for (const m of text.matchAll(TOKEN)) {
        const key = m[1].toLowerCase();
        if (key === 'model') out.model = m[2];
        else if (key === 'effort') out.effort = m[2];
        else out.permissionMode = m[2];
    }
    return out;
}

export function isConfigMail(text: string): boolean {
    return HEAD.test(text.split('\n').slice(0, 3).join('\n'));
}

export function formatConfigMail(workerId: string, config: WorkerConfig): string {
    const lines = [`[config for ${workerId}]`];
    if (config.model) lines.push(`model       ${config.model}`);
    if (config.effort) lines.push(`effort      ${config.effort}`);
    if (config.permissionMode) lines.push(`permission  ${config.permissionMode}`);
    if (config.workerDefault) lines.push('worker_default=full');
    lines.push('Configuration notice only. The runner applies these settings; do not acknowledge, report again, or start a task.');
    return lines.join('\n');
}

export function hasConfig(config: WorkerConfig): boolean {
    return !!(config.model || config.effort || config.permissionMode || config.workerDefault);
}

/** The message meta the runner attaches on delivery, and the metadata picks it records. */
export function configAsMeta(config: WorkerConfig): { model?: string; effort?: string; permissionMode?: string } {
    return { ...(config.model ? { model: config.model } : {}), ...(config.effort ? { effort: config.effort } : {}), ...(config.permissionMode ? { permissionMode: config.permissionMode } : {}) };
}
export function configAsMetadata(config: WorkerConfig): { modelMode?: string; effortLevel?: string; permissionMode?: string } {
    return { ...(config.model ? { modelMode: config.model } : {}), ...(config.effort ? { effortLevel: config.effort } : {}), ...(config.permissionMode ? { permissionMode: config.permissionMode } : {}) };
}

/** Called inside a strict metadata updater, after checking the current hub relation. */
export function applyWorkerConfig(metadata: Metadata, config: WorkerConfig): Metadata {
    const o = metadata.orchestration;
    const permissionMode = config.permissionMode && resolveWorkerPermissionMode({ ...metadata, permissionMode: config.permissionMode, permissionModeSource: 'explicit' }, metadata.flavor ?? 'claude');
    if (config.permissionMode && !(metadata.flavor === 'codex' ? isRemoteCodexPermissionMode(permissionMode) : (metadata.flavor === 'claude' || !metadata.flavor) && isPermissionMode(permissionMode ?? undefined))) {
        throw new Error('This permission mode is not supported by the worker’s current engine.');
    }
    return {
        ...metadata, ...configAsMetadata(config),
        ...(config.permissionMode ? { permissionMode, permissionModeSource: 'explicit' as const } : {}),
        ...(config.workerDefault && o?.role === 'worker' ? { orchestration: { ...o, hub: { ...o.hub, autonomy: true } } } : {}),
    };
}
