import * as React from 'react';
import { Platform, View } from 'react-native';
import { InteractionPressable as Pressable } from '@/components/InteractionPressable';
import Animated, { Easing, useAnimatedStyle, useSharedValue, withSpring, withTiming } from 'react-native-reanimated';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Text } from '@/components/StyledText';
import { Typography } from '@/constants/Typography';
import { PickerMenuDivider, PickerMenuEmpty, PickerMenuRow, PickerMenuSectionHeader, PickerMenuTitle } from './PickerMenu';
import { StopSlider } from './StopSlider';
import { ProviderIcon } from '@/components/ProviderIcon';
import type { EffortLevel, ModelMode, PermissionMode } from '@/components/modelModeOptions';
import { getPermissionModeMenuLabel, getPermissionModeShortLabel } from '@/utils/permissionModeLabels';
import { isFullAutonomyPermissionKey, permissionScale, permissionScaleIndex } from '@/sync/permissionScale';
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
const FAST_SPRING = { damping: 20, stiffness: 320, mass: 0.6 } as const;

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
 * Model, Fast mode, effort and permission are all "how should this be answered",
 * and effort + permission are ordered scales. The model leads because it is
 * picked rather than adjusted, followed immediately by the Fast lightning switch.
 */

export type ComposerModelPanelProps = {
    flavor?: string | null;
    metadata?: Metadata | null;
    modelMode: ModelMode | null;
    availableModels: ModelMode[];
    onModelModeChange?: (model: ModelMode) => void;
    fastMode?: boolean;
    fastModeSupported?: boolean;
    onFastModeChange?: (enabled: boolean) => void;
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

    const pickModel = React.useCallback((model: ModelMode, chosenEngine?: SwitchableEngine) => {
        hapticsLight();
        const engine = chosenEngine ?? (groups ? engineForModelKey(groups, model.key) : null);
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
    const showsFastRow = !!props.onFastModeChange;
    const fastSupported = Boolean(props.fastModeSupported);
    const fastActive = Boolean(props.fastMode) && fastSupported;

    return (
        <Animated.View style={panelStyle}>
            {canOpenModels && (
                <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={t('agentInput.model.title')}
                    onPress={() => { hapticsLight(); setShowingModels(true); }}
                    style={({ pressed }) => [styles.modelRow, pressed && { backgroundColor: theme.colors.surfacePressed }]}
                >
                    {props.modelMode?.providerName
                        ? <ProviderIcon kind={props.modelMode.providerKind} size={14} />
                        : groups ? <ProviderIcon kind={groups[0].engine} size={14} /> : null}
                    <Text style={styles.modelName} numberOfLines={1}>{props.modelMode?.name ?? t('agentInput.model.title')}</Text>
                    {!!groups && <Text style={styles.modelEngine} numberOfLines={1}>{groups[0].label}</Text>}
                    <View style={{ flex: 1 }} />
                    <Ionicons name="chevron-forward" size={15} color={theme.colors.textSecondary} />
                </Pressable>
            )}

            {showsFastRow && (
                <>
                    {canOpenModels && <PickerMenuDivider />}
                    <FastModeSwitchRow
                        flavor={props.flavor}
                        active={fastActive}
                        supported={fastSupported}
                        onToggle={() => {
                            if (!fastSupported) return;
                            hapticsLight();
                            props.onFastModeChange?.(!fastActive);
                        }}
                    />
                </>
            )}

            {props.availableEffortLevels.length > 1 && !!props.onEffortLevelChange && (
                <>
                    {(canOpenModels || showsFastRow) && <PickerMenuDivider />}
                    <StopSlider
                        title={t('agentInput.effort.panelTitle')}
                        valueLabel={props.effortLevel?.name ?? props.availableEffortLevels[0].name}
                        leftLabel={t('agentInput.effort.faster')}
                        rightLabel={t('agentInput.effort.smarter')}
                        stepLabels={props.availableEffortLevels.length <= 6
                            ? props.availableEffortLevels.map((level) => level.name)
                            : undefined}
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
                        stepLabels={scale.map((mode) => getPermissionModeShortLabel(mode) ?? mode.name)}
                        tone="permission"
                        cautionAtEnd={isFullAutonomyPermissionKey(scale[scale.length - 1]?.key)}
                        count={scale.length}
                        index={scaleIndex}
                        onChange={(index) => { hapticsLight(); props.onPermissionModeChange?.(scale[index]); }}
                    />
                </>
            ) : !!props.onPermissionModeChange && props.availableModes.length > 0 ? (
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

function FastModeSwitchRow(props: {
    flavor?: string | null;
    active: boolean;
    supported: boolean;
    onToggle: () => void;
}) {
    const { theme } = useUnistyles();
    const [hovered, setHovered] = React.useState(false);
    const thumbX = useSharedValue(props.active ? 20 : 0);
    const iconPulse = useSharedValue(1);

    React.useEffect(() => {
        thumbX.value = withSpring(props.active ? 20 : 0, FAST_SPRING);
    }, [props.active, thumbX]);

    const thumbStyle = useAnimatedStyle(() => ({
        transform: [{ translateX: thumbX.value }],
    }));

    const medallionAnimStyle = useAnimatedStyle(() => ({
        transform: [{ scale: iconPulse.value }],
    }));

    const subtitle = !props.supported
        ? ((props.flavor === 'claude' || props.flavor === 'codex')
            ? t('localFeatures.fastModeUnsupported')
            : t('localFeatures.fastModeUnsupportedEngine'))
        : props.active
            ? t('localFeatures.fastModeActive')
            : (props.flavor === 'codex'
                ? t('localFeatures.fastModeCodexHint')
                : t('localFeatures.fastModeClaudeHint'));

    const amberColor = theme.dark ? '#FBBF24' : '#D97706';
    const rowActiveBg = theme.dark ? 'rgba(245, 158, 11, 0.10)' : 'rgba(245, 158, 11, 0.08)';
    const rowActiveBorder = theme.dark ? 'rgba(245, 158, 11, 0.28)' : 'rgba(217, 119, 6, 0.22)';
    const medallionBg = props.active
        ? (theme.dark ? 'rgba(251, 191, 36, 0.22)' : 'rgba(245, 158, 11, 0.18)')
        : theme.colors.surfaceHighest;

    const hoverProps = Platform.OS === 'web'
        ? {
            'aria-checked': props.active,
            'aria-disabled': !props.supported ? true : undefined,
            onHoverIn: () => setHovered(true),
            onHoverOut: () => setHovered(false),
        }
        : {};

    return (
        <Pressable
            accessibilityRole="switch"
            accessibilityLabel={t('localFeatures.fastMode')}
            accessibilityState={{ checked: props.active, disabled: !props.supported }}
            disabled={!props.supported}
            onPress={() => {
                if (!props.supported) return;
                iconPulse.value = 1.14;
                iconPulse.value = withSpring(1, FAST_SPRING);
                props.onToggle();
            }}
            {...hoverProps}
            style={({ pressed }) => [
                styles.fastRow,
                props.active && {
                    backgroundColor: rowActiveBg,
                    borderColor: rowActiveBorder,
                },
                !props.active && (pressed || hovered) && props.supported && {
                    backgroundColor: theme.colors.surfacePressed,
                },
                pressed && props.supported && { opacity: 0.86 },
                !props.supported && styles.fastRowDisabled,
            ]}
        >
            <Animated.View style={[styles.fastMedallion, { backgroundColor: medallionBg }, medallionAnimStyle]}>
                <Ionicons
                    name={props.active ? 'flash' : 'flash-outline'}
                    size={15}
                    color={props.active ? amberColor : theme.colors.textSecondary}
                />
            </Animated.View>
            <View style={styles.fastTextCol}>
                <View style={styles.fastTitleLine}>
                    <Text style={styles.fastTitle} numberOfLines={1}>
                        {t('localFeatures.fastMode')}
                    </Text>
                    {props.active && (
                        <View style={[styles.fastActivePill, { backgroundColor: theme.dark ? 'rgba(251, 191, 36, 0.20)' : 'rgba(245, 158, 11, 0.15)' }]}>
                            <Text style={[styles.fastActivePillText, { color: amberColor }]}>FAST</Text>
                        </View>
                    )}
                </View>
                <Text style={styles.fastSubtitle} numberOfLines={1}>
                    {subtitle}
                </Text>
            </View>
            <View
                pointerEvents="none"
                style={[
                    styles.fastSwitchTrack,
                    {
                        backgroundColor: props.active
                            ? (theme.dark ? '#F59E0B' : '#EA8C00')
                            : theme.colors.surfaceHighest,
                    },
                    props.active && styles.fastSwitchTrackActive,
                ]}
            >
                <Animated.View
                    style={[
                        styles.fastSwitchThumb,
                        { backgroundColor: '#FFFFFF' },
                        thumbStyle,
                    ]}
                >
                    <Ionicons
                        name={props.active ? 'flash' : 'flash-outline'}
                        size={11}
                        color={props.active ? '#D97706' : '#94A3B8'}
                    />
                </Animated.View>
            </View>
        </Pressable>
    );
}

function ModelList(props: {
    groups: EngineModelGroup[] | null;
    fallback: ModelMode[];
    selectedKey?: string | null;
    disabled?: boolean;
    onPick: (model: ModelMode, engine?: SwitchableEngine) => void;
    onBack: () => void;
}) {
    const { theme } = useUnistyles();
    const listStyle = useDrillIn(14, true);
    const [browsedEngine, setBrowsedEngine] = React.useState<SwitchableEngine | undefined>(() => props.groups?.find(group => group.current)?.engine);
    const visibleGroup = props.groups?.find(group => group.engine === browsedEngine) ?? props.groups?.[0];
    const sections: { key: string; title: string | null; hint: string | null; icon?: React.ReactNode; models: ModelMode[] }[] = props.groups
        ? (visibleGroup ? [visibleGroup] : []).map((group) => ({
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
            {!!props.groups && (
                <View style={styles.engineTabs}>
                    {props.groups.map(group => (
                        <Pressable
                            key={group.engine}
                            accessibilityRole="tab"
                            accessibilityLabel={group.label}
                            accessibilityState={{ selected: visibleGroup?.engine === group.engine }}
                            onPress={() => { hapticsLight(); setBrowsedEngine(group.engine); }}
                            style={({ pressed }) => [styles.engineTab, {
                                backgroundColor: visibleGroup?.engine === group.engine ? theme.colors.surfacePressed : 'transparent',
                                opacity: pressed ? 0.6 : 1,
                            }]}
                        >
                            <ProviderIcon kind={group.engine} size={13} />
                            <Text style={styles.engineTabText}>{group.label}</Text>
                        </Pressable>
                    ))}
                </View>
            )}
            <PickerMenuDivider />
            {sections.map((section, at) => (
                <React.Fragment key={section.key}>
                    {at > 0 && <PickerMenuDivider />}
                    {!!section.title && <PickerMenuSectionHeader title={section.title} hint={section.hint} icon={section.icon} />}
                    {section.models.map((model) => (
                        <PickerMenuRow
                            key={`${section.key}:${model.key}`}
                            label={model.name}
                            description={section.title ? undefined : model.description}
                            selected={props.selectedKey === model.key && (!props.groups || props.groups.find(g => g.engine === section.key)?.current === true)}
                            disabled={props.disabled || model.disabled}
                            leading={model.providerName ? <ProviderIcon kind={model.providerKind} size={13} /> : undefined}
                            trailing={model.supportsFastMode ? (
                                <Ionicons
                                    name="flash-outline"
                                    size={12}
                                    color={theme.dark ? '#FBBF24' : '#D97706'}
                                    style={{ opacity: 0.72 }}
                                />
                            ) : undefined}
                            onPress={() => props.onPick(model, props.groups ? section.key as SwitchableEngine : undefined)}
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
    engineTabs: { flexDirection: 'row', flexWrap: 'wrap', gap: 4, paddingHorizontal: 6, paddingBottom: 4 },
    engineTab: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 9, paddingVertical: 8, borderRadius: 10 },
    engineTabText: { fontSize: 13, lineHeight: 18, color: theme.colors.text, ...Typography.default('semiBold') },
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
    modelName: { fontSize: 15, lineHeight: 22, color: theme.colors.text, ...Typography.default('semiBold') },
    modelEngine: { fontSize: 12, lineHeight: 22, color: theme.colors.textSecondary, flexShrink: 1, ...Typography.default() },
    fastRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        minHeight: 46,
        paddingHorizontal: 10,
        paddingVertical: 7,
        marginHorizontal: 6,
        marginTop: 6,
        borderRadius: 11,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: 'transparent',
        ...Platform.select({
            web: { cursor: 'pointer', userSelect: 'none' } as any,
            default: {},
        }),
    },
    fastRowDisabled: {
        opacity: 0.55,
        ...Platform.select({
            web: { cursor: 'not-allowed' } as any,
            default: {},
        }),
    },
    fastMedallion: {
        width: 28,
        height: 28,
        borderRadius: 9,
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
    },
    fastTextCol: {
        flex: 1,
        minWidth: 0,
        gap: 1,
    },
    fastTitleLine: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
    },
    fastTitle: {
        fontSize: 13,
        lineHeight: 18,
        color: theme.colors.text,
        ...Typography.default('semiBold'),
    },
    fastActivePill: {
        paddingHorizontal: 5,
        paddingVertical: 1,
        borderRadius: 5,
    },
    fastActivePillText: {
        fontSize: 9.5,
        lineHeight: 12,
        letterSpacing: 0.5,
        ...Typography.default('semiBold'),
    },
    fastSubtitle: {
        fontSize: 11,
        lineHeight: 15,
        color: theme.colors.textSecondary,
        ...Typography.default(),
    },
    fastSwitchTrack: {
        width: 46,
        height: 26,
        borderRadius: 13,
        padding: 2,
        justifyContent: 'center',
        flexShrink: 0,
    },
    fastSwitchTrackActive: Platform.select({
        web: { boxShadow: '0 0 10px rgba(245, 158, 11, 0.32)' } as any,
        default: {},
    }),
    fastSwitchThumb: {
        width: 22,
        height: 22,
        borderRadius: 11,
        alignItems: 'center',
        justifyContent: 'center',
        ...Platform.select({
            web: { boxShadow: '0 1px 4px rgba(0,0,0,0.18)' },
            default: { shadowColor: '#000', shadowOpacity: 0.18, shadowRadius: 3, shadowOffset: { width: 0, height: 1 }, elevation: 2 },
        }),
    },
    backRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 5,
        minHeight: 34,
        paddingLeft: 4,
        paddingRight: 10,
        marginHorizontal: 6,
        marginTop: 2,
        borderRadius: 10,
    },
    backLabel: { fontSize: 13.5, lineHeight: 22, color: theme.colors.text, ...Typography.default('semiBold') },
}));
