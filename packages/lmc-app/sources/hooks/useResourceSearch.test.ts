// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useResourceSearch } from './useResourceSearch';
import { apiSocket } from '@/sync/apiSocket';
import type { ResourceSearchResponse } from 'lmc-wire';

vi.mock('@/sync/apiSocket', () => ({ apiSocket: { sessionRPC: vi.fn() } }));
describe('resource search lifecycle', () => {
    let host: HTMLDivElement; let root: Root;
    let current: ReturnType<typeof useResourceSearch>;
    function Probe({ query, session = 'a', enabled = true }: { query: string; session?: string; enabled?: boolean }) {
        current = useResourceSearch(session, { query, scope: 'all' }, enabled, 0);
        return null;
    }
    beforeEach(() => { vi.useFakeTimers(); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); host = document.createElement('div'); root = createRoot(host); });
    afterEach(() => { act(() => root.unmount()); vi.useRealTimers(); vi.unstubAllGlobals(); vi.resetAllMocks(); });
    const response = (path: string): ResourceSearchResponse => ({ success: true, matches: [{ path, nameMatch: true, snippets: [] }], skipped: [], scanned: 1, total: 1, nextOffset: null, snapshot: 's' });
    it('debounces typing, hides previous results immediately and ignores late session replies', async () => {
        let resolveOld!: (value: ResourceSearchResponse) => void;
        vi.mocked(apiSocket.sessionRPC).mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve; })).mockResolvedValueOnce(response('new.md'));
        act(() => root.render(React.createElement(Probe, { query: 'old' })));
        await act(async () => { await vi.advanceTimersByTimeAsync(350); });
        act(() => root.render(React.createElement(Probe, { query: 'new', session: 'b' })));
        expect(current!.state).toBeNull();
        await act(async () => { resolveOld(response('old.md')); });
        expect(current!.state).toBeNull();
        await act(async () => { await vi.advanceTimersByTimeAsync(350); });
        expect(current!.state?.matches[0].path).toBe('new.md');
        expect(apiSocket.sessionRPC).toHaveBeenCalledTimes(2);
    });
    it('never sends content-search RPCs to a legacy Agent or a hidden panel', async () => {
        act(() => root.render(React.createElement(Probe, { query: 'anything', enabled: false })));
        await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
        expect(apiSocket.sessionRPC).not.toHaveBeenCalled();
    });
});
