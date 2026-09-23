import * as React from 'react';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import {
    getEffortLevelsForModel,
    getAvailableModels,
    getHardcodedPermissionModes,
    type ModeOption,
} from '@/components/modelModeOptions';
import { useAllMachines, useSettingMutable } from '@/sync/storage';
import {
    agentKeys,
    getCodeAgentDefaults,
    getAgentDefaultOverrideValue,
    hasAgentDefaultOverride,
    resolveAgentDefaultConfig,
    setAgentDefaultOverride,
    type AgentDefaultField,
    type AgentKey,
} from '@/sync/agentDefaults';
import { getHarnessName, isRetiredHarness } from '@/utils/harnessCatalog';
import { SettingsMenuHost, SettingsSelect, type SelectOption } from '@/components/lmc/SettingsSelect';
import { t } from '@/text';
import { Modal } from '@/modal';
import { collectMachineChoices } from '@/sync/machineChoices';
import { isMachineOnline } from '@/utils/machineUtils';
import { useRouter } from 'expo-router';

/** Sentinels for the two menu rows that are not one of the agent's own modes. */
const INHERIT = '\u0000default';
const CUSTOM = '\u0000custom';

type FieldConfig = {
    field: AgentDefaultField;
    title: string;
    icon: keyof typeof Ionicons.glyphMap;
    options: ModeOption[];
    codeDefaultKey: string | null;
};

const agentLabels: Record<AgentKey, string> = {
    claude: getHarnessName('claude'),
    codex: getHarnessName('codex'),
    gemini: getHarnessName('gemini'),
    openclaw: getHarnessName('openclaw'),
    agy: getHarnessName('agy'),
};

// A retired harness keeps its stored defaults — the schema still carries them,
// and "Reset all" still clears them — but there is nothing to configure for an
// agent you can no longer start a session with.
const configurableAgentKeys = agentKeys.filter((agent) => !isRetiredHarness(agent));

function optionName(options: ModeOption[], key: string | null | undefined): string {
    if (!key) return t('localFeatures.none');
    return options.find((option) => option.key === key)?.name ?? key;
}

