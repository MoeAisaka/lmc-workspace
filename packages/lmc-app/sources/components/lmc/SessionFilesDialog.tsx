import React from 'react';
import { View, Pressable } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { Text } from '@/components/StyledText';
import { Modal } from '@/modal';
import FilesScreen from '@/app/(app)/session/[id]/files';
import { FileViewPanel } from '@/components/FileViewPanel';
import { UtilityDialog } from './UtilityDialog';
import { t } from '@/text';
export function SessionFilesDialog({ sessionId, onClose }: { sessionId: string; onClose?: () => void }) {
    const [path, setPath] = React.useState<string | null>(null);
    const [controls, setControls] = React.useState<React.ReactNode>(null);
    const { theme } = useUnistyles();
    return <UtilityDialog title={t('lmc.dialogs.projectFiles')} onClose={onClose} maxWidth={1100} testID="session-files-dialog">
        <View style={{ flex: 1, display: path ? 'none' : 'flex' }}><FilesScreen sessionId={sessionId} onOpen={setPath} /></View>
        {path && <View style={{ flex: 1, minHeight: 0 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 12 }}>
                <Pressable accessibilityRole="button" style={{ minHeight: 44, justifyContent: 'center' }} onPress={() => setPath(null)}><Text style={{ color: theme.colors.textLink }}>{t('lmc.dialogs.backToFiles')}</Text></Pressable>
                {controls}
            </View>
            <FileViewPanel key={path} sessionId={sessionId} filePath={path} onHeaderRightSlotChange={setControls} />
        </View>}
    </UtilityDialog>;
}
export function openSessionFiles(sessionId: string) { Modal.show({ component: SessionFilesDialog, props: { sessionId }, blurBackdrop: true }); }
