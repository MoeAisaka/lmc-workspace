import { describe, expect, it, vi } from 'vitest';
// The module reaches the translation layer through Modal, and i18n reads stored
// settings when it loads.
vi.mock('@/sync/persistence', () => ({ loadSettings: () => ({ settings: {} }) }));
import { attachmentSizeLimit, MAX_ATTACHMENT_FILE_SIZE, MAX_FILE_SIZE } from '@/sync/attachmentTypes';

describe('attachmentSizeLimit', () => {
    it('caps an image at the model-input limit whichever way it arrived', () => {
        expect(attachmentSizeLimit('image/png')).toBe(MAX_FILE_SIZE);
        expect(attachmentSizeLimit('image/jpeg')).toBe(MAX_FILE_SIZE);
    });

    it('lets anything else run to the delivery limit', () => {
        expect(attachmentSizeLimit('application/zip')).toBe(MAX_ATTACHMENT_FILE_SIZE);
        expect(attachmentSizeLimit('text/csv')).toBe(MAX_ATTACHMENT_FILE_SIZE);
    });

    it('treats an unstated type as a file, not an image', () => {
        expect(attachmentSizeLimit(null)).toBe(MAX_ATTACHMENT_FILE_SIZE);
        expect(attachmentSizeLimit(undefined)).toBe(MAX_ATTACHMENT_FILE_SIZE);
        expect(attachmentSizeLimit('')).toBe(MAX_ATTACHMENT_FILE_SIZE);
    });
});
