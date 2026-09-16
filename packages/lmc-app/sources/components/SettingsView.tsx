import * as React from 'react';
import { NativeScrollEvent, NativeSyntheticEvent, Platform, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { Text } from '@/components/StyledText';
import { Typography } from '@/constants/Typography';
import { Avatar } from '@/components/Avatar';
import { openExternalUrl } from '@/utils/openExternalUrl';
import { useAllMachines, useProfile, useSetting } from '@/sync/storage';
import { getAvatarUrl, getDisplayName } from '@/sync/profile';
import { getServerUrl } from '@/sync/serverConfig';
import { machineAgentVersion, machineDisplayName } from '@/utils/lmc/deviceEngineGroups';
import { LMC_SETTINGS_SECTIONS, type LmcSettingsSection } from '@/components/lmc/settings/LmcSettingsDialog';
import { useUnistyles } from 'react-native-unistyles';
import { t } from '@/text';

const ROUTES: Record<LmcSettingsSection, string> = {
    general: '/settings/appearance',
    devices: '/settings/devices',
    agents: '/settings/agents',
    account: '/settings/account',
    about: '/settings/about',
};

/**
 * The phone's settings index. It lists exactly the categories the desktop
 * dialog's rail lists, in the same order and wording, and each row opens the
 * same pane — so a setting is in one place whichever screen you are on.
 * Everything else that used to live here (sign out, changelog, version,
 * developer tools) belongs to one of those panes and is no longer duplicated.
 */
export const SettingsView = React.memo(({ topContentInset = 0, bottomContentInset = 0, onScroll }: {
    topContentInset?: number;
    bottomContentInset?: number;
    onScroll?: (event: NativeSyntheticEvent<NativeScrollEvent>) => void;
}) => {
    const router = useRouter();
    const { theme } = useUnistyles();
    const profile = useProfile();
    const machines = useAllMachines({ includeOffline: true });
    const experiments = useSetting('experiments');

    const subtitles: Record<LmcSettingsSection, string | undefined> = {
        general: t('lmc.settings.generalSubtitle'),
        devices: machines.length === 0
            ? t('lmc.settings.noDevices')
            : machines
                .map((machine) => `${machineDisplayName(machine, machine.id.slice(0, 8))}${machineAgentVersion(machine) ? ' ' + machineAgentVersion(machine) : ''}${machine.active ? '' : t('lmc.settings.offlineSuffix')}`)
                .join(' · '),
        agents: t('lmc.settings.agentsSubtitle'),
        account: getServerUrl(),
        about: t('lmc.settings.aboutSubtitle'),
    };

    return (
        <ItemList style={{ paddingTop: topContentInset }} onScroll={onScroll} contentContainerStyle={{ paddingBottom: bottomContentInset }}>
            <ItemGroup>
                <Item
                    title={getDisplayName(profile) || t('lmc.settings.fallbackAccount')}
                    subtitle={getServerUrl()}
                    leftElement={
                        <Avatar
                            id={profile.id}
                            size={40}
                            imageUrl={getAvatarUrl(profile)}
                            thumbhash={profile.avatar?.thumbhash}
                        />
                    }
                    onPress={() => router.push(ROUTES.account)}
                />
            </ItemGroup>

            <ItemGroup>
                {LMC_SETTINGS_SECTIONS.map((section) => (
                    <Item
                        key={section.key}
                        title={section.label}
                        subtitle={subtitles[section.key]}
                        subtitleLines={1}
                        icon={<Ionicons name={section.icon} size={22} color={theme.colors.textSecondary} />}
                        onPress={() => router.push(ROUTES[section.key] as never)}
                    />
                ))}
            </ItemGroup>

            {experiments && (
                <ItemGroup>
                    <Item
                        title={t('settings.usage')}
                        subtitle={t('settings.usageSubtitle')}
                        icon={<Ionicons name="analytics-outline" size={22} color={theme.colors.textSecondary} />}
                        onPress={() => router.push('/settings/usage')}
                    />
                </ItemGroup>
            )}

            {Platform.OS === 'ios' && (
                <ItemGroup>
                    <Item
                        title={t('settings.eula')}
                        icon={<Ionicons name="document-text-outline" size={22} color={theme.colors.textSecondary} />}
                        onPress={() => openExternalUrl('https://www.apple.com/legal/internet-services/itunes/dev/stdeula/')}
                    />
                </ItemGroup>
            )}

            <View style={{ paddingHorizontal: 20, paddingTop: 4, paddingBottom: 24 }}>
                <Text style={{ fontSize: 12, lineHeight: 17, color: theme.colors.textSecondary, ...Typography.default() }}>
                    {t('lmc.settings.selfHostBlurb')}
                </Text>
            </View>
        </ItemList>
    );
});
