import * as React from 'react';
import { Keyboard, Platform, Pressable, ScrollView, TextInput, View, useWindowDimensions } from 'react-native';
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
import { useSafeAreaInsets } from 'react-native-safe-area-context';

export type LmcSettingsSection = 'general' | 'devices' | 'agents' | 'account' | 'about';

export const LMC_SETTINGS_SECTIONS: { key: LmcSettingsSection; label: string; icon: keyof typeof Ionicons.glyphMap; keywords: string }[] = [
    { key: 'general', label: t('lmc.settings.general'), icon: 'settings-outline', keywords: t('lmc.settings.generalKeywords') },
    { key: 'devices', label: t('lmc.settings.devices'), icon: 'laptop-outline', keywords: t('lmc.settings.devicesKeywords') },
    { key: 'agents', label: t('lmc.settings.agents'), icon: 'options-outline', keywords: t('lmc.settings.agentsKeywords') },
    { key: 'account', label: t('lmc.settings.account'), icon: 'person-circle-outline', keywords: t('lmc.settings.accountKeywords') },
    { key: 'about', label: t('lmc.settings.about'), icon: 'information-circle-outline', keywords: t('lmc.settings.aboutKeywords') },
];

const styles = StyleSheet.create((theme) => ({
    dialog: { borderRadius: 16, overflow: 'hidden', backgroundColor: theme.colors.surface, ...lmcElevation(theme, 3), ...lmcSurfaceBorder(theme) },
    header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingLeft: 20, paddingRight: 10, minHeight: 56, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.colors.divider },
    title: { fontSize: 20, lineHeight: 28, color: theme.colors.text, ...Typography.default('semiBold') },
    close: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
    search: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 12, height: 36, borderRadius: 20, borderWidth: 1, borderColor: theme.colors.divider, marginHorizontal: 16, marginTop: 12, marginBottom: 10 },
    searchInput: { flex: 1, minWidth: 0, height: '100%', fontSize: 16, color: theme.colors.text, ...Typography.default(), ...(Platform.OS === 'web' ? ({ outlineStyle: 'none' } as any) : {}) },
    nav: { flexGrow: 0, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.colors.divider },
    navContent: { gap: 4, paddingHorizontal: 12, paddingBottom: 8 },
    navItem: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, minHeight: 44, borderRadius: 12 },
    navLabel: { fontSize: 15, lineHeight: 22, color: theme.colors.text, ...Typography.default() },
    pane: { flex: 1, minWidth: 0, minHeight: 0 },
    paneTitle: { fontSize: 18, lineHeight: 26, color: theme.colors.text, paddingHorizontal: 20, paddingTop: 16, paddingBottom: 10, ...Typography.default('semiBold') },
    results: { paddingHorizontal: 20, paddingBottom: 20 },
    result: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 16, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.colors.divider },
    resultHint: { fontSize: 13, lineHeight: 20, color: theme.colors.textSecondary, marginTop: 4, ...Typography.default() },
}));

/**
 * One settings surface on phones and desktop. Only the content pane scrolls
 * vertically; search, categories and the close action remain in reach.
 */
