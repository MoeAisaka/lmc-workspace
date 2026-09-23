import * as React from 'react';
import { Pressable, View } from 'react-native';
import Animated, { Easing, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Text } from '@/components/StyledText';
import { Typography } from '@/constants/Typography';
import { PickerMenuDivider, PickerMenuEmpty, PickerMenuRow, PickerMenuSectionHeader, PickerMenuTitle } from './PickerMenu';
import { StopSlider } from './StopSlider';
import { ProviderIcon } from '@/components/ProviderIcon';
import type { EffortLevel, ModelMode, PermissionMode } from '@/components/modelModeOptions';
import { getPermissionModeMenuLabel } from '@/utils/permissionModeLabels';
import { permissionScale, permissionScaleIndex } from '@/sync/permissionScale';
import { engineForModelKey, engineModelGroups, type EngineModelGroup } from '@/sync/engineModelCatalog';
import type { SwitchableEngine } from '@/sync/engineSwitch';
import type { Metadata } from '@/sync/storageTypes';
import { hapticsLight } from '@/components/haptics';
import { t } from '@/text';

/**
 * A drill-in, so it should read as one: the list arrives from the right, the
 * panel behind it from the left. Driven by a shared value rather than by an
 * entering animation — on web those re-parent the node they animate, and this
 * subtree has to stay put under the pointer that is pressing it.
 */
const DRILL = { duration: 160, easing: Easing.out(Easing.cubic) } as const;

function useDrillIn(from: number, trigger: unknown) {
    const progress = useSharedValue(1);
    React.useEffect(() => {
        progress.value = 0;
        progress.value = withTiming(1, DRILL);
    }, [progress, trigger]);
    return useAnimatedStyle(() => ({
        opacity: progress.value,
        transform: [{ translateX: from * (1 - progress.value) }],
    }));
}

/**
 * Everything about how the next message gets answered, in one panel.
 *
 * Model, effort and permission were three separate menus because they arrived
 * separately, not because they are three separate decisions — they are all
 * "how should this be answered", and two of them are the same shape: an ordered
 * scale. The model leads because it is the one that is picked rather than
 * adjusted, and it opens a list of its own rather than crowding this one.
 */

export type ComposerModelPanelProps = {
    flavor?: string | null;
    metadata?: Metadata | null;
    modelMode: ModelMode | null;
    availableModels: ModelMode[];
    onModelModeChange?: (model: ModelMode) => void;
    effortLevel: EffortLevel | null;
    availableEffortLevels: EffortLevel[];
    onEffortLevelChange?: (level: EffortLevel) => void;
    permissionMode: PermissionMode | null;
    availableModes: PermissionMode[];
    onPermissionModeChange?: (mode: PermissionMode) => void;
    /**
     * Names a permission mode for display. The composer uses it to append the
     * sandbox qualifier, which changes what "never asks" actually means.
     */
    permissionLabel?: (mode: PermissionMode) => string;
    permissionLeading?: (mode: PermissionMode) => React.ReactNode;
    /**
     * Offered only for a live session on an engine that can be left. Picking a
     * model belonging to the other engine is how a switch is requested; the
     * caller owns the confirmation and the handoff.
     */
    onEngineSwitch?: (engine: SwitchableEngine, model: ModelMode) => void;
    onClose: () => void;
};

