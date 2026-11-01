import { discoverAgyModels } from '@/agy/modelDiscovery';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { DiscoveredModelSchema, type DiscoveredModel, type ModelCatalogs } from 'lmc-wire';
import { CodexAppServerClient } from '@/codex/codexAppServerClient';
import { codexExecutable, runtimeRelease, runtimeVersion, sdkRequire, type Engine } from './managedRuntime';
import { modelCatalogPath, readModelCatalogs } from './modelCatalogCache';
import { fetchPoeJson, readPoeSettings } from './poe';

/** Poe lists community bots too; only Anthropic models advertising Messages are eligible. */
export function normalizePoeModels(raw: unknown): DiscoveredModel[] {
    const data = (raw as { data?: unknown } | null)?.data;
    if (!Array.isArray(data)) throw new Error('Invalid Poe model catalog');
    return data.flatMap(row => {
        if (row?.owned_by !== 'Anthropic' || !Array.isArray(row.supported_endpoints) || !row.supported_endpoints.includes('/v1/messages')) return [];
        const effort = Array.isArray(row.parameters) ? row.parameters.find((p: any) => p?.name === 'effort' || p?.name === 'output_effort') : undefined;
        const levels = Array.isArray(effort?.schema?.enum) ? effort.schema.enum.filter((s: string) => ['low', 'medium', 'high', 'xhigh', 'max'].includes(s)) : undefined;
        const parsed = DiscoveredModelSchema.safeParse({ id: row.id, name: row.metadata?.display_name ?? row.id,
            efforts: levels, defaultEffort: levels?.includes(effort?.default_value) ? effort.default_value : undefined, supportsFastMode: false });
        return parsed.success ? [parsed.data] : [];
    }).slice(0, 256);
}

export function normalizeModels(engine: Engine, rows: unknown[]): DiscoveredModel[] {
    const models = new Map<string, DiscoveredModel>();
    for (const value of rows) {
        const row = value as any;
        if (!row || typeof row !== 'object') continue;
        const id = engine === 'claude' ? row.resolvedModel ?? row.value : row.model ?? row.id;
        const efforts = engine === 'claude'
            ? row.supportsEffort === false ? [] : row.supportedEffortLevels
            : Array.isArray(row.supportedReasoningEfforts) ? row.supportedReasoningEfforts.map((entry: any) => entry?.reasoningEffort) : undefined;
        const supportsFastMode = engine === 'claude'
            ? (typeof row.supportsFastMode === 'boolean' ? row.supportsFastMode : undefined)
            : ((Array.isArray(row.additionalSpeedTiers) && row.additionalSpeedTiers.includes('fast'))
                || (Array.isArray(row.serviceTiers) && row.serviceTiers.some((tier: any) => tier?.id === 'priority' || tier?.id === 'fast' || /^fast$/i.test(String(tier?.name ?? ''))))
                || undefined);
        const parsed = DiscoveredModelSchema.safeParse({
            id, name: row.displayName ?? id, description: row.description,
            aliases: engine === 'claude' && row.value !== id ? [row.value] : undefined,
            efforts, defaultEffort: row.defaultReasoningEffort, supportsFastMode, isDefault: row.isDefault,
        });
        if (!parsed.success) continue;
        const previous = models.get(parsed.data.id);
        models.set(parsed.data.id, { ...parsed.data,
            ...(previous?.supportsFastMode !== undefined && parsed.data.supportsFastMode === undefined ? { supportsFastMode: previous.supportsFastMode } : {}),
            aliases: [...new Set([...(previous?.aliases ?? []), ...(parsed.data.aliases ?? [])])],
        });
    }
    if (models.size > 256) throw new Error('Model catalog too large');
    return [...models.values()];
}

/** Metadata requests only: no user prompt, model inference, resume or tools. */
export async function discoverModels(engine: Engine): Promise<DiscoveredModel[]> {
    if (engine === 'claude') {
        const poe = readPoeSettings();
        if (poe?.enabled) return normalizePoeModels(await fetchPoeJson('/v1/models', poe.apiKey));
    }
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

export function startModelDiscovery(
    publish: (catalogs: ModelCatalogs) => Promise<void>,
    activeClaudeSessions: () => readonly string[] = () => [],
) {
    let catalogs = readModelCatalogs();
    let stopped = false;
    let running = false;
    let lastCodexAttempt = 0;
    let lastAgyAttempt = 0;
    let codexSelection = '';
    let knownClaudeSessions = new Set<string>();
    let lastPoeEnabled = false;
    // Serialize initial cache publication with fresh results: a retried stale
    // metadata write must never land after the fresh catalog.
    const cachedPublication = publish(catalogs).catch(() => {});
    const refresh = async () => {
        if (stopped || running) return;
        running = true;
        try {
            // Only live session generations create Claude demand. Historical
            // sessions, an installed runtime, and an open but unchanged session
            // must never keep launching the SDK on the background timer.
            const claudeSessions = new Set(activeClaudeSessions());
            const engines: (Engine | 'agy')[] = [];
            if (Date.now() - lastAgyAttempt >= 15 * 60_000) {
                engines.push('agy'); lastAgyAttempt = Date.now();
            }
            let poeEnabled = false, poeInvalid = false;
            try { poeEnabled = !!readPoeSettings()?.enabled; } catch { poeInvalid = true; }
            if (!poeInvalid && ([...claudeSessions].some(id => !knownClaudeSessions.has(id)) || (poeEnabled && !lastPoeEnabled))) engines.push('claude');
            if ((poeInvalid || (catalogs.claude?.source === 'poe') !== poeEnabled) && catalogs.claude) {
                catalogs = { ...catalogs, claude: undefined };
                await cachedPublication;
                await publish(catalogs);
            }
            lastPoeEnabled = poeEnabled;
            knownClaudeSessions = claudeSessions;
            const nextCodexSelection = JSON.stringify(runtimeRelease('codex', true));
            if (nextCodexSelection !== codexSelection || Date.now() - lastCodexAttempt >= 15 * 60_000) {
                engines.push('codex');
                codexSelection = nextCodexSelection;
                lastCodexAttempt = Date.now();
            }
            if (!engines.length) return;
            const results = await Promise.allSettled(engines.map(async engine => {
                if (engine === 'agy') return { engine, catalog: await discoverAgyModels() };
                const selected = JSON.stringify(runtimeRelease(engine, true));
                const runtime = await runtimeVersion(engine, true);
                const models = await discoverModels(engine);
                if (selected !== JSON.stringify(runtimeRelease(engine, true))) throw new Error('Runtime changed during discovery');
                if (engine === 'claude' && poeEnabled !== !!readPoeSettings()?.enabled) throw new Error('Provider changed during discovery');
                if (!models.length) throw new Error('Empty model catalog');
                return { engine, catalog: { models, capturedAt: Date.now(), runtimeVersion: runtime.packageVersion ?? runtime.version, stale: false,
                    source: engine === 'claude' && poeEnabled ? 'poe' as const : 'native' as const } };
            }));
            for (let i = 0; i < results.length; i++) {
                const result = results[i];
                const engine = engines[i];
                if (result.status === 'fulfilled') catalogs = { ...catalogs, [engine]: result.value.catalog };
                else if (engine === 'agy') catalogs = { ...catalogs, agy: undefined };
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
