import { beforeEach, describe, expect, it } from 'vitest';
import { checkWebRelease, parseReleaseMarker, RELEASE_SNOOZE_MS, shouldShowReleaseNotice, useWebRelease } from './webRelease';

const V1 = 'lmc-redesign-20260908-v305', V2 = 'lmc-redesign-20260908-v306', V3 = 'lmc-redesign-20260908-v307';
const page = (marker: string) => `<!doctype html><html><head><meta charset="utf-8"><meta name="lmc-release" content="${marker}" /><title>LMC</title></head></html>`;
beforeEach(() => useWebRelease.setState({ loaded: V1, deployed: null, snoozed: null, checkedAt: 0 }));

describe('new web version notice', () => {
    it('reads the release marker whatever the attribute order, and nothing from a page without one', () => {
        expect(parseReleaseMarker(page(V2))).toBe(V2);
        expect(parseReleaseMarker(`<meta content="${V2}" name='lmc-release'>`)).toBe(V2);
        expect(parseReleaseMarker('<html><head><meta name="viewport" content="width=device-width"></head></html>')).toBeNull();
    });
    it('shows only when the server has a different release than the page loaded', () => {
        const base = { snoozed: null, now: 0 };
        expect(shouldShowReleaseNotice({ ...base, loaded: V1, deployed: V2 })).toBe(true);
        expect(shouldShowReleaseNotice({ ...base, loaded: V1, deployed: V1 })).toBe(false);
        expect(shouldShowReleaseNotice({ ...base, loaded: V1, deployed: null })).toBe(false);
        expect(shouldShowReleaseNotice({ ...base, loaded: null, deployed: V2 })).toBe(false);
    });
    it('stays put off for an hour for that release, and returns for a newer one', () => {
        const snoozed = { release: V2, at: 1000 };
        expect(shouldShowReleaseNotice({ loaded: V1, deployed: V2, snoozed, now: 1000 + RELEASE_SNOOZE_MS - 1 })).toBe(false);
        expect(shouldShowReleaseNotice({ loaded: V1, deployed: V2, snoozed, now: 1000 + RELEASE_SNOOZE_MS })).toBe(true);
        expect(shouldShowReleaseNotice({ loaded: V1, deployed: V3, snoozed, now: 1001 })).toBe(true);
    });
    it('asks the server without the cache and records what it finds', async () => {
        const calls: Array<[string, unknown]> = [];
        await checkWebRelease(async (url, init) => { calls.push([url, init]); return { ok: true, text: async () => page(V2) }; }, () => 42);
        expect(calls).toEqual([['/?lmc-release-check=42', { cache: 'no-store', credentials: 'omit' }]]);
        expect(useWebRelease.getState()).toMatchObject({ deployed: V2, checkedAt: 42 });
    });
    it('keeps the last known release through a failed or unreadable check', async () => {
        useWebRelease.setState({ deployed: V2 });
        await checkWebRelease(async () => { throw new Error('offline'); }, () => 50);
        expect(useWebRelease.getState()).toMatchObject({ deployed: V2, checkedAt: 50 });
        await checkWebRelease(async () => ({ ok: false, text: async () => '' }), () => 60);
        await checkWebRelease(async () => ({ ok: true, text: async () => '<html></html>' }), () => 70);
        expect(useWebRelease.getState()).toMatchObject({ deployed: V2, checkedAt: 70 });
    });
    it('puts off the release that is showing', () => {
        useWebRelease.setState({ deployed: V2 });
        useWebRelease.getState().snooze(5);
        expect(useWebRelease.getState().snoozed).toEqual({ release: V2, at: 5 });
    });
});
