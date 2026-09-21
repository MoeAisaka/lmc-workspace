import { Worker } from 'node:worker_threads';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { ResourceSearchRequestSchema, resourceExtension, resourcePathMatches, type ResourceSearchResponse, type ResourceSearchScope, type ResourceSearchSnippet, type ResourceSearchSkipReason } from 'lmc-wire';
import { projectPath } from '@/projectPath';
import { resolveResourceFile } from './resourceFiles';

type Extracted = { snippets: ResourceSearchSnippet[]; reason?: never } | { reason: ResourceSearchSkipReason; snippets?: never };
// Bound concurrent parsers across all clients of a session process.
let activeSearches = 0;
export function sensitiveResourcePath(path: string): boolean {
    return /(?:^|[/\\])(?:\.env(?:\..*)?|access\.key|credentials(?:\.json)?|id_rsa|id_ed25519)(?:$|[/\\])|\.(pem|p12|key)$/i.test(path);
}

export function searchResourceBody(path: string, extension: string, query: string, timeoutMs = 5000): Promise<Extracted> {
    return new Promise(resolve => {
        const worker = new Worker(join(projectPath(), 'bin/resource-text-worker.mjs'), {
            workerData: { path, extension, query }, execArgv: [],
            resourceLimits: { maxOldGenerationSizeMb: 256 }, stdout: true, stderr: true,
        });
        // Third-party parser diagnostics must not enter the conversation/logs.
        worker.stdout.resume(); worker.stderr.resume();
        let settled = false;
        const finish = (result: Extracted) => {
            if (settled) return;
            settled = true; clearTimeout(timer);
            void worker.terminate(); resolve(result);
        };
        const timer = setTimeout(() => finish({ reason: 'timeout' }), timeoutMs);
        worker.once('message', result => finish(result));
        worker.once('error', () => finish({ reason: 'unreadable' }));
        worker.once('exit', () => finish({ reason: 'unreadable' }));
    });
}

/** Bounded, resumable scans over session resource paths, never a workspace crawl. */
export async function searchSessionResources(root: string, readPaths: (scope: ResourceSearchScope) => Promise<string[]>, input: unknown): Promise<ResourceSearchResponse> {
    const parsed = ResourceSearchRequestSchema.safeParse(input);
    if (!parsed.success) return { success: false, error: 'invalid' };
    if (activeSearches >= 2) return { success: false, error: 'busy' };
    activeSearches++;
    try {
        const request = parsed.data;
        const paths = [...new Set([...(await readPaths(request.scope)), ...(request.scope === 'all' ? request.paths : [])])];
        const selected = paths.filter(path => request.extension == null || resourceExtension(path) === request.extension.toLowerCase());
        const snapshot = createHash('sha256').update(JSON.stringify([request.scope, request.query, request.extension, selected])).digest('hex');
        if (request.offset > 0 && request.snapshot !== snapshot) return { success: false, error: 'changed' };
        if (request.offset > selected.length) return { success: false, error: 'invalid' };
        const response: Extract<ResourceSearchResponse, { success: true }> = { success: true, matches: [], skipped: [], total: selected.length, scanned: request.offset, nextOffset: null, snapshot };
        // Two files in parallel per batch keep the RPC below its normal timeout.
        const batch = selected.slice(request.offset, request.offset + 4);
        for (let i = 0; i < batch.length; i += 2) {
            await Promise.all(batch.slice(i, i + 2).map(async path => {
                const nameMatch = resourcePathMatches(path, request.query);
                let result: Extracted;
                try {
                    const resolved = await resolveResourceFile(root, path);
                    result = sensitiveResourcePath(path) || sensitiveResourcePath(resolved)
                        ? { reason: 'sensitive' }
                        : await searchResourceBody(resolved, resourceExtension(path), request.query);
                } catch { result = { reason: 'unreadable' }; }
                if (result.reason) response.skipped.push({ path, reason: result.reason });
                if (nameMatch || result.snippets?.length) response.matches.push({ path, nameMatch, snippets: result.snippets ?? [] });
            }));
        }
        response.matches.sort((a, b) => batch.indexOf(a.path) - batch.indexOf(b.path));
        response.scanned += batch.length;
        response.nextOffset = response.scanned < selected.length ? response.scanned : null;
        return response;
    } catch { return { success: false, error: 'unavailable' }; }
    finally { activeSearches--; }
}
