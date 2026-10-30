import { afterEach, describe, expect, it, vi } from 'vitest';
import { currentSavedFileId, savedFileIdFromLink } from './savedFileLink';
const id = '11111111-1111-4111-8111-111111111110';
const origin = 'https://lmc.example:8443';
afterEach(() => { vi.unstubAllGlobals(); });
describe('private saved file link routing', () => {
    it('recognizes same-host private links across public and preview ports and relative links', () => {
        for (const link of ['/saved-files/' + id, 'https://lmc.example/saved-files/' + id, origin + '/saved-files/' + id + '?from=chat']) {
            expect(savedFileIdFromLink(link, origin)).toBe(id);
        }
    });
    it('does not hijack third-party, public sharing, malformed, or credential-bearing links', () => {
        for (const link of ['https://evil.example/saved-files/' + id, 'https://lmc.example.evil.test/saved-files/' + id,
            '/file-shares/' + id, '/saved-files/../settings', '/saved-files/not-an-id',
            'javascript:alert(1)', 'https://user@lmc.example/saved-files/' + id]) {
            expect(savedFileIdFromLink(link, origin)).toBeNull();
        }
    });
    it('resolves saved-file IDs against window origin, configured serverUrl, and relative paths without matching third-party hosts', () => {
        expect(currentSavedFileId('/saved-files/' + id)).toBe(id);
        expect(currentSavedFileId('//evil.example/saved-files/' + id)).toBeNull();
        expect(currentSavedFileId('https://lmc.example:8443/saved-files/' + id)).toBeNull();
        vi.stubGlobal('window', { location: { origin: 'http://127.0.0.1:4193' } });
        vi.stubGlobal('__HAPPY_CONFIG__', { serverUrl: origin });
        expect(currentSavedFileId(origin + '/saved-files/' + id)).toBe(id);
        expect(currentSavedFileId('https://evil.example/saved-files/' + id)).toBeNull();
    });
});
