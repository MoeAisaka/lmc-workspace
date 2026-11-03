import { PersonalizationSettings } from '@/components/lmc/settings/PersonalizationSettings';
import { useSettingMutable } from '@/sync/storage';
import { sync } from '@/sync/sync';
import { personalizationDefaults } from '@/sync/personalization';
import { settingsDefaults } from '@/sync/settings';
import { Ionicons } from '@expo/vector-icons';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { useUnistyles, UnistylesRuntime } from 'react-native-unistyles';
import { Appearance, Platform, View } from 'react-native';
import * as SystemUI from 'expo-system-ui';
import { darkTheme, lightTheme } from '@/theme';
import { t } from '@/text';
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
    const [userMessageBubbleColor, setUserMessageBubbleColor] = useSettingMutable('userMessageBubbleColor');
    const [themePreference, setThemePreference] = useSettingMutable('themePreference');

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

    const bubbleControl = (
        <Item
            title={t('settingsAppearance.userMessageBubbleColor')}
            subtitle={t('settingsAppearance.userMessageBubbleColorDescription')}
            icon={<Ionicons name="chatbubble-ellipses-outline" size={29} color={resolveUserMessageBubbleColor(displayBubbleColor, theme.dark).indicator} />}
            rightElement={<SettingsSelect
                value={displayBubbleColor}
                options={USER_MESSAGE_BUBBLE_COLORS.map(color => ({ value: color, label: getUserMessageBubbleColorLabel(color), leading: <BubbleColorDot color={color} /> }))}
                onChange={setUserMessageBubbleColor}
            />}
            showDivider={false}
        />
    );

    return (
        <SettingsMenuHost>
            <ItemList style={{ paddingTop: 0 }}>
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
                        showDivider={false}
                    />
                </ItemGroup>

                {Platform.OS === 'web' ? <PersonalizationSettings
                    onReset={() => {
                        sync.applySettings({
                            personalization: { ...personalizationDefaults },
                            chatWideMode: false,
                            zenMode: false,
                            userMessageBubbleColor: settingsDefaults.userMessageBubbleColor,
                        });
                        applyTheme('adaptive');
                    }}
                    colors={bubbleControl}
                /> : (
                    <ItemGroup title={t('settingsAppearance.chat')} footer={t('settingsAppearance.chatDescription')}>
                        {bubbleControl}
                    </ItemGroup>
                )}

            </ItemList>
        </SettingsMenuHost>
    );
}
