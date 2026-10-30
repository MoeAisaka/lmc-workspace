import { describe, it, expect } from 'vitest';
import { fileDeliveryResult } from './fileDelivery';
import type { FilePublication } from './filePublications';

const ready: FilePublication = { id: 'job', state: 'ready', bytes: 20, total: 20, file: { id: 'file id', name: '报告.md', size: 20, mimeType: 'text/markdown' } };

describe('file delivery result', () => {
    it('provides an account-authenticated link on the configured origin and base path', () => {
        const result = fileDeliveryResult(ready, 'https://files.example.test:8443/lmc');
        expect(result.file).toMatchObject({ id: 'file id', url: 'https://files.example.test:8443/lmc/saved-files/file%20id' });
        expect(ready.file).not.toHaveProperty('url');
    });
    it.each(['https://user:password@example.test', 'https://example.test/?token=private', 'https://example.test/#key', 'file:///tmp'])('does not leak endpoint credentials or build a non-web link: %s', endpoint => {
        expect(() => fileDeliveryResult(ready, endpoint)).toThrow('Invalid LMC web application URL');
    });
    it.each(['uploading', 'failed'] as const)('does not produce a delivery link for %s', state => {
        const value = { id: 'job', state, bytes: 0, total: 20 };
        expect(fileDeliveryResult(value, 'https://example.test')).toEqual(value);
    });
});
