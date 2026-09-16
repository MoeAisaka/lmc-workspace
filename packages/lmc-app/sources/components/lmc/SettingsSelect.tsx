import * as React from 'react';
import { Platform, Pressable, ScrollView, View, type LayoutChangeEvent } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import Animated, { Easing, runOnJS, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Text } from '@/components/StyledText';
import { Typography } from '@/constants/Typography';
import { PickerMenuRow, PickerMenuTitle } from './PickerMenu';
import { lmcElevation, lmcSurfaceBorder } from './elevation';
import { t } from '@/text';

/**
 * A settings value that opens its choices in a floating menu.
 *
 * Settings used to spend a row per option: picking a language meant a page of
 * two rows, picking a model meant the row expanding into eight. The value a
 * setting holds is what you read the list for, so the row shows the value and
 * the alternatives arrive over the list only while you are choosing.
 *
 * The menu is drawn by the nearest `SettingsMenuHost` rather than by the row,
 * because the row lives inside a scrolling, rounded, clipping list — anything
 * it renders itself is cut off at the row's edges.
 */

export interface SelectOption<T> {
    value: T;
    label: string;
    description?: string | null;
    disabled?: boolean;
    /** A swatch or glyph shown before the label — a colour needs showing, not naming. */
    leading?: React.ReactNode;
}

interface OpenMenu {
    x: number;
    y: number;
    width: number;
    height: number;
    title?: string;
    options: SelectOption<any>[];
    value: any;
    onSelect: (value: any) => void;
}

interface MenuController {
    open: (anchor: { x: number; y: number; width: number; height: number }, menu: Omit<OpenMenu, 'x' | 'y' | 'width' | 'height'>) => void;
    close: () => void;
}

const SettingsMenuContext = React.createContext<MenuController | null>(null);

const MENU_MIN_WIDTH = 200;
const MENU_MAX_WIDTH = 320;
const MENU_MAX_HEIGHT = 340;
const GAP = 6;
const EDGE = 8;

const styles = StyleSheet.create((theme) => ({
    host: { flex: 1, minHeight: 0 },
    trigger: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
        maxWidth: 220,
        minHeight: 30,
        paddingLeft: 10,
        paddingRight: 6,
        borderRadius: 8,
    },
    triggerLabel: {
        flexShrink: 1,
        fontSize: 13.5,
        color: theme.colors.textSecondary,
        ...Typography.default(),
    },
    menu: {
        position: 'absolute',
        paddingVertical: 6,
        borderRadius: 14,
        backgroundColor: theme.colors.surface,
        ...lmcSurfaceBorder(theme),
        ...lmcElevation(theme, 3),
    },
}));

/**
 * Draws the menus opened by every `SettingsSelect` beneath it. Mount one around
 * whatever the menu should be able to cover — the settings dialog mounts its
 * own so the menu is not trapped under the dialog's own layer.
 */
export const SettingsMenuHost = React.memo(({ children }: { children: React.ReactNode }) => {
    const host = React.useRef<View>(null);
    const [size, setSize] = React.useState({ width: 0, height: 0 });
    const [menu, setMenu] = React.useState<OpenMenu | null>(null);

    const controller = React.useMemo<MenuController>(() => ({
        open: (anchor, config) => {
            // The anchor arrives in window coordinates; the menu is placed in
            // the host's, which is not the window when the host is a dialog.
            const place = (originX: number, originY: number) => setMenu({
                ...config,
                x: anchor.x - originX,
                y: anchor.y - originY,
                width: anchor.width,
                height: anchor.height,
            });
            const node = host.current;
            if (node?.measureInWindow) node.measureInWindow((x, y) => place(x, y));
            else place(0, 0);
        },
        close: () => setMenu(null),
    }), []);

    return (
        <SettingsMenuContext.Provider value={controller}>
            <View
                ref={host}
                collapsable={false}
                style={styles.host}
                onLayout={(event: LayoutChangeEvent) => {
                    const { width, height } = event.nativeEvent.layout;
                    setSize((current) => (current.width === width && current.height === height ? current : { width, height }));
                }}
            >
                {children}
                {menu && <SettingsMenuLayer menu={menu} host={size} onClose={controller.close} />}
            </View>
        </SettingsMenuContext.Provider>
    );
});

