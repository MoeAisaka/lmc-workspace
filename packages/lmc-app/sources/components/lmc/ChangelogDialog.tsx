import React from 'react';
import { Modal } from '@/modal';
import ChangelogScreen from '@/app/(app)/changelog';
import { UtilityDialog } from './UtilityDialog';
export function ChangelogDialog({ onClose }: { onClose?: () => void }) {
    return <UtilityDialog title="更新日志" onClose={onClose} testID="changelog-dialog"><ChangelogScreen /></UtilityDialog>;
}
export function openChangelog() { Modal.show({ component: ChangelogDialog, props: {}, blurBackdrop: true }); }
