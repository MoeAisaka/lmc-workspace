import React from 'react';
import { View } from 'react-native';
import { Modal } from '@/modal';
import { AllFilesDiffView } from '@/components/AllFilesDiffView';
import { useGitStatusFiles } from '@/hooks/useGitStatusFiles';
import { UtilityDialog } from './UtilityDialog';
import { t } from '@/text';
export function SessionChangesDialog({ sessionId, onClose }: { sessionId: string; onClose?: () => void }) {
    useGitStatusFiles(sessionId);
    const [controls, setControls] = React.useState<React.ReactNode>(null);
    return <UtilityDialog title={t('lmc.dialogs.sessionChanges')} onClose={onClose} maxWidth={1100} testID="session-changes-dialog">
        <View style={{ padding: 12, flexDirection: 'row', justifyContent: 'flex-end' }}>{controls}</View>
        <AllFilesDiffView sessionId={sessionId} onHeaderRightSlotChange={setControls} />
    </UtilityDialog>;
}
export function openSessionChanges(sessionId: string) { Modal.show({ component: SessionChangesDialog, props: { sessionId }, blurBackdrop: true }); }
