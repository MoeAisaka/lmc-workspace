import * as React from 'react';
import { Keyboard, Platform, ScrollView, TextInput, View, useWindowDimensions } from 'react-native';
import { InteractionPressable as Pressable } from '@/components/InteractionPressable';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Text } from '@/components/StyledText';
import { Typography } from '@/constants/Typography';
import { Modal } from '@/modal';
import GeneralSettingsScreen from '@/app/(app)/settings/general';
import ConversationSettingsScreen from '@/app/(app)/settings/conversation';
import AppearanceSettingsScreen from '@/app/(app)/settings/appearance';
import AgentsSettingsScreen from '@/app/(app)/settings/agents';
import AccountSettings from '@/app/(app)/settings/account';
import ClaudeOAuth from '@/app/(app)/settings/connect/claude';
import { ChangelogDialog } from '../ChangelogDialog';
import { MachineDialog } from '../MachineDialog';
import { MembersDialog } from '../MembersDialog';
import { ResourceSharingDialog, ResourceSharingList } from '../ResourceSharingDialog';
import { DevicesUpgradePane } from './DevicesUpgradePane';
import { AboutPane } from './AboutPane';
import { lmcColors } from '../lmcColors';
import { lmcElevation, lmcSurfaceBorder } from '../elevation';
import { FlatSettingsContext } from './flatSettings';
import {
    SettingsNavigationContext,
    type SettingsNavigationController,
    type SettingsSubpageInput,
} from './settingsNavigation';
import { t } from '@/text';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

export type LmcSettingsSection = 'general' | 'appearance' | 'conversation' | 'devices' | 'agents' | 'account' | 'about';

// Resolve labels when read so account language restoration also reaches the tabs.
export const LMC_SETTINGS_SECTIONS: { key: LmcSettingsSection; label: string; icon: keyof typeof Ionicons.glyphMap; keywords: string }[] = [
    { key: 'general', get label() { return t('lmc.settings.general'); }, icon: 'settings-outline', get keywords() { return t('lmc.settings.generalKeywords'); } },
    { key: 'appearance', get label() { return t('lmc.settings.appearance'); }, icon: 'color-palette-outline', get keywords() { return t('lmc.settings.appearanceKeywords'); } },
    { key: 'conversation', get label() { return t('lmc.settings.conversation'); }, icon: 'chatbubbles-outline', get keywords() { return t('lmc.settings.conversationKeywords'); } },
    { key: 'devices', get label() { return t('lmc.settings.devices'); }, icon: 'laptop-outline', get keywords() { return t('lmc.settings.devicesKeywords'); } },
    { key: 'agents', get label() { return t('lmc.settings.agents'); }, icon: 'options-outline', get keywords() { return t('lmc.settings.agentsKeywords'); } },
    { key: 'account', get label() { return t('lmc.settings.account'); }, icon: 'person-circle-outline', get keywords() { return t('lmc.settings.accountKeywords'); } },
    { key: 'about', get label() { return t('lmc.settings.about'); }, icon: 'information-circle-outline', get keywords() { return t('lmc.settings.aboutKeywords'); } },
];

