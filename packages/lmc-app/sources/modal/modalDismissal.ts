import type { ModalConfig } from './types';

/** Whether an implicit close request may dismiss this modal. */
export function isModalDismissible(modal: ModalConfig): boolean {
    return modal.type !== 'custom' || modal.dismissible !== false;
}
