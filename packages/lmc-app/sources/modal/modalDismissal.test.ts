import { describe, expect, it } from 'vitest';
import type { ModalConfig } from './types';
import { isModalDismissible } from './modalDismissal';

const EmptyModal = () => null;

describe('isModalDismissible', () => {
    it('keeps an explicitly locked custom modal open', () => {
        const modal: ModalConfig = {
            id: 'crop',
            type: 'custom',
            component: EmptyModal,
            dismissible: false,
        };

        expect(isModalDismissible(modal)).toBe(false);
    });

    it('allows default custom and built-in modals to close', () => {
        const custom: ModalConfig = {
            id: 'custom',
            type: 'custom',
            component: EmptyModal,
        };
        const alert: ModalConfig = {
            id: 'alert',
            type: 'alert',
            title: 'Alert',
        };

        expect(isModalDismissible(custom)).toBe(true);
        expect(isModalDismissible(alert)).toBe(true);
    });
});
