import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import type { DiscoveredModel, EngineModelCatalog } from 'lmc-wire';
import { findAgyBin } from './constants';
const execute = promisify(execFile);

export function isGemini4ModelId(id: string | null | undefined): boolean {
    return typeof id === 'string' && /^gemini-4(?:-|$|\.)/i.test(id);
}

export function defaultAgyModelEffort(
    model: { id: string; efforts?: readonly string[]; defaultEffort?: string } | undefined,
): string | undefined {
    if (!model) return undefined;
    if (isGemini4ModelId(model.id) && model.efforts?.includes('high')) return 'high';
    return model.defaultEffort && (!model.efforts || model.efforts.includes(model.defaultEffort))
        ? model.defaultEffort
        : model.efforts?.[0];
}

/** Native models output only. Effort variants are grouped without inventing combinations. */
export function parseAgyModels(output: string): DiscoveredModel[] {
    const models = new Map<string, DiscoveredModel>();
    for (const line of output.split(/\r?\n/)) {
        const [id, name] = line.split('\t').map(s => s.trim());
        if (!id || !name || !/^[a-z0-9][a-z0-9._-]{0,255}$/i.test(id)) continue;
        const match = name.match(/^(.*) \((Low|Medium|High|XHigh|Max)\)$/i);
        const effort = match?.[2].toLowerCase();
        const variant = effort && id.endsWith(`-${effort}`);
        const key = variant ? id.slice(0, -effort!.length - 1) : id;
        const previous = models.get(key);
        if (variant) {
            const efforts = [...(previous?.efforts ?? []), effort!];
            const firstEffort = previous?.defaultEffort ?? effort!;
            models.set(key, { id: key, name: match![1], efforts,
                defaultEffort: isGemini4ModelId(key) && efforts.includes('high') ? 'high' : firstEffort,
                effortModels: { ...previous?.effortModels, [effort!]: id },
                aliases: [...(previous?.aliases ?? []), id] });
        } else models.set(key, { id, name, efforts: [] });
    }
    if (!models.size || models.size > 256) throw new Error('Antigravity model catalog unavailable');
    return [...models.values()];
}

export async function discoverAgyModels(): Promise<EngineModelCatalog> {
    const binary = findAgyBin();
    if (!binary) throw new Error('Antigravity CLI not installed');
    const options = { cwd: tmpdir(), timeout: 20_000, maxBuffer: 256 * 1024, windowsHide: true, encoding: 'utf8' as const };
    const { stdout } = await execute(binary, ['models'], options);
    const version = (await execute(binary, ['--version'], options)).stdout.trim();
    return { models: parseAgyModels(stdout), runtimeVersion: version, capturedAt: Date.now(), stale: false, source: 'native' };
}