const styles = StyleSheet.create((theme) => ({
    dialog: { borderRadius: 16, overflow: 'hidden', backgroundColor: theme.colors.surface, ...lmcElevation(theme, 3), ...lmcSurfaceBorder(theme) },
    header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingLeft: 20, paddingRight: 10, minHeight: 56, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.colors.divider },
    title: { fontSize: 20, lineHeight: 28, color: theme.colors.text, ...Typography.default('semiBold') },
    close: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
    search: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 12, height: 36, borderRadius: 20, borderWidth: 1, borderColor: theme.colors.divider, marginHorizontal: 16, marginTop: 12, marginBottom: 10 },
    searchInput: { flex: 1, minWidth: 0, height: '100%', fontSize: 16, color: theme.colors.text, ...Typography.default(), ...(Platform.OS === 'web' ? ({ outlineStyle: 'none' } as any) : {}) },
    nav: { flexGrow: 0, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.colors.divider },
    navContent: { gap: 6, paddingHorizontal: 16, paddingBottom: 10 },
    navItem: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 14, paddingVertical: 7, minHeight: 38, borderRadius: 10 },
    navLabel: { fontSize: 15, lineHeight: 22, color: theme.colors.text, ...Typography.default() },
    pane: { flex: 1, minWidth: 0, minHeight: 0 },
    paneTitle: { fontSize: 18, lineHeight: 26, color: theme.colors.text, paddingHorizontal: 20, paddingTop: 16, paddingBottom: 10, ...Typography.default('semiBold') },
    subpageHeader: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 16, paddingVertical: 8, minHeight: 48, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.colors.divider },
    backButton: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
        paddingLeft: 10,
        paddingRight: 14,
        paddingVertical: 6,
        minHeight: 34,
        borderRadius: 10,
        borderWidth: 1,
        borderColor: theme.dark ? 'rgba(255, 255, 255, 0.10)' : 'rgba(15, 23, 42, 0.08)',
        backgroundColor: theme.dark ? 'rgba(255, 255, 255, 0.045)' : 'rgba(15, 23, 42, 0.028)',
    },
    backLabel: { fontSize: 14, lineHeight: 20, ...Typography.default('semiBold') },
    breadcrumbs: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 4 },
    breadcrumbButton: { flexShrink: 1, minWidth: 0, paddingHorizontal: 4, paddingVertical: 4, borderRadius: 6 },
    breadcrumbLink: { fontSize: 14, lineHeight: 20, color: theme.colors.textSecondary, ...Typography.default() },
    subpageTitle: { flexShrink: 1, fontSize: 15, lineHeight: 22, color: theme.colors.text, ...Typography.default('semiBold') },
    results: { paddingHorizontal: 20, paddingBottom: 20 },
    result: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 16, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.colors.divider },
    resultHint: { fontSize: 13, lineHeight: 20, color: theme.colors.textSecondary, marginTop: 4, ...Typography.default() },
}));

interface MountedSubpage {
    id: number;
    key: string;
    title: string;
    render: () => React.ReactNode;
}

/**
 * One settings surface on phones and desktop. Only the content pane scrolls
 * vertically; search, categories and the close action remain in reach.
 */
