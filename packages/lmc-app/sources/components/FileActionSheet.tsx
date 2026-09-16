import React from 'react';
import { View, Text, Pressable, ScrollView } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';

export type FileAction = {
    key: string;
    title: string;
    subtitle?: string;
    icon: keyof typeof Ionicons.glyphMap;
    destructive?: boolean;
    /** Present the reason instead of the action; the row stays visible but inert. */
    disabledReason?: string;
    onPress?: () => void;
};

/**
 * Alert buttons collapse into one cramped row once there are more than three,
 * and every label loses its explanation. File delivery has four destinations
 * whose difference (which device receives the file) is the whole decision.
 */
export function FileActionSheet({ name, path, note, actions, onClose }: {
    name: string;
    path: string;
    note?: string;
    actions: FileAction[];
    onClose?: () => void;
}) {
    const { theme } = useUnistyles();
    return (
        <View style={{ width: 460, maxWidth: '100%', backgroundColor: theme.colors.surface, borderRadius: 20, overflow: 'hidden' }}>
            <View style={{ paddingHorizontal: 20, paddingTop: 20, paddingBottom: 14, gap: 4 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                    <Ionicons name="document-text-outline" size={22} color={theme.colors.textLink} />
                    <Text numberOfLines={1} style={{ flex: 1, minWidth: 0, fontSize: 17, fontWeight: '600', color: theme.colors.text }}>{name}</Text>
                </View>
                <Text numberOfLines={2} style={{ fontSize: 12, lineHeight: 17, color: theme.colors.textSecondary }}>{path}</Text>
                {!!note && <Text style={{ fontSize: 12, lineHeight: 17, paddingTop: 6, color: theme.colors.textSecondary }}>{note}</Text>}
            </View>
            <ScrollView style={{ maxHeight: 360 }} contentContainerStyle={{ paddingBottom: 4 }}>
                {actions.map(action => {
                    const blocked = !!action.disabledReason;
                    return (
                        <Pressable
                            key={action.key}
                            accessibilityRole="button"
                            accessibilityLabel={action.title}
                            accessibilityState={{ disabled: blocked }}
                            disabled={blocked}
                            onPress={() => { onClose?.(); action.onPress?.(); }}
                            style={({ pressed }) => ({
                                flexDirection: 'row', alignItems: 'center', gap: 14,
                                paddingHorizontal: 20, paddingVertical: 14,
                                borderTopWidth: 1, borderColor: theme.colors.divider,
                                opacity: blocked ? 0.45 : 1,
                                backgroundColor: pressed ? theme.colors.surfacePressed : 'transparent',
                            })}
                        >
                            <Ionicons name={action.icon} size={20} color={action.destructive ? theme.colors.textDestructive : theme.colors.textLink} />
                            <View style={{ flex: 1, minWidth: 0 }}>
                                <Text style={{ fontSize: 15, color: action.destructive ? theme.colors.textDestructive : theme.colors.text }}>{action.title}</Text>
                                {!!(action.disabledReason || action.subtitle) && (
                                    <Text style={{ fontSize: 12, lineHeight: 17, paddingTop: 2, color: theme.colors.textSecondary }}>{action.disabledReason || action.subtitle}</Text>
                                )}
                            </View>
                            {!blocked && <Ionicons name="chevron-forward" size={16} color={theme.colors.textSecondary} />}
                        </Pressable>
                    );
                })}
            </ScrollView>
            <Pressable
                accessibilityRole="button"
                onPress={onClose}
                style={({ pressed }) => ({ padding: 15, borderTopWidth: 1, borderColor: theme.colors.divider, backgroundColor: pressed ? theme.colors.surfacePressed : 'transparent' })}
            >
                <Text style={{ textAlign: 'center', fontSize: 15, color: theme.colors.textSecondary }}>取消</Text>
            </Pressable>
        </View>
    );
}
