import React from 'react';
import { Modal } from '@/modal';
import UsageSettingsScreen from '@/app/(app)/settings/usage';
import { UtilityDialog } from './UtilityDialog';
import { t } from '@/text';
export function UsageDialog({ onClose }: { onClose?: () => void }) {
    return <UtilityDialog title={t('lmc.dialogs.usage')} onClose={onClose} maxWidth={1200} testID="usage-dialog"><UsageSettingsScreen onClose={onClose} /></UtilityDialog>;
}
export function openUsage() { Modal.show({ component: UsageDialog, props: {}, blurBackdrop: true }); }