export function ComposerModelPanel(props: ComposerModelPanelProps) {
    const { theme } = useUnistyles();
    const [showingModels, setShowingModels] = React.useState(false);
    const panelStyle = useDrillIn(-14, showingModels);

    const groups = React.useMemo(() => (
        props.onEngineSwitch ? engineModelGroups(props.flavor, props.metadata, t, props.modelMode?.key) : null
    ), [props.flavor, props.metadata, props.modelMode?.key, props.onEngineSwitch]);

    const pickModel = React.useCallback((model: ModelMode) => {
        hapticsLight();
        const engine = groups ? engineForModelKey(groups, model.key) : null;
        if (groups && engine && engine !== props.flavor) {
            props.onEngineSwitch?.(engine, model);
            props.onClose();
            return;
        }
        props.onModelModeChange?.(model);
        setShowingModels(false);
    }, [groups, props]);

    if (showingModels) {
        return (
            <ModelList
                groups={groups}
                fallback={props.availableModels}
                selectedKey={props.modelMode?.key}
                disabled={!props.onModelModeChange}
                onPick={pickModel}
                onBack={() => setShowingModels(false)}
            />
        );
    }

    const scale = permissionScale(props.flavor, props.availableModes);
    const scaleIndex = scale ? permissionScaleIndex(scale, props.permissionMode?.key) : -1;
    const canOpenModels = props.availableModels.length > 0 && !!props.onModelModeChange;

    return (
        <Animated.View style={panelStyle}>
            {canOpenModels && (
                <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={t('agentInput.model.title')}
                    onPress={() => { hapticsLight(); setShowingModels(true); }}
                    style={({ pressed }) => [styles.modelRow, pressed && { backgroundColor: theme.colors.surfacePressed }]}
                >
                    {/* A rig row names its provider; everywhere else the mark is
                        the engine's own, matching the chip this panel opens from
                        and the group headers it drills into. */}
                    {props.modelMode?.providerName
                        ? <ProviderIcon kind={props.modelMode.providerKind} size={14} />
                        : groups ? <ProviderIcon kind={groups[0].engine} size={14} /> : null}
                    <Text style={styles.modelName} numberOfLines={1}>{props.modelMode?.name ?? t('agentInput.model.title')}</Text>
                    {!!groups && <Text style={styles.modelEngine} numberOfLines={1}>{groups[0].label}</Text>}
                    <View style={{ flex: 1 }} />
                    <Ionicons name="chevron-forward" size={15} color={theme.colors.textSecondary} />
                </Pressable>
            )}

            {props.availableEffortLevels.length > 1 && !!props.onEffortLevelChange && (
                <>
                    {canOpenModels && <PickerMenuDivider />}
                    <StopSlider
                        title={t('agentInput.effort.panelTitle')}
                        valueLabel={props.effortLevel?.name ?? props.availableEffortLevels[0].name}
                        leftLabel={t('agentInput.effort.faster')}
                        rightLabel={t('agentInput.effort.smarter')}
                        count={props.availableEffortLevels.length}
                        index={Math.max(0, props.availableEffortLevels.findIndex((level) => level.key === props.effortLevel?.key))}
                        onChange={(index) => { hapticsLight(); props.onEffortLevelChange?.(props.availableEffortLevels[index]); }}
                    />
                </>
            )}

            {!!props.onPermissionModeChange && scale && scaleIndex >= 0 ? (
                <>
                    <PickerMenuDivider />
                    <StopSlider
                        title={t('agentInput.permissionMode.panelTitle')}
                        valueLabel={props.permissionLabel?.(scale[scaleIndex]) ?? scale[scaleIndex].name}
                        description={scale[scaleIndex].description}
                        leftLabel={t('agentInput.permissionMode.stricter')}
                        rightLabel={t('agentInput.permissionMode.looser')}
                        count={scale.length}
                        index={scaleIndex}
                        onChange={(index) => { hapticsLight(); props.onPermissionModeChange?.(scale[index]); }}
                    />
                </>
            ) : !!props.onPermissionModeChange && props.availableModes.length > 0 ? (
                // Harnesses whose modes this scale cannot place keep the list
                // they had: a slider ordered by guesswork would be worse than
                // no slider on the one control where the order is the meaning.
                <>
                    <PickerMenuDivider />
                    <PickerMenuTitle>{t('agentInput.permissionMode.panelTitle')}</PickerMenuTitle>
                    {props.availableModes.map((mode) => (
                        <PickerMenuRow
                            key={mode.key}
                            label={props.permissionLabel?.(mode) ?? getPermissionModeMenuLabel(mode)}
                            description={mode.description}
                            selected={props.permissionMode?.key === mode.key}
                            disabled={mode.disabled}
                            leading={props.permissionLeading?.(mode)}
                            onPress={() => { hapticsLight(); props.onPermissionModeChange?.(mode); }}
                        />
                    ))}
                </>
            ) : null}
        </Animated.View>
    );
}

