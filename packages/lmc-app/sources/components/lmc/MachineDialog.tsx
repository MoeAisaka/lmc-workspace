import React from 'react';
import { Modal } from '@/modal';
import MachineDetailScreen from '@/app/(app)/machine/[id]';
import { t } from '@/text';
import { UtilityDialog } from './UtilityDialog';
export function MachineDialog({ machineId, onClose }: { machineId: string; onClose?: () => void }) {
    return <UtilityDialog title={t('lmc.dialogs.machineDetails')} onClose={onClose} testID="machine-dialog"><MachineDetailScreen machineId={machineId} onClose={onClose} /></UtilityDialog>;
}
export function openMachineDetails(machineId: string) { Modal.show({ component: MachineDialog, props: { machineId }, blurBackdrop: true }); }
