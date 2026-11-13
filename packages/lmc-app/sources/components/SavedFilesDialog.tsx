import React from 'react';
import { View } from 'react-native';
import { InteractionPressable as Pressable } from '@/components/InteractionPressable';
import { useUnistyles } from 'react-native-unistyles';
import { Text } from '@/components/StyledText';
import { Modal } from '@/modal';
import { UtilityDialog } from '@/components/lmc/UtilityDialog';
import { SavedFilesList } from './SavedFilesList';
import { SavedFileDetails } from './SavedFileDetails';
import { t } from '@/text';
export function SavedFilesDialog({ onClose }: { onClose?: () => void }) {
    const [selected, setSelected] = React.useState<string | null>(null);
    const { theme } = useUnistyles();
    return <UtilityDialog title={t('lmc.dialogs.savedFiles')} onClose={onClose} testID="saved-files-dialog">
        <View style={{ flex: 1, display: selected ? 'none' : 'flex' }}><SavedFilesList onOpen={setSelected} /></View>
        {selected && <View style={{ flex: 1, minHeight: 0 }}>
            <Pressable accessibilityRole="button" onPress={() => setSelected(null)} style={{ borderRadius: 8, minHeight: 44, justifyContent: 'center', paddingHorizontal: 20 }}>
                <Text style={{ color: theme.colors.textLink }}>{t('lmc.savedFiles.backToList')}</Text>
            </Pressable>
            <SavedFileDetails key={selected} id={selected} />
        </View>}
    </UtilityDialog>;
}
export function openSavedFiles() {
    Modal.show({ component: SavedFilesDialog, props: {}, blurBackdrop: true });
}
