import { Ionicons } from '@expo/vector-icons';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { useSettingMutable, useLocalSettingMutable } from '@/sync/storage';
import { useUnistyles, UnistylesRuntime } from 'react-native-unistyles';
import { Switch } from '@/components/Switch';
import { Appearance, Platform, View } from 'react-native';
import * as SystemUI from 'expo-system-ui';
import { darkTheme, lightTheme } from '@/theme';
import { t, getLanguageNativeName, SUPPORTED_LANGUAGE_CODES, DEFAULT_LANGUAGE, type SupportedLanguage } from '@/text';
import { useUpdates } from '@/hooks/useUpdates';
import { SettingsMenuHost, SettingsSelect, type SelectOption } from '@/components/lmc/SettingsSelect';
import {
    normalizeUserMessageBubbleColor,
    resolveUserMessageBubbleColor,
    USER_MESSAGE_BUBBLE_COLORS,
    type UserMessageBubbleColor,
} from '@/utils/userMessageBubbleColor';
import * as React from 'react';

type ThemePreference = 'adaptive' | 'light' | 'dark';

const getUserMessageBubbleColorLabel = (color: UserMessageBubbleColor): string => {
    switch (color) {
        case 'blue':
            return t('settingsAppearance.userMessageBubbleColorOptions.blue');
        case 'green':
            return t('settingsAppearance.userMessageBubbleColorOptions.green');
        case 'purple':
            return t('settingsAppearance.userMessageBubbleColorOptions.purple');
        case 'rose':
            return t('settingsAppearance.userMessageBubbleColorOptions.rose');
        case 'sand':
            return t('settingsAppearance.userMessageBubbleColorOptions.sand');
        case 'gray':
            return t('settingsAppearance.userMessageBubbleColorOptions.gray');
    }
};

/** A dot of the colour itself: the six names mean nothing without it. */
function BubbleColorDot({ color }: { color: UserMessageBubbleColor }) {
    const { theme } = useUnistyles();
    const palette = resolveUserMessageBubbleColor(color, theme.dark);
    return (
        <View style={{
            width: 16,
            height: 16,
            borderRadius: 8,
            backgroundColor: palette.background,
            borderWidth: 1,
            borderColor: palette.border,
        }} />
    );
}