export function LmcSettingsDialog({ section: initial = 'general', onClose }: { section?: LmcSettingsSection; onClose?: () => void }) {
    const { theme } = useUnistyles();
    const colors = lmcColors(theme);
    const { width, height } = useWindowDimensions();
    const insets = useSafeAreaInsets();
    const [section, setSection] = React.useState<LmcSettingsSection>(initial);
    const [query, setQuery] = React.useState('');
    const nav = React.useRef<ScrollView>(null);
    const tabPositions = React.useRef<Partial<Record<LmcSettingsSection, number>>>({});
    const q = query.trim().toLowerCase();
    // Search the names people see in the panes, as well as category aliases.
    // Results navigate to existing controls instead of mounting every pane
    // (and starting device/account requests) for a search.
    const terms: Record<LmcSettingsSection, string[]> = {
        general: [
            t('settings.appearance'), t('settingsLanguage.currentLanguage'),
            t('settingsAppearance.usageLimitShowRemaining'), t('settingsAppearance.userMessageBubbleColor'),
            t('settingsAppearance.alwaysShowContextSize'), t('settingsFeatures.enterToSend'),
            t('settingsFeatures.commandPalette'), t('settingsAppearance.groupSessionsByEngine'),
            t('settingsAppearance.compactToolCalls'), t('settingsFeatures.fileDiffsSidebar'),
            t('settingsFeatures.groupToolCalls'), t('settingsAppearance.showLineNumbersInToolViews'),
        ],
        devices: [t('lmc.menu.devices')],
        agents: [t('localFeatures.model'), t('localFeatures.effort'), t('localFeatures.permission'), 'Claude Code', 'Codex'],
        account: [t('lmc.profile.name'), t('lmc.profile.changeAvatar'), t('lmc.account.connectDevice'), t('lmc.menu.signOut')],
        about: [t('lmc.about.webVersion'), t('lmc.about.changelog')],
    };
    const visible = LMC_SETTINGS_SECTIONS.filter((s) => [s.label, s.keywords, ...terms[s.key]].some(text => text.toLowerCase().includes(q)));
    const current = LMC_SETTINGS_SECTIONS.find((s) => s.key === section)!;
    const close = () => onClose?.();
    const select = (next: LmcSettingsSection) => { Keyboard.dismiss(); setSection(next); setQuery(''); };
    React.useEffect(() => {
        nav.current?.scrollTo({ x: Math.max(0, (tabPositions.current[section] ?? 0) - 12), animated: false });
    }, [section, width]);
    const availableHeight = Math.max(0, height - insets.top - insets.bottom);
    const tabLabel = (item: typeof current) => item.key === 'devices' ? t('settings.machines')
        : item.key === 'account' ? t('settings.account') : item.label;

    const pane = section === 'general' ? <AppearanceSettingsScreen />
        : section === 'agents' ? <AgentsSettingsScreen onNavigate={close} />
        : section === 'account' ? <AccountSettings onNavigate={close} />
        : section === 'devices' ? <ScrollView><DevicesUpgradePane onNavigate={close} /></ScrollView>
        : <ScrollView><AboutPane onNavigate={close} /></ScrollView>;

    return (
        <View testID="lmc-settings-dialog" style={[styles.dialog, { width: Math.min(820, width - insets.left - insets.right - 24), height: Math.min(720, availableHeight * 0.84) }]}>
            <View style={styles.header}>
                <Text accessibilityRole="header" style={styles.title}>{t('settings.title')}</Text>
                <Pressable accessibilityRole="button" accessibilityLabel={t('lmc.settings.close')} onPress={close} style={({ pressed }) => [styles.close, pressed && { backgroundColor: colors.rowSelected }]}>
                    <Ionicons name="close" size={22} color={theme.colors.text} />
                </Pressable>
            </View>
            <View style={styles.search}>
                <Ionicons name="search-outline" size={20} color={colors.tertiary} />
                <TextInput accessibilityLabel={t('lmc.settings.search')} placeholder={t('lmc.settings.search')} placeholderTextColor={colors.tertiary} value={query} onChangeText={setQuery} autoCorrect={false} autoCapitalize="none" style={styles.searchInput} />
            </View>
            <ScrollView ref={nav} horizontal showsHorizontalScrollIndicator={false} style={styles.nav} contentContainerStyle={styles.navContent} keyboardShouldPersistTaps="handled">
                {LMC_SETTINGS_SECTIONS.map((item) => (
                    <Pressable
                        key={item.key}
                        testID={`settings-tab-${item.key}`}
                        accessibilityRole="tab"
                        accessibilityState={{ selected: !q && item.key === section }}
                        onLayout={(event) => {
                            const x = event.nativeEvent.layout.x;
                            tabPositions.current[item.key] = x;
                            if (item.key === section) nav.current?.scrollTo({ x: Math.max(0, x - 12), animated: false });
                        }}
                        onPress={() => select(item.key)}
                        style={({ pressed }) => [styles.navItem, !q && item.key === section && { backgroundColor: colors.rowSelected }, pressed && { opacity: 0.7 }]}
                    >
                        <Ionicons name={item.icon} size={20} color={theme.colors.text} />
                        <Text numberOfLines={1} style={styles.navLabel}>{tabLabel(item)}</Text>
                    </Pressable>
                ))}
            </ScrollView>
            <View style={styles.pane} testID="settings-pane">
                {q ? <ScrollView contentContainerStyle={styles.results} keyboardShouldPersistTaps="handled">
                    {visible.map(item => <Pressable key={item.key} accessibilityRole="button" onPress={() => select(item.key)} style={({ pressed }) => [styles.result, pressed && { opacity: 0.6 }]}>
                        <Ionicons name={item.icon} size={20} color={theme.colors.text} />
                        <View style={{ flex: 1, minWidth: 0 }}>
                            <Text style={styles.navLabel}>{item.label}</Text>
                            <Text style={styles.resultHint}>{terms[item.key].filter(text => text.toLowerCase().includes(q)).join(' · ') || item.keywords}</Text>
                        </View>
                        <Ionicons name="chevron-forward" size={16} color={theme.colors.textSecondary} />
                    </Pressable>)}
                    {visible.length === 0 && <Text style={[styles.resultHint, { paddingVertical: 20 }]}>{t('lmc.list.noMatches')}</Text>}
                </ScrollView> : <>
                    <Text accessibilityRole="header" style={styles.paneTitle}>{current.label}</Text>
                    <FlatSettingsContext.Provider value={true}>
                        <View key={section} style={styles.pane}>{pane}</View>
                    </FlatSettingsContext.Provider>
                </>}
            </View>
        </View>
    );
}

export function openLmcSettings(section: LmcSettingsSection = 'general') {
    Modal.show({ component: LmcSettingsDialog, props: { section }, blurBackdrop: true });
}
