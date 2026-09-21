import { z } from 'zod';

export const ResourceSearchRequestSchema = z.object({
    query: z.string().trim().min(1).max(200),
    scope: z.enum(['all', 'turn', 'unseen']).default('all'),
    extension: z.string().max(80).nullable().optional(),
    // Explicit file links from loaded transcript messages supplement the journal.
    paths: z.array(z.string().min(1).max(4096)).max(2000).default([]),
    offset: z.number().int().min(0).max(1000000).default(0),
    snapshot: z.string().max(64).optional(),
});
export type ResourceSearchRequest = z.input<typeof ResourceSearchRequestSchema>;
export type ResourceSearchScope = 'all' | 'turn' | 'unseen';
export type ResourceSearchSkipReason = 'unreadable' | 'unsupported' | 'tooLarge' | 'noText' | 'timeout' | 'sensitive' | 'changed';
export type ResourceSearchSnippet = { text: string; line?: number; page?: number; paragraph?: number };
export type ResourceSearchMatch = { path: string; nameMatch: boolean; snippets: ResourceSearchSnippet[] };
export type ResourceSearchSkipped = { path: string; reason: ResourceSearchSkipReason };
export type ResourceSearchResponse = {
    success: true;
    matches: ResourceSearchMatch[];
    skipped: ResourceSearchSkipped[];
    total: number;
    scanned: number;
    nextOffset: number | null;
    snapshot: string;
} | { success: false; error: 'invalid' | 'busy' | 'changed' | 'unavailable' };

/** null means every format; an empty extension means a dotfile/extensionless file. */
export function resourceExtension(path: string): string {
    const name = path.replace(/\\/g, '/').split('/').pop() ?? '';
    const dot = name.lastIndexOf('.');
    return dot <= 0 || dot === name.length - 1 ? '' : name.slice(dot + 1).toLowerCase();
}

export function resourcePathMatches(path: string, query: string): boolean {
    return path.replace(/\\/g, '/').toLowerCase().includes(query.trim().replace(/\\/g, '/').toLowerCase());
}
