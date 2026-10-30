import React from 'react';
import { Pressable, View } from 'react-native';
import { Text } from '@/components/StyledText';
import { Ionicons } from '@expo/vector-icons';
import { openSavedFile } from '@/components/SavedFileDialog';
import { fileSize } from '@/utils/fileSize';
import { useUnistyles } from 'react-native-unistyles';
import { FileIcon } from '@/components/FileIcon';

export { fileSize } from '@/utils/fileSize';
export function SavedFileCard({ id, name, size, onOpen }: { id: string; name: string; size: number; onOpen?: (id: string) => void }) {
    const { theme } = useUnistyles();
    const extension = name.match(/\.([a-z0-9]{1,10})$/i)?.[1].toUpperCase();

    return (
        <Pressable
            accessibilityRole="button"
            accessibilityLabel={'打开已保存文件：' + name}
            accessibilityHint="查看文件预览和下载操作"
            onPress={() => (onOpen ?? openSavedFile)(id)}
            style={({ pressed }) => ({
                width: '100%', maxWidth: 520, alignSelf: 'flex-start',
                padding: 14, marginVertical: 4, borderRadius: 12, borderWidth: 1,
                borderColor: theme.colors.divider, backgroundColor: theme.colors.surface,
                flexDirection: 'row', alignItems: 'center', gap: 12,
                opacity: pressed ? 0.72 : 1,
            })}
        >
            <View style={{ width: 42, height: 46, flexShrink: 0, borderRadius: 8, backgroundColor: theme.colors.surfaceHigh, alignItems: 'center', justifyContent: 'center' }}>
                <FileIcon fileName={name} size={28} />
            </View>
            <View style={{ flex: 1, minWidth: 0 }}>
                <Text numberOfLines={2} style={{ color: theme.colors.text, fontSize: 14, lineHeight: 20, fontWeight: '500' }}>{name}</Text>
                <Text style={{ marginTop: 4, fontSize: 12, lineHeight: 16, color: theme.colors.textSecondary }}>
                    {extension || '文件'} · {fileSize(size)}
                </Text>
            </View>
            <Ionicons name="chevron-forward" size={16} color={theme.colors.textSecondary} />
        </Pressable>
    );
}

