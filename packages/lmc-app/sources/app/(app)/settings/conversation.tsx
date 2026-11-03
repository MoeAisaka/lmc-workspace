import * as React from 'react';
import { Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { Switch } from '@/components/Switch';
import { SettingsMenuHost, SettingsSelect } from '@/components/lmc/SettingsSelect';
import { useSettingMutable } from '@/sync/storage';
import { t } from '@/text';
import { INTERACTIVE_ANSWERS_MODES, type InteractiveAnswersMode } from 'lmc-wire';

const interactiveLabel = (mode: InteractiveAnswersMode) => mode === 'off' ? t('lmc.interactive.modeOff') : mode === 'ask' ? t('lmc.interactive.modeAsk') : t('lmc.interactive.modeAuto');
const interactiveDescription = (mode: InteractiveAnswersMode) => mode === 'off' ? t('lmc.interactive.modeOffDescription') : mode === 'ask' ? t('lmc.interactive.modeAskDescription') : t('lmc.interactive.modeAutoDescription');

export default function ConversationSettingsScreen() {
    const { theme } = useUnistyles();
    const [showLineNumbersInToolViews, setShowLineNumbersInToolViews] = useSettingMutable('showLineNumbersInToolViews');
    const [alwaysShowContextSize, setAlwaysShowContextSize] = useSettingMutable('alwaysShowContextSize');
    const [compactToolCalls, setCompactToolCalls] = useSettingMutable('compactToolCalls');
    const [groupSessionsByEngine, setGroupSessionsByEngine] = useSettingMutable('sessionListGroupByEngine');
    const [agentInputEnterToSend, setAgentInputEnterToSend] = useSettingMutable('agentInputEnterToSend');
    const [fileDiffsSidebar, setFileDiffsSidebar] = useSettingMutable('fileDiffsSidebar');
    const [groupToolCalls, setGroupToolCalls] = useSettingMutable('groupToolCalls');
    const [interactiveAnswers, setInteractiveAnswers] = useSettingMutable('interactiveAnswers');
    return (
        <SettingsMenuHost>
            <ItemList style={{ paddingTop: 0 }}>
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
                <ItemGroup title={t('lmc.interactive.settingTitle')} footer={t('lmc.interactive.settingFooter')}>
                    <Item
                        title={t('lmc.interactive.settingSubtitle')}
                        icon={<Ionicons name="color-wand-outline" size={29} color={theme.colors.status.connecting} />}
                        rightElement={<SettingsSelect
                            value={interactiveAnswers}
                            options={INTERACTIVE_ANSWERS_MODES.map(mode => ({ value: mode, label: interactiveLabel(mode), description: interactiveDescription(mode) }))}
                            onChange={setInteractiveAnswers}
                        />}
                        showDivider={false}
                    />
                </ItemGroup>

            </ItemList>
        </SettingsMenuHost>
    );
}