function ModelList(props: {
    groups: EngineModelGroup[] | null;
    fallback: ModelMode[];
    selectedKey?: string | null;
    disabled?: boolean;
    onPick: (model: ModelMode) => void;
    onBack: () => void;
}) {
    const { theme } = useUnistyles();
    const listStyle = useDrillIn(14, true);
    const sections: { key: string; title: string | null; hint: string | null; icon?: React.ReactNode; models: ModelMode[] }[] = props.groups
        ? props.groups.map((group) => ({
            key: group.engine,
            title: group.label,
            hint: group.current ? t('agentInput.model.engineCurrentHint') : t('agentInput.model.engineSwitchHint'),
            icon: <ProviderIcon kind={group.engine} size={14} />,
            models: group.models,
        }))
        : [{ key: 'models', title: null, hint: null, models: props.fallback }];

    return (
        <Animated.View style={listStyle}>
            <Pressable
                accessibilityRole="button"
                onPress={props.onBack}
                style={({ pressed }) => [styles.backRow, pressed && { backgroundColor: theme.colors.surfacePressed }]}
            >
                <Ionicons name="chevron-back" size={15} color={theme.colors.textSecondary} />
                <Text style={styles.backLabel}>{t('agentInput.model.title')}</Text>
            </Pressable>
            <PickerMenuDivider />
            {sections.map((section, at) => (
                <React.Fragment key={section.key}>
                    {at > 0 && <PickerMenuDivider />}
                    {!!section.title && <PickerMenuSectionHeader title={section.title} hint={section.hint} icon={section.icon} />}
                    {section.models.map((model) => (
                        <PickerMenuRow
                            key={`${section.key}:${model.key}`}
                            label={model.name}
                            // Engine catalogs contain paragraphs, not compact
                            // badges. Reserve the row for the model name.
                            description={section.title ? undefined : model.description}
                            selected={props.selectedKey === model.key}
                            disabled={props.disabled || model.disabled}
                            leading={model.providerName ? <ProviderIcon kind={model.providerKind} size={13} /> : undefined}
                            onPress={() => props.onPick(model)}
                        />
                    ))}
                </React.Fragment>
            ))}
            {sections.every((section) => section.models.length === 0) && (
                <PickerMenuEmpty>{t('agentInput.model.configureInCli')}</PickerMenuEmpty>
            )}
        </Animated.View>
    );
}

const styles = StyleSheet.create((theme) => ({
    modelRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 7,
        minHeight: 38,
        paddingHorizontal: 10,
        marginHorizontal: 6,
        marginTop: 2,
        borderRadius: 10,
    },
    // One line box for both labels, so the engine name sits on the model's
    // baseline instead of floating a pixel above it.
    modelName: { fontSize: 15, lineHeight: 22, color: theme.colors.text, ...Typography.default('semiBold') },
    modelEngine: { fontSize: 12, lineHeight: 22, color: theme.colors.textSecondary, flexShrink: 1, ...Typography.default() },
    backRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 5,
        minHeight: 34,
        // Six less than a row's 16, so the chevron's own optical weight puts
        // the word "模型" on the same line as the labels under it.
        paddingLeft: 4,
        paddingRight: 10,
        marginHorizontal: 6,
        marginTop: 2,
        borderRadius: 10,
    },
    backLabel: { fontSize: 13.5, lineHeight: 22, color: theme.colors.text, ...Typography.default('semiBold') },
}));
