import React from 'react';
import { View, Pressable } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { Text } from '@/components/StyledText';
import { Modal } from '@/modal';
import { UtilityDialog } from '@/components/lmc/UtilityDialog';
import { SavedFilesList } from './SavedFilesList';
import { SavedFileDetails } from './SavedFileDetails';
export function SavedFilesDialog({ onClose }: { onClose?: () => void }) {
    const [selected, setSelected] = React.useState<string | null>(null);
    const { theme } = useUnistyles();
    return <UtilityDialog title="已保存文件" onClose={onClose} testID="saved-files-dialog">
        <View style={{ flex: 1, display: selected ? 'none' : 'flex' }}><SavedFilesList onOpen={setSelected} /></View>
        {selected && <View style={{ flex: 1, minHeight: 0 }}>
            <Pressable accessibilityRole="button" onPress={() => setSelected(null)} style={{ minHeight: 44, justifyContent: 'center', paddingHorizontal: 20 }}>
                <Text style={{ color: theme.colors.textLink }}>返回文件列表</Text>
            </Pressable>
            <SavedFileDetails key={selected} id={selected} />
        </View>}
    </UtilityDialog>;
}
export function openSavedFiles() {
    Modal.show({ component: SavedFilesDialog, props: {}, blurBackdrop: true });
}