export default function AgentsSettingsScreen({ onNavigate }: { onNavigate?: () => void } = {}) {
    const { theme } = useUnistyles();
    const router = useRouter();
    const [agentDefaultOverrides, setAgentDefaultOverrides] = useSettingMutable('agentDefaultOverrides');
    const machines = useAllMachines({ includeOffline: true });
    const catalogMetadata = React.useMemo(() => ({
        path: '', host: '',
        modelCatalogs: Object.fromEntries((['claude', 'codex'] as const).map(engine => [engine,
            machines.map(machine => machine.metadata?.modelDiscovery ? machine.metadata.modelCatalogs?.[engine] : undefined)
                .filter(catalog => catalog !== undefined).sort((a, b) => b.capturedAt - a.capturedAt)[0],
        ])),
    }), [machines]);
    const machineChoices = React.useMemo(() => (
        collectMachineChoices(machines).sort((left, right) => (
            Number(right.online) - Number(left.online)
            || right.activeAt - left.activeAt
        ))
    ), [machines]);

    const updateOverride = React.useCallback((
        agent: AgentKey,
        field: AgentDefaultField,
        value: string | null,
    ) => {
        setAgentDefaultOverrides(setAgentDefaultOverride(agentDefaultOverrides, agent, field, value));
    }, [agentDefaultOverrides, setAgentDefaultOverrides]);

    const editCustomCodexModel = React.useCallback(async (currentValue?: string) => {
        const value = await Modal.prompt(
            t('localFeatures.customCodex'),
            t('localFeatures.modelHint'),
            {
                defaultValue: currentValue ?? '',
                placeholder: 'model-id',
                confirmText: t('common.save'),
            },
        );
        const model = value?.trim();
        if (model) {
            updateOverride('codex', 'modelMode', model);
        }
    }, [updateOverride]);

    const renderField = (agent: AgentKey, config: FieldConfig) => {
        const effectiveDefaults = resolveAgentDefaultConfig(agentDefaultOverrides, agent);
        const effectiveValue = effectiveDefaults[config.field];
        const overrideValue = getAgentDefaultOverrideValue(agentDefaultOverrides, agent, config.field);
        const hasOverride = hasAgentDefaultOverride(agentDefaultOverrides, agent, config.field);
        const offersCustomModel = agent === 'codex' && config.field === 'modelMode';
        const isCustomCodexModel = offersCustomModel
            && Boolean(overrideValue)
            && !config.options.some((option) => option.key === overrideValue);

        const options: SelectOption<string>[] = [
            {
                value: INHERIT,
                // Named rather than described: the row's value is what you read
                // the list for, and "Default" alone does not say which model.
                label: `${t('localFeatures.defaultLabel')} (${optionName(config.options, effectiveValue)})`,
            },
            ...config.options.map((option) => ({
                value: option.key,
                label: option.name,
                description: option.description ?? undefined,
            })),
            ...(offersCustomModel ? [{
                value: CUSTOM,
                label: isCustomCodexModel ? overrideValue! : t('localFeatures.customModel'),
                description: isCustomCodexModel ? undefined : t('localFeatures.modelId'),
            }] : []),
        ];

        const selected = !hasOverride ? INHERIT : isCustomCodexModel ? CUSTOM : (overrideValue ?? INHERIT);

        return (
            <Item
                key={`${agent}-${config.field}`}
                title={config.title}
                icon={<Ionicons name={config.icon} size={29} color="#5856D6" />}
                rightElement={
                    <SettingsSelect
                        value={selected}
                        options={options}
                        onChange={(value) => {
                            if (value === CUSTOM) editCustomCodexModel(isCustomCodexModel ? overrideValue : undefined);
                            else updateOverride(agent, config.field, value === INHERIT ? null : value);
                        }}
                    />
                }
            />
        );
    };

    return (
        <SettingsMenuHost>
            <ItemList style={{ paddingTop: 0 }}>
                <ItemGroup title={t('localFeatures.machines')}>
                    {machineChoices.length === 0 ? (
                        <Item
                            title={t('localFeatures.noMachines')}
                            subtitle={t('localFeatures.connectMachine')}
                            icon={<Ionicons name="desktop-outline" size={29} color={theme.colors.textSecondary} />}
                            disabled
                            showChevron={false}
                        />
                    ) : machineChoices.map((choice) => {
                        const machine = choice.lmcMachine ?? choice.rigMachine;
                        const platform = machine?.metadata?.platform?.trim();
                        const subtitle = [platform, choice.online ? t('status.online') : t('status.offline')]
                            .filter(Boolean)
                            .join(' • ');
                        const targetMachine = [choice.lmcMachine, choice.rigMachine]
                            .find((candidate) => candidate && isMachineOnline(candidate))
                            ?? machine;

                        return (
                            <Item
                                key={choice.id}
                                title={choice.name}
                                subtitle={subtitle}
                                icon={
                                    <Ionicons
                                        name="desktop-outline"
                                        size={29}
                                        color={choice.online
                                            ? theme.colors.status.connected
                                            : theme.colors.status.disconnected}
                                    />
                                }
                                style={{ opacity: choice.online ? 1 : 0.5 }}
                                onPress={targetMachine
                                    ? () => { onNavigate?.(); router.push(`/machine/${targetMachine.id}`); }
                                    : undefined}
                            />
                        );
                    })}
                </ItemGroup>

                <ItemGroup
                    title={t('localFeatures.defaults')}
                >
                    <Item
                        title={t('localFeatures.clearOverrides')}
                        subtitle={t('localFeatures.clearDescription')}
                        icon={<Ionicons name="refresh-outline" size={29} color="#FF9500" />}
                        onPress={() => { setAgentDefaultOverrides({}); }}
                        disabled={Object.keys(agentDefaultOverrides).length === 0}
                        showChevron={false}
                    />
                </ItemGroup>

                {configurableAgentKeys.map((agent) => {
                    const codeDefaults = getCodeAgentDefaults(agent);
                    const effectiveDefaults = resolveAgentDefaultConfig(agentDefaultOverrides, agent);
                    const permissionOptions = getHardcodedPermissionModes(agent, t);
                    const modelOptions = getAvailableModels(agent, catalogMetadata, t, effectiveDefaults.modelMode).filter((option) => option.key !== 'default');
                    const effortOptions = getEffortLevelsForModel(agent, effectiveDefaults.modelMode, catalogMetadata, t);
                    const fields: FieldConfig[] = [
                        {
                            field: 'permissionMode',
                            title: t('localFeatures.permission'),
                            icon: 'shield-checkmark-outline',
                            options: permissionOptions,
                            codeDefaultKey: codeDefaults.permissionMode,
                        },
                        ...(modelOptions.length > 0 ? [{
                            field: 'modelMode' as const,
                            title: t('localFeatures.model'),
                            icon: 'hardware-chip-outline' as const,
                            options: modelOptions,
                            codeDefaultKey: codeDefaults.modelMode,
                        }] : []),
                        ...(effortOptions.length > 0 ? [{
                            field: 'effortLevel' as const,
                            title: t('localFeatures.effort'),
                            icon: 'speedometer-outline' as const,
                            options: effortOptions,
                            codeDefaultKey: codeDefaults.effortLevel,
                        }] : []),
                    ];

                    return (
                        <ItemGroup key={agent} title={agentLabels[agent]}>
                            {fields.map((field) => renderField(agent, field))}
                        </ItemGroup>
                    );
                })}
            </ItemList>
        </SettingsMenuHost>
    );
}
