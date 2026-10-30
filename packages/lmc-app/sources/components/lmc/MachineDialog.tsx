import React from 'react';
import { Modal } from '@/modal';
import MachineDetailScreen from '@/app/(app)/machine/[id]';
import { UtilityDialog } from './UtilityDialog';
export function MachineDialog({ machineId, onClose }: { machineId: string; onClose?: () => void }) {
    return <UtilityDialog title="设备详情" onClose={onClose} testID="machine-dialog"><MachineDetailScreen machineId={machineId} onClose={onClose} /></UtilityDialog>;
}
export function openMachineDetails(machineId: string) { Modal.show({ component: MachineDialog, props: { machineId }, blurBackdrop: true }); }