function SettingsMenuLayer({ menu, host, onClose }: { menu: OpenMenu; host: { width: number; height: number }; onClose: () => void }) {
    const [menuHeight, setMenuHeight] = React.useState(0);
    const [closing, setClosing] = React.useState(false);
    const progress = useSharedValue(0);

    React.useEffect(() => {
        progress.value = withTiming(1, { duration: 150, easing: Easing.out(Easing.cubic) });
    }, [progress]);

    const dismiss = React.useCallback(() => {
        if (closing) return;
        setClosing(true);
        progress.value = withTiming(0, { duration: 110, easing: Easing.in(Easing.cubic) }, (done) => {
            if (done) runOnJS(onClose)();
        });
    }, [closing, onClose, progress]);

    // Escape closes it the same way clicking away does.
    React.useEffect(() => {
        if (Platform.OS !== 'web') return;
        const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') dismiss(); };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
    }, [dismiss]);

    const width = Math.min(MENU_MAX_WIDTH, Math.max(MENU_MIN_WIDTH, menu.width, host.width - EDGE * 2));
    // Right-aligned to the value it replaces, so the chosen option lands under
    // the word it changes.
    const left = Math.max(EDGE, Math.min(menu.x + menu.width - width, Math.max(EDGE, host.width - width - EDGE)));
    const below = menu.y + menu.height + GAP;
    const fitsBelow = menuHeight === 0 || below + menuHeight <= host.height - EDGE;
    const top = fitsBelow
        ? below
        : Math.max(EDGE, menu.y - GAP - menuHeight);

    const style = useAnimatedStyle(() => ({
        opacity: progress.value,
        transform: [{ translateY: (1 - progress.value) * (fitsBelow ? -6 : 6) }],
    }));

    return (
        <View style={StyleSheet.absoluteFillObject}>
            <Pressable
                accessibilityRole="button"
                accessibilityLabel={t('lmc.menu.close')}
                onPress={dismiss}
                style={StyleSheet.absoluteFillObject}
            />
            <Animated.View
                style={[styles.menu, { left, top, width, maxHeight: MENU_MAX_HEIGHT }, style]}
                onLayout={(event) => {
                    const next = Math.ceil(event.nativeEvent.layout.height);
                    setMenuHeight((current) => (Math.abs(current - next) < 1 ? current : next));
                }}
            >
                {!!menu.title && <PickerMenuTitle>{menu.title}</PickerMenuTitle>}
                <ScrollView showsVerticalScrollIndicator={false} bounces={false}>
                    {menu.options.map((option, index) => (
                        <PickerMenuRow
                            key={`${String(option.value)}-${index}`}
                            label={option.label}
                            description={option.description}
                            disabled={option.disabled}
                            leading={option.leading}
                            selected={option.value === menu.value}
                            onPress={() => { menu.onSelect(option.value); dismiss(); }}
                        />
                    ))}
                </ScrollView>
            </Animated.View>
        </View>
    );
}

export function SettingsSelect<T>(props: {
    value: T;
    options: SelectOption<T>[];
    onChange: (value: T) => void;
    /** Small caps heading above the options; omit when the row's title says it. */
    title?: string;
    /** Shown when the value matches no option — a custom model id, say. */
    fallbackLabel?: string;
    disabled?: boolean;
}) {
    const { theme } = useUnistyles();
    const controller = React.useContext(SettingsMenuContext);
    const trigger = React.useRef<View>(null);
    const [hovered, setHovered] = React.useState(false);
    const hoverProps = Platform.OS === 'web'
        ? { onHoverIn: () => setHovered(true), onHoverOut: () => setHovered(false) }
        : {};

    const selected = props.options.find((option) => option.value === props.value);
    const label = selected?.label ?? props.fallbackLabel ?? String(props.value ?? '');

    return (
        <Pressable
            ref={trigger}
            accessibilityRole="button"
            accessibilityState={{ expanded: false, disabled: !!props.disabled }}
            accessibilityLabel={label}
            disabled={props.disabled || !controller}
            {...hoverProps}
            onPress={() => {
                trigger.current?.measureInWindow?.((x, y, width, height) => {
                    controller?.open({ x, y, width, height }, {
                        title: props.title,
                        options: props.options,
                        value: props.value,
                        onSelect: (value) => props.onChange(value as T),
                    });
                });
            }}
            style={({ pressed }) => [
                styles.trigger,
                (hovered || pressed) && !props.disabled && { backgroundColor: theme.colors.surfacePressed },
                props.disabled && { opacity: 0.45 },
            ]}
        >
            <Text style={styles.triggerLabel} numberOfLines={1}>{label}</Text>
            <Ionicons name="chevron-down" size={15} color={theme.colors.groupped.chevron} />
        </Pressable>
    );
}