export default function AppearanceSettingsScreen() {
    const { theme } = useUnistyles();
    const { reloadApp } = useUpdates();
    const [showLineNumbersInToolViews, setShowLineNumbersInToolViews] = useSettingMutable('showLineNumbersInToolViews');
    const [alwaysShowContextSize, setAlwaysShowContextSize] = useSettingMutable('alwaysShowContextSize');
    const [compactToolCalls, setCompactToolCalls] = useSettingMutable('compactToolCalls');
    const [groupSessionsByEngine, setGroupSessionsByEngine] = useSettingMutable('sessionListGroupByEngine');
    const [userMessageBubbleColor, setUserMessageBubbleColor] = useSettingMutable('userMessageBubbleColor');
    const [usageLimitShowRemaining, setUsageLimitShowRemaining] = useSettingMutable('usageLimitShowRemaining');
    const [themePreference, setThemePreference] = useLocalSettingMutable('themePreference');
    const [preferredLanguage, setPreferredLanguage] = useSettingMutable('preferredLanguage');
    const [agentInputEnterToSend, setAgentInputEnterToSend] = useSettingMutable('agentInputEnterToSend');
    const [commandPaletteEnabled, setCommandPaletteEnabled] = useLocalSettingMutable('commandPaletteEnabled');
    const [fileDiffsSidebar, setFileDiffsSidebar] = useSettingMutable('fileDiffsSidebar');
    const [groupToolCalls, setGroupToolCalls] = useSettingMutable('groupToolCalls');

    const displayBubbleColor = normalizeUserMessageBubbleColor(userMessageBubbleColor);

    const themeOptions: SelectOption<ThemePreference>[] = [
        { value: 'adaptive', label: t('settingsAppearance.themeOptions.adaptive'), description: t('settingsAppearance.themeDescriptions.adaptive') },
        { value: 'light', label: t('settingsAppearance.themeOptions.light'), description: t('settingsAppearance.themeDescriptions.light') },
        { value: 'dark', label: t('settingsAppearance.themeOptions.dark'), description: t('settingsAppearance.themeDescriptions.dark') },
    ];

    const applyTheme = (nextTheme: ThemePreference) => {
        setThemePreference(nextTheme);

        // Keep the NATIVE appearance in step: SwiftUI menus, the keyboard, and
        // native context menus follow UIKit, not unistyles (see unistyles.ts).
        if (Platform.OS !== 'web') {
            Appearance.setColorScheme(nextTheme === 'adaptive' ? 'unspecified' : nextTheme);
        }

        if (nextTheme === 'adaptive') {
            UnistylesRuntime.setAdaptiveThemes(true);
            const systemTheme = Appearance.getColorScheme();
            const color = systemTheme === 'dark' ? darkTheme.colors.groupped.background : lightTheme.colors.groupped.background;
            UnistylesRuntime.setRootViewBackgroundColor(color);
            SystemUI.setBackgroundColorAsync(color);
        } else {
            UnistylesRuntime.setAdaptiveThemes(false);
            UnistylesRuntime.setTheme(nextTheme);
            const color = nextTheme === 'dark' ? darkTheme.colors.groupped.background : lightTheme.colors.groupped.background;
            UnistylesRuntime.setRootViewBackgroundColor(color);
            SystemUI.setBackgroundColorAsync(color);
        }
    };

    // No automatic option: a center serves English until someone picks a
    // language, so "follow the device" would only ever mean English.
    const language: SupportedLanguage = SUPPORTED_LANGUAGE_CODES.includes(preferredLanguage as SupportedLanguage)
        ? preferredLanguage as SupportedLanguage
        : DEFAULT_LANGUAGE;
    const languageOptions: SelectOption<SupportedLanguage>[] = SUPPORTED_LANGUAGE_CODES.map((code) => ({
        value: code,
        label: getLanguageNativeName(code),
    }));

    // Every translated string is read once at boot — the section titles in the
    // settings rail included — so the choice only lands after a reload. The row
    // says so before you pick rather than asking again afterwards: a dialog on
    // top of this one would close the settings you opened it from.
    const changeLanguage = (next: SupportedLanguage) => {
        if (next === language) return;
        setPreferredLanguage(next);
        setTimeout(() => reloadApp(), 100);
    };

    return (
        <SettingsMenuHost>
            <ItemList style={{ paddingTop: 0 }}>
                {/* No heading: appearance and language are the first thing the
                    pane shows, and "Theme" stopped describing the pair. */}
                <ItemGroup>
                    <Item
                        title={t('settings.appearance')}
                        icon={<Ionicons name="contrast-outline" size={29} color={theme.colors.status.connecting} />}
                        rightElement={
                            <SettingsSelect
                                value={themePreference as ThemePreference}
                                options={themeOptions}
                                onChange={applyTheme}
                            />
                        }
                    />
                    <Item
                        title={t('settingsLanguage.currentLanguage')}
                        subtitle={t('settingsLanguage.needsRestartMessage')}
                        icon={<Ionicons name="language-outline" size={29} color="#0060F0" />}
                        rightElement={
                            <SettingsSelect
                                value={language}
                                options={languageOptions}
                                onChange={changeLanguage}
                            />
                        }
                        showDivider={false}
                    />
                </ItemGroup>

                <ItemGroup title={t('settingsAppearance.chat')} footer={t('settingsAppearance.chatDescription')}>
                    <Item
                        title={t('settingsAppearance.usageLimitShowRemaining')}
                        subtitle={t('settingsAppearance.usageLimitShowRemainingDescription')}
                        icon={<Ionicons name="speedometer-outline" size={29} color={theme.colors.status.connecting} />}
                        rightElement={
                            <Switch
                                value={usageLimitShowRemaining}
                                onValueChange={setUsageLimitShowRemaining}
                            />
                        }
                    />
                    <Item
                        title={t('settingsAppearance.userMessageBubbleColor')}
                        subtitle={t('settingsAppearance.userMessageBubbleColorDescription')}
                        icon={<Ionicons name="chatbubble-ellipses-outline" size={29} color={resolveUserMessageBubbleColor(displayBubbleColor, theme.dark).indicator} />}
                        rightElement={
                            <SettingsSelect
                                value={displayBubbleColor}
                                options={USER_MESSAGE_BUBBLE_COLORS.map((color) => ({
                                    value: color,
                                    label: getUserMessageBubbleColorLabel(color),
                                    leading: <BubbleColorDot color={color} />,
                                }))}
                                onChange={setUserMessageBubbleColor}
                            />
                        }
                        showDivider={false}
                    />
                </ItemGroup>

                <ItemGroup title={t('settingsAppearance.input')} footer={t('settingsAppearance.inputDescription')}>
                    <Item
                        title={t('settingsAppearance.alwaysShowContextSize')}
                        subtitle={t('settingsAppearance.alwaysShowContextSizeDescription')}
                        icon={<Ionicons name="analytics-outline" size={29} color="#5856D6" />}
                        rightElement={
                            <Switch
                                value={alwaysShowContextSize}
                                onValueChange={setAlwaysShowContextSize}
                            />
                        }
                    />
                    {Platform.OS === 'web' && (
                        <>
                            <Item
                                title={t('settingsFeatures.enterToSend')}
                                subtitle={agentInputEnterToSend
                                    ? t('settingsFeatures.enterToSendEnabled')
                                    : t('settingsFeatures.enterToSendDisabled')}
                                icon={<Ionicons name="return-down-forward-outline" size={29} color="#0060F0" />}
                                rightElement={
                                    <Switch
                                        value={agentInputEnterToSend}
                                        onValueChange={setAgentInputEnterToSend}
                                    />
                                }
                                showChevron={false}
                            />
                            <Item
                                title={t('settingsFeatures.commandPalette')}
                                subtitle={commandPaletteEnabled
                                    ? t('settingsFeatures.commandPaletteEnabled')
                                    : t('settingsFeatures.commandPaletteDisabled')}
                                icon={<Ionicons name="keypad-outline" size={29} color="#0060F0" />}
                                rightElement={
                                    <Switch
                                        value={commandPaletteEnabled}
                                        onValueChange={setCommandPaletteEnabled}
                                    />
                                }
                                showChevron={false}
                                showDivider={false}
                            />
                        </>
                    )}
                </ItemGroup>

                <ItemGroup title={t('settingsAppearance.display')} footer={t('settingsAppearance.displayDescription')}>
                    <Item
                        title={t('settingsAppearance.groupSessionsByEngine')}
                        subtitle={t('settingsAppearance.groupSessionsByEngineDescription')}
                        icon={<Ionicons name="git-network-outline" size={29} color="#0060F0" />}
                        rightElement={
                            <Switch
                                value={groupSessionsByEngine}
                                onValueChange={setGroupSessionsByEngine}
                            />
                        }
                    />
                    <Item
                        title={t('settingsAppearance.compactToolCalls')}
                        subtitle={t('settingsAppearance.compactToolCallsDescription')}
                        icon={<Ionicons name="contract-outline" size={29} color="#5856D6" />}
                        rightElement={
                            <Switch
                                value={compactToolCalls}
                                onValueChange={setCompactToolCalls}
                            />
                        }
                    />
                    <Item
                        title={t('settingsFeatures.fileDiffsSidebar')}
                        subtitle={t('settingsFeatures.fileDiffsSidebarSubtitle')}
                        icon={<Ionicons name="git-branch-outline" size={29} color="#0060F0" />}
                        rightElement={
                            <Switch
                                value={fileDiffsSidebar}
                                onValueChange={setFileDiffsSidebar}
                            />
                        }
                        showChevron={false}
                    />
                    <Item
                        title={t('settingsFeatures.groupToolCalls')}
                        subtitle={t('settingsFeatures.groupToolCallsSubtitle')}
                        icon={<Ionicons name="layers-outline" size={29} color="#AF52DE" />}
                        rightElement={
                            <Switch
                                value={groupToolCalls}
                                onValueChange={setGroupToolCalls}
                            />
                        }
                        showChevron={false}
                    />
                    <Item
                        title={t('settingsAppearance.showLineNumbersInToolViews')}
                        subtitle={t('settingsAppearance.showLineNumbersInToolViewsDescription')}
                        icon={<Ionicons name="code-working-outline" size={29} color="#5856D6" />}
                        rightElement={
                            <Switch
                                value={showLineNumbersInToolViews}
                                onValueChange={setShowLineNumbersInToolViews}
                            />
                        }
                        showDivider={false}
                    />
                </ItemGroup>
            </ItemList>
        </SettingsMenuHost>
    );
}
