import { openChangelog } from '@/components/lmc/ChangelogDialog';
import * as React from 'react';
import { Platform, View } from 'react-native';
import Constants from 'expo-constants';
import { useRouter } from 'expo-router';
import { Switch } from '@/components/Switch';
import { clearWebInputProbeQuery, setWebInputProbeEnabled, webInputProbeQueryEnabled } from '@/utils/webInputProbeBootstrap';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { useLocalSettingMutable } from '@/sync/storage';
import { useMultiClick } from '@/hooks/useMultiClick';
import { Modal } from '@/modal';
import { t } from '@/text';

export function readLmcReleaseMarker(): string | null {
    if (typeof document === 'undefined') return null;
    return document.querySelector('meta[name="lmc-release"]')?.getAttribute('content') ?? null;
}

export function AboutPane({ onNavigate }: { onNavigate?: () => void }) {
    const router = useRouter();
    const appVersion = Constants.expoConfig?.version || '1.0.0';
    const marker = readLmcReleaseMarker();
    const [devModeEnabled, setDevModeEnabled] = useLocalSettingMutable('devModeEnabled');
    const [queryEnabled, setQueryEnabled] = React.useState(() => Platform.OS === 'web' && webInputProbeQueryEnabled());
    const enabled = devModeEnabled || queryEnabled;
    const changeDeveloperMode = (next: boolean) => {
        if (Platform.OS === 'web') {
            clearWebInputProbeQuery();
            setQueryEnabled(false);
            setWebInputProbeEnabled(next);
        }
        setDevModeEnabled(next);
    };
    const tapVersion = useMultiClick(() => {
        const next = !enabled; changeDeveloperMode(next);
        Modal.alert(next ? t('lmc.about.devModeOn') : t('lmc.about.devModeOff'));
    }, { requiredClicks: 7 });
    return (
        <View>
            <ItemGroup title={t('lmc.about.title')} footer={t('lmc.settings.selfHostBlurb')}>
                <Item title={t('lmc.about.changelog')} subtitle={t('lmc.about.changelogSubtitle')} onPress={() => openChangelog()} />
                <Item title={t('lmc.about.webVersion')} subtitle={marker ?? t('lmc.about.localBuild')} detail={appVersion} showChevron={false} onPress={tapVersion} />
                <Item title={t('lmc.about.developerMode')} subtitle={t('lmc.about.developerModeSubtitle')}
                    rightElement={<Switch value={enabled} onValueChange={changeDeveloperMode} />} showChevron={false} />
                {enabled && <Item title={t('lmc.about.devTools')} onPress={() => { onNavigate?.(); router.push('/dev'); }} />}
            </ItemGroup>
        </View>
    );
}
