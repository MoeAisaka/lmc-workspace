import React from 'react';
import { Modal } from '@/modal';
import ChangelogScreen from '@/app/(app)/changelog';
import { t } from '@/text';
import { UtilityDialog } from './UtilityDialog';
export function ChangelogDialog({ onClose }: { onClose?: () => void }) {
    return <UtilityDialog title={t('lmc.dialogs.changelog')} onClose={onClose} testID="changelog-dialog"><ChangelogScreen /></UtilityDialog>;
}
export function openChangelog() { Modal.show({ component: ChangelogDialog, props: {}, blurBackdrop: true }); }
