import * as React from 'react';
import type { ResourceSearchRequest, ResourceSearchResponse } from 'lmc-wire';
import { apiSocket } from '@/sync/apiSocket';
import { runResourceSearch, type ResourceSearchProgress } from '@/sync/resourceSearch';

type SearchState = ResourceSearchProgress & { key: string; error: string | null };

export function useResourceSearch(sessionId: string, request: ResourceSearchRequest, enabled: boolean, revision: number) {
    const [retry, setRetry] = React.useState(0);
    const key = JSON.stringify([sessionId, request, enabled, revision, retry]);
    const [state, setState] = React.useState<SearchState | null>(null);
    React.useEffect(() => {
        if (!enabled || !request.query.trim()) return;
        const controller = new AbortController();
        const timer = setTimeout(() => {
            void runResourceSearch(request,
                data => apiSocket.sessionRPC<ResourceSearchResponse, ResourceSearchRequest>(sessionId, 'resource-search', data),
                progress => setState({ ...progress, key, error: null }), controller.signal,
            ).catch(error => {
                if (!controller.signal.aborted) setState(old => ({
                    ...(old?.key === key ? old : { matches: [], skipped: [], scanned: 0, total: 0, complete: false }),
                    key, error: error instanceof Error ? error.message : 'unavailable',
                }));
            });
        }, 350);
        return () => { clearTimeout(timer); controller.abort(); };
        // The key includes the full request by value, avoiding scans on every render.
    }, [key]);
    return { state: state?.key === key ? state : null, retry: () => setRetry(value => value + 1) };
}
