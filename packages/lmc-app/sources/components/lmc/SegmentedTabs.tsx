import * as React from 'react';
import { Platform, View } from 'react-native';
import Animated, { Easing, ReduceMotion, useAnimatedStyle, useDerivedValue, withTiming } from 'react-native-reanimated';
import { useUnistyles } from 'react-native-unistyles';
import { InteractionPressable } from '@/components/InteractionPressable';
import { Text } from '@/components/StyledText';
import { usePersonalizationMotion } from '@/hooks/usePersonalizationMotion';
import { motionDuration } from '@/sync/personalization';

type Tab<T extends string> = { value: T; label: string; accessibilityLabel?: string; leading?: React.ReactNode };
type Panel<T extends string> = { value: T; children: React.ReactNode };

/** A single moving selection surface, with stable button hit areas. */
export function SegmentedTabs<T extends string>({ items, selected, onSelect, idPrefix, testID }: {
    items: Tab<T>[];
    selected: T;
    onSelect: (value: T) => void;
    idPrefix?: string;
    testID?: string;
}) {
    const { theme } = useUnistyles();
    const motion = usePersonalizationMotion();
    const [width, setWidth] = React.useState(0);
    const refs = React.useRef<Array<View | null>>([]);
    const index = Math.max(0, items.findIndex(item => item.value === selected));
    const segmentWidth = Math.max(0, (width - 6 - 4 * (items.length - 1)) / items.length);
    const progress = useDerivedValue(() => withTiming(index, {
        duration: motionDuration(motion, 200), easing: Easing.out(Easing.cubic), reduceMotion: ReduceMotion.System,
    }), [index, motion]);
    const indicatorStyle = useAnimatedStyle(() => ({ transform: [{ translateX: progress.value * (segmentWidth + 4) }] }));

    const keyDown = (event: React.KeyboardEvent, current: number) => {
        let next: number;
        if (event.key === 'ArrowRight') next = (current + 1) % items.length;
        else if (event.key === 'ArrowLeft') next = (current - 1 + items.length) % items.length;
        else if (event.key === 'Home') next = 0;
        else if (event.key === 'End') next = items.length - 1;
        else return;
        event.preventDefault();
        refs.current[next]?.focus();
        onSelect(items[next].value);
    };

    return <View accessibilityRole="tablist" testID={testID} onLayout={event => setWidth(event.nativeEvent.layout.width)}
        style={{ flexDirection: 'row', gap: 4, padding: 3, borderRadius: 12, backgroundColor: theme.colors.surfaceHigh }}>
        <Animated.View pointerEvents="none" testID={testID ? `${testID}-indicator` : undefined}
            style={[{ position: 'absolute', left: 3, top: 3, bottom: 3, width: segmentWidth, borderRadius: 9, backgroundColor: theme.colors.surface }, indicatorStyle]} />
        {items.map((item, i) => <InteractionPressable key={item.value} ref={node => { refs.current[i] = node; }}
            nativeID={idPrefix ? `${idPrefix}-tab-${item.value}` : undefined}
            accessibilityRole="tab" accessibilityLabel={item.accessibilityLabel ?? item.label} accessibilityState={{ selected: selected === item.value }}
            {...(Platform.OS === 'web' ? {
                'aria-selected': selected === item.value,
                'aria-controls': idPrefix ? `${idPrefix}-panel-${item.value}` : undefined,
                tabIndex: selected === item.value ? 0 : -1,
                onKeyDown: (event: React.KeyboardEvent) => keyDown(event, i),
            } : {})}
            onPress={() => onSelect(item.value)}
            style={{ flex: 1, minWidth: 0, flexDirection: 'row', gap: 4, minHeight: 38, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 12, paddingVertical: 8, borderRadius: 9 }}>
            {item.leading}
            <Text style={{ fontSize: 13, color: theme.colors.text, fontWeight: selected === item.value ? '600' : '400' }}>{item.label}</Text>
        </InteractionPressable>)}
    </View>;
}

/** Web panes share one intrinsic grid track, reserving the taller pane's height. */
export function StableTabPanels<T extends string>({ items, selected, idPrefix, testID }: {
    items: Panel<T>[];
    selected: T;
    idPrefix: string;
    testID?: string;
}) {
    const motion = usePersonalizationMotion();
    const index = Math.max(0, items.findIndex(item => item.value === selected));
    if (Platform.OS !== 'web') return <View>{items[index]?.children}</View>;
    return <div data-testid={testID} style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', alignItems: 'start', minWidth: 0, overflow: 'hidden' }}>
        {items.map((item, i) => <div key={item.value} id={`${idPrefix}-panel-${item.value}`} role="tabpanel" aria-labelledby={`${idPrefix}-tab-${item.value}`}
            aria-hidden={selected !== item.value} inert={selected !== item.value}
            style={{ gridArea: '1 / 1', width: '100%', minWidth: 0, boxSizing: 'border-box', pointerEvents: selected === item.value ? 'auto' : 'none',
                transform: `translateX(${(i - index) * 100}%)`, transition: `transform ${motionDuration(motion, 200)}ms cubic-bezier(.215,.61,.355,1)` }}>
            {item.children}
        </div>)}
    </div>;
}
