import * as React from 'react';
import { Platform, Pressable, ScrollView, TextInput, View, useWindowDimensions } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Text } from '@/components/StyledText';
import { Typography } from '@/constants/Typography';
import { Modal } from '@/modal';
import AppearanceSettingsScreen from '@/app/(app)/settings/appearance';
import AgentsSettingsScreen from '@/app/(app)/settings/agents';
import AccountSettings from '@/app/(app)/settings/account';
import { DevicesUpgradePane } from './DevicesUpgradePane';
import { AboutPane } from './AboutPane';
import { lmcColors } from '../lmcColors';
import { lmcElevation, lmcSurfaceBorder } from '../elevation';
import { FlatSettingsContext } from './flatSettings';
import { t } from '@/text';

export type LmcSettingsSection = 'general' | 'devices' | 'agents' | 'account' | 'about';

export const LMC_SETTINGS_SECTIONS: { key: LmcSettingsSection; label: string; icon: keyof typeof Ionicons.glyphMap; keywords: string }[] = [
    { key: 'general', label: t('lmc.settings.general'), icon: 'settings-outline', keywords: t('lmc.settings.generalKeywords') },
    { key: 'devices', label: t('lmc.settings.devices'), icon: 'laptop-outline', keywords: t('lmc.settings.devicesKeywords') },
    { key: 'agents', label: t('lmc.settings.agents'), icon: 'options-outline', keywords: t('lmc.settings.agentsKeywords') },
    { key: 'account', label: t('lmc.settings.account'), icon: 'person-circle-outline', keywords: t('lmc.settings.accountKeywords') },
    { key: 'about', label: t('lmc.settings.about'), icon: 'information-circle-outline', keywords: t('lmc.settings.aboutKeywords') },
];

const styles = StyleSheet.create((theme) => ({
    center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 16 },
    dialog: { flexDirection: 'row', borderRadius: 20, overflow: 'hidden', backgroundColor: theme.colors.surface, ...lmcElevation(theme, 4), ...lmcSurfaceBorder(theme) },
    nav: { width: 220, paddingHorizontal: 10, paddingVertical: 12, gap: 2, backgroundColor: theme.colors.groupped.background, borderRightWidth: StyleSheet.hairlineWidth, borderRightColor: theme.colors.divider },
    close: { width: 36, height: 36, borderRadius: 10, alignItems: 'center', justifyContent: 'center', backgroundColor: theme.colors.surface, borderWidth: 1, borderColor: theme.colors.divider, marginBottom: 10 },
    search: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingLeft: 12, paddingRight: 8, height: 36, borderRadius: 999, backgroundColor: theme.colors.surface, borderWidth: 1, borderColor: theme.colors.divider, marginBottom: 6 },
    searchInput: { flex: 1, minWidth: 0, fontSize: 13, color: theme.colors.text, ...Typography.default(), ...(Platform.OS === 'web' ? ({ outlineStyle: 'none' } as any) : {}) },
    navItem: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 10, paddingVertical: 8, borderRadius: 10 },
    navLabel: { fontSize: 14, color: theme.colors.text, ...Typography.default() },
    pane: { flex: 1, minWidth: 0 },
    paneTitle: { fontSize: 18, color: theme.colors.text, paddingHorizontal: 24, paddingTop: 20, paddingBottom: 12, ...Typography.default('semiBold') },
}));

/**
 * ChatGPT-style settings: a centered dialog with a category rail on the left
 * and the selected category's content on the right. Categories reuse the
 * existing settings screens so behaviour stays identical to the phone pages.
 */
export function LmcSettingsDialog({ section: initial = 'general', onClose }: { section?: LmcSettingsSection; onClose?: () => void }) {
    const { theme } = useUnistyles();
    const colors = lmcColors(theme);
    const { width, height } = useWindowDimensions();
    const [section, setSection] = React.useState<LmcSettingsSection>(initial);
    const [query, setQuery] = React.useState('');
    const q = query.trim().toLowerCase();
    const visible = q ? LMC_SETTINGS_SECTIONS.filter((s) => s.label.toLowerCase().includes(q) || s.keywords.includes(q)) : LMC_SETTINGS_SECTIONS;
    const current = LMC_SETTINGS_SECTIONS.find((s) => s.key === section)!;
    const close = () => onClose?.();

    const pane = section === 'general' ? <AppearanceSettingsScreen />
        : section === 'agents' ? <AgentsSettingsScreen />
        : section === 'account' ? <AccountSettings />
        : section === 'devices' ? <ScrollView><DevicesUpgradePane onNavigate={close} /></ScrollView>
        : <ScrollView><AboutPane onNavigate={close} /></ScrollView>;

    return (
        <View style={styles.center} pointerEvents="box-none">
            <View style={[styles.dialog, { width: Math.min(720, width - 32), height: Math.min(640, height - 48) }]}>
                <View style={styles.nav}>
                    <Pressable accessibilityRole="button" accessibilityLabel={t('lmc.settings.close')} onPress={close} style={({ pressed }) => [styles.close, pressed && { opacity: 0.6 }]}>
                        <Ionicons name="close" size={18} color={theme.colors.text} />
                    </Pressable>
                    <View style={styles.search}>
                        <Ionicons name="search-outline" size={16} color={colors.tertiary} />
                        <TextInput accessibilityLabel={t('lmc.settings.search')} placeholder={t('lmc.settings.search')} placeholderTextColor={colors.tertiary} value={query} onChangeText={setQuery} style={styles.searchInput} />
                    </View>
                    {visible.map((item) => (
                        <Pressable
                            key={item.key}
                            accessibilityRole="button"
                            accessibilityState={{ selected: item.key === section }}
                            onPress={() => setSection(item.key)}
                            style={({ pressed }) => [styles.navItem, item.key === section && { backgroundColor: colors.rowSelected }, pressed && { opacity: 0.7 }]}
                        >
                            <Ionicons name={item.icon} size={18} color={theme.colors.text} />
                            <Text style={styles.navLabel}>{item.label}</Text>
                        </Pressable>
                    ))}
                    {visible.length === 0 && <Text style={[styles.navLabel, { color: colors.tertiary, padding: 10 }]}>{t('lmc.list.noMatches')}</Text>}
                </View>
                <View style={styles.pane}>
                    <Text style={styles.paneTitle}>{current.label}</Text>
                    <FlatSettingsContext.Provider value={true}>
                        <View style={{ flex: 1, minHeight: 0 }}>{pane}</View>
                    </FlatSettingsContext.Provider>
                </View>
            </View>
        </View>
    );
}

export function openLmcSettings(section: LmcSettingsSection = 'general') {
    Modal.show({ component: LmcSettingsDialog, props: { section } });
}
