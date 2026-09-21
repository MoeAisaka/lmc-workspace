import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { DiscoveredModelSchema, type DiscoveredModel, type ModelCatalogs } from 'lmc-wire';
import { CodexAppServerClient } from '@/codex/codexAppServerClient';
import { codexExecutable, readRuntimeSelection, runtimeRelease, runtimeVersion, sdkRequire, type Engine } from './managedRuntime';
import { modelCatalogPath, readModelCatalogs } from './modelCatalogCache';

export function normalizeModels(engine: Engine, rows: unknown[]): DiscoveredModel[] {
    const models = new Map<string, DiscoveredModel>();
    for (const value of rows) {
        const row = value as any;
        if (!row || typeof row !== 'object') continue;
        const id = engine === 'claude' ? row.resolvedModel ?? row.value : row.model ?? row.id;
        const efforts = engine === 'claude'
            ? row.supportsEffort === false ? [] : row.supportedEffortLevels
            : Array.isArray(row.supportedReasoningEfforts) ? row.supportedReasoningEfforts.map((entry: any) => entry?.reasoningEffort) : undefined;
        const parsed = DiscoveredModelSchema.safeParse({
            id, name: row.displayName ?? id, description: row.description,
            aliases: engine === 'claude' && row.value !== id ? [row.value] : undefined,
            efforts, defaultEffort: row.defaultReasoningEffort, isDefault: row.isDefault,
        });
        if (!parsed.success) continue;
        const previous = models.get(parsed.data.id);
        models.set(parsed.data.id, { ...parsed.data,
            aliases: [...new Set([...(previous?.aliases ?? []), ...(parsed.data.aliases ?? [])])],
        });
    }
    if (models.size > 256) throw new Error('Model catalog too large');
    return [...models.values()];
}

/** Metadata requests only: no user prompt, model inference, resume or tools. */
export async function discoverModels(engine: Engine): Promise<DiscoveredModel[]> {
    if (engine === 'codex') {
        const client = new CodexAppServerClient(undefined, undefined, undefined, codexExecutable(runtimeRelease('codex', true) ?? null));
        try { await client.connect(); return normalizeModels(engine, await client.listModels()); }
        finally { await client.disconnect(); }
    }
    const sdk = sdkRequire(runtimeRelease('claude', true) ?? null)('@anthropic-ai/claude-agent-sdk');
    const abortController = new AbortController();
    async function* prompt(): AsyncGenerator<any> {
        await new Promise<void>(resolve => {
            if (abortController.signal.aborted) resolve();
            else abortController.signal.addEventListener('abort', () => resolve(), { once: true });
        });
    }
    const query = sdk.query({ prompt: prompt(), options: { cwd: tmpdir(), abortController, persistSession: false } });
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
        timeout = setTimeout(() => { abortController.abort(); reject(new Error('Model discovery timed out')); }, 20_000);
        timeout.unref();
    });
    try {
        if (typeof query.supportedModels !== 'function') throw new Error('Model discovery unavailable');
        return normalizeModels(engine, await Promise.race([query.supportedModels(), deadline]));
    } finally { clearTimeout(timeout); abortController.abort(); query.close(); }
}

export function startModelDiscovery(publish: (catalogs: ModelCatalogs) => Promise<void>) {
    let catalogs = readModelCatalogs();
    let stopped = false;
    let running = false;
    let lastAttempt = 0;
    let selection = '';
    // Serialize initial cache publication with fresh results: a retried stale
    // metadata write must never land after the fresh catalog.
    const cachedPublication = publish(catalogs).catch(() => {});
    const refresh = async () => {
        if (stopped || running) return;
        running = true;
        try {
            const nextSelection = JSON.stringify(readRuntimeSelection());
            if (nextSelection === selection && Date.now() - lastAttempt < 15 * 60_000) return;
            selection = nextSelection;
            lastAttempt = Date.now();
            const results = await Promise.allSettled((['claude', 'codex'] as const).map(async engine => {
                const selected = JSON.stringify(runtimeRelease(engine, true));
                const runtime = await runtimeVersion(engine, true);
                const models = await discoverModels(engine);
                if (selected !== JSON.stringify(runtimeRelease(engine, true))) throw new Error('Runtime changed during discovery');
                if (!models.length) throw new Error('Empty model catalog');
                return { engine, catalog: { models, capturedAt: Date.now(), runtimeVersion: runtime.packageVersion ?? runtime.version, stale: false } };
            }));
            for (let i = 0; i < results.length; i++) {
                const result = results[i];
                const engine = (['claude', 'codex'] as const)[i];
                if (result.status === 'fulfilled') catalogs = { ...catalogs, [engine]: result.value.catalog };
                else if (catalogs[engine]) catalogs = { ...catalogs, [engine]: { ...catalogs[engine]!, stale: true } };
            }
            if (stopped) return;
            const file = modelCatalogPath();
            const pending = `${file}.${randomUUID()}.tmp`;
            await mkdir(dirname(file), { recursive: true });
            await writeFile(pending, JSON.stringify(catalogs), { mode: 0o600 });
            await rename(pending, file);
            await cachedPublication;
            if (!stopped) await publish(catalogs);
        } finally { running = false; }
    };
    const tick = () => { void refresh().catch(() => { /* Retain the last successful catalog. */ }); };
    tick();
    const timer = setInterval(tick, 60_000);
    timer.unref();
    return () => { stopped = true; clearInterval(timer); };
}