export function LmcSettingsDialog({
    section: initial = 'general',
    onSectionChange,
    onClose,
}: {
    section?: LmcSettingsSection;
    onSectionChange?: (section: LmcSettingsSection) => void;
    onClose?: () => void;
}) {
    const { theme } = useUnistyles();
    const colors = lmcColors(theme);
    const { width, height } = useWindowDimensions();
    const insets = useSafeAreaInsets();
    const [section, setSection] = React.useState<LmcSettingsSection>(initial);
    const [query, setQuery] = React.useState('');
    const [subpages, setSubpages] = React.useState<MountedSubpage[]>([]);
    const nextSubpageId = React.useRef(1);
    const nav = React.useRef<ScrollView>(null);
    const tabPositions = React.useRef<Partial<Record<LmcSettingsSection, number>>>({});
    const q = query.trim().toLowerCase();
    // Search the names people see in the panes, as well as category aliases.
    // Results navigate to existing controls instead of mounting every pane
    // (and starting device/account requests) for a search.
    const terms: Record<LmcSettingsSection, string[]> = {
        general: [t('settingsLanguage.currentLanguage'), t('settingsFeatures.commandPalette')],
        appearance: [
            t('settings.appearance'), t('personalization.title'), t('personalization.chrome'), t('personalization.terminal'),
            t('personalization.readingStyle'), t('personalization.motion'), t('personalization.typography'),
            t('personalization.uiFont'), t('personalization.codeFont'), t('personalization.textSize'), t('personalization.lineHeight'),
            t('personalization.colors'), t('personalization.accent'), t('settingsAppearance.userMessageBubbleColor'),
            t('personalization.layout'), t('personalization.density'), t('personalization.sidebarWidth'),
            t('personalization.contentWidth'), t('personalization.zen'), t('personalization.reset'),
        ],
        conversation: [
            t('settingsAppearance.input'), t('settingsAppearance.alwaysShowContextSize'), t('settingsFeatures.enterToSend'),
            t('settingsAppearance.display'), t('settingsAppearance.groupSessionsByEngine'), t('settingsAppearance.compactToolCalls'),
            t('settingsFeatures.fileDiffsSidebar'), t('settingsFeatures.groupToolCalls'), t('settingsAppearance.showLineNumbersInToolViews'),
            t('lmc.interactive.settingTitle'), t('lmc.interactive.settingSubtitle'),
        ],
        devices: [t('lmc.menu.devices'), t('lmc.devices.detail')],
        agents: [t('localFeatures.model'), t('localFeatures.effort'), t('localFeatures.permission'), 'Claude Code', 'Codex'],
        account: [t('lmc.profile.section'), t('lmc.profile.name'), t('lmc.profile.changeAvatar'), t('lmc.account.mySharing'), t('lmc.account.members'), t('lmc.account.connectDevice'), t('lmc.account.connectClaude'), t('lmc.menu.signOut')],
        about: [t('lmc.about.developerMode'), t('lmc.about.devTools'), t('lmc.about.webVersion'), t('lmc.about.changelog')],
    };
    const visible = LMC_SETTINGS_SECTIONS.filter((s) => [s.label, s.keywords, ...terms[s.key]].some(text => text.toLowerCase().includes(q)));
    const current = LMC_SETTINGS_SECTIONS.find((s) => s.key === section)!;
    const close = React.useCallback(() => onClose?.(), [onClose]);
    const pushSubpage = React.useCallback((entry: SettingsSubpageInput) => {
        Keyboard.dismiss();
        setSubpages((prev) => {
            if (prev[prev.length - 1]?.key === entry.key) {
                return prev;
            }
            return [
                ...prev,
                {
                    id: nextSubpageId.current++,
                    key: entry.key,
                    title: entry.title,
                    render: entry.render,
                },
            ];
        });
    }, []);
    const popSubpage = React.useCallback(() => {
        Keyboard.dismiss();
        setSubpages((prev) => (prev.length > 0 ? prev.slice(0, -1) : prev));
    }, []);
    const popToIndex = React.useCallback((index: number) => {
        Keyboard.dismiss();
        setSubpages((prev) => (index < 0 ? [] : prev.slice(0, index + 1)));
    }, []);
    const resetSubpages = React.useCallback(() => {
        Keyboard.dismiss();
        setSubpages([]);
    }, []);
    const settingsNav = React.useMemo<SettingsNavigationController>(() => ({
        isEmbeddedInSettings: true,
        pushSubpage,
        popSubpage,
        popToIndex,
        resetSubpages,
        closeSettings: close,
        openChangelog: () =>
            pushSubpage({
                key: 'changelog',
                title: t('lmc.dialogs.changelog'),
                render: () => <ChangelogDialog onClose={popSubpage} />,
            }),
        openMachineDetails: (machineId: string) =>
            pushSubpage({
                key: `machine:${machineId}`,
                title: t('lmc.dialogs.machineDetails'),
                render: () => <MachineDialog machineId={machineId} onClose={popSubpage} />,
            }),
        openMembers: () =>
            pushSubpage({
                key: 'members',
                title: t('lmc.sharing.membersTitle'),
                render: () => <MembersDialog onClose={popSubpage} />,
            }),
        openResourceSharingList: (ownerId?: string, ownerLabel?: string) =>
            pushSubpage({
                key: `sharing-list:${ownerId ?? 'self'}`,
                title: ownerId
                    ? ownerLabel
                        ? `${ownerLabel} · ${t('lmc.sharing.sharedResources')}`
                        : t('lmc.sharing.resourceSharingTitle')
                    : t('lmc.account.mySharing'),
                render: () => <ResourceSharingList ownerId={ownerId} onClose={popSubpage} />,
            }),
        openResourceSharing: (kind, id, options) =>
            pushSubpage({
                key: `sharing-item:${kind}:${id}`,
                title: t('lmc.sharing.settingsTitle'),
                render: () => (
                    <ResourceSharingDialog
                        kind={kind}
                        id={id}
                        onClose={popSubpage}
                        onSaved={options?.onSaved}
                    />
                ),
            }),
        openConnectClaude: () =>
            pushSubpage({
                key: 'connect-claude',
                title: t('lmc.account.connectClaude'),
                render: () => <ClaudeOAuth />,
            }),
    }), [close, popSubpage, popToIndex, pushSubpage, resetSubpages]);

    const select = (next: LmcSettingsSection) => { Keyboard.dismiss(); setSubpages([]); setSection(next); onSectionChange?.(next); setQuery(''); };
    React.useEffect(() => {
        nav.current?.scrollTo({ x: Math.max(0, (tabPositions.current[section] ?? 0) - 12), animated: false });
    }, [section, width]);
    const availableHeight = Math.max(0, height - insets.top - insets.bottom);
    const tabLabel = (item: typeof current) => item.key === 'devices' ? t('settings.machines')
        : item.key === 'account' ? t('settings.account') : item.label;
    const activeSubpage = subpages[subpages.length - 1];

    const pane = section === 'general' ? <GeneralSettingsScreen />
        : section === 'appearance' ? <AppearanceSettingsScreen />
        : section === 'conversation' ? <ConversationSettingsScreen />
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
            <View {...(Platform.OS === 'web' ? {dataSet: {lmcChromeSurface: 'true'}} : {})} style={styles.search}>
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
                    {activeSubpage ? (
                        <View testID="settings-subpage-header" style={styles.subpageHeader}>
                            <Pressable
                                testID="settings-back-button"
                                accessibilityRole="button"
                                accessibilityLabel={t('common.back')}
                                onPress={popSubpage}
                                style={({ pressed }) => [styles.backButton, pressed && { backgroundColor: colors.rowSelected }]}
                            >
                                <Ionicons name="chevron-back" size={18} color={theme.colors.textLink ?? colors.brand} />
                                <Text style={[styles.backLabel, { color: theme.colors.textLink ?? colors.brand }]}>{t('common.back')}</Text>
                            </Pressable>
                            <View style={styles.breadcrumbs}>
                                <Pressable
                                    accessibilityRole="button"
                                    onPress={resetSubpages}
                                    style={({ pressed }) => [styles.breadcrumbButton, pressed && { opacity: 0.6 }]}
                                >
                                    <Text numberOfLines={1} style={styles.breadcrumbLink}>{tabLabel(current)}</Text>
                                </Pressable>
                                {subpages.slice(0, -1).map((entry, idx) => (
                                    <React.Fragment key={entry.id}>
                                        <Ionicons name="chevron-forward" size={14} color={colors.tertiary} />
                                        <Pressable
                                            accessibilityRole="button"
                                            onPress={() => popToIndex(idx)}
                                            style={({ pressed }) => [styles.breadcrumbButton, pressed && { opacity: 0.6 }]}
                                        >
                                            <Text numberOfLines={1} style={styles.breadcrumbLink}>{entry.title}</Text>
                                        </Pressable>
                                    </React.Fragment>
                                ))}
                                <Ionicons name="chevron-forward" size={14} color={colors.tertiary} />
                                <Text accessibilityRole="header" numberOfLines={1} style={styles.subpageTitle}>{activeSubpage.title}</Text>
                            </View>
                        </View>
                    ) : (
                        <Text accessibilityRole="header" style={styles.paneTitle}>{current.label}</Text>
                    )}
                    <SettingsNavigationContext.Provider value={settingsNav}>
                        <FlatSettingsContext.Provider value={true}>
                            <View
                                key={section}
                                testID="settings-root-pane"
                                pointerEvents={subpages.length === 0 ? 'auto' : 'none'}
                                style={[styles.pane, subpages.length > 0 && { display: 'none' }]}
                            >
                                {pane}
                            </View>
                            {subpages.map((entry, idx) => {
                                const isTop = idx === subpages.length - 1;
                                return (
                                    <View
                                        key={entry.id}
                                        testID={isTop ? 'settings-active-subpage' : `settings-hidden-subpage-${idx}`}
                                        pointerEvents={isTop ? 'auto' : 'none'}
                                        style={[styles.pane, !isTop && { display: 'none' }]}
                                    >
                                        {entry.render()}
                                    </View>
                                );
                            })}
                        </FlatSettingsContext.Provider>
                    </SettingsNavigationContext.Provider>
                </>}
            </View>
        </View>
    );
}

export function openLmcSettings(section: LmcSettingsSection = 'general') {
    const props = {
        section,
        onSectionChange: (next: LmcSettingsSection) => { props.section = next; },
    };
    Modal.show({ component: LmcSettingsDialog, props, blurBackdrop: true, animateExit: true });
}
