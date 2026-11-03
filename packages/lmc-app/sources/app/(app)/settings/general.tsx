import * as React from 'react';
import { Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { Switch } from '@/components/Switch';
import { useSettingMutable } from '@/sync/storage';
import { useUpdates } from '@/hooks/useUpdates';
import { SettingsMenuHost, SettingsSelect, type SelectOption } from '@/components/lmc/SettingsSelect';
import { t, getLanguageNativeName, SUPPORTED_LANGUAGE_CODES, DEFAULT_LANGUAGE, type SupportedLanguage } from '@/text';

export default function GeneralSettingsScreen() {
    const { reloadApp } = useUpdates();
    const [preferredLanguage, setPreferredLanguage] = useSettingMutable('preferredLanguage');
    const [commandPaletteEnabled, setCommandPaletteEnabled] = useSettingMutable('commandPaletteEnabled');
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
                <ItemGroup>
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
                {Platform.OS === 'web' && (
                    <ItemGroup>
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
                    </ItemGroup>
                )}
            </ItemList>
        </SettingsMenuHost>
    );
}
