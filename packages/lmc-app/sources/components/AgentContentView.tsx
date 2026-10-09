import { useHeaderHeight } from '@/utils/responsive';
import * as React from 'react';
import { LayoutChangeEvent, Platform, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { ScrollView } from 'react-native-gesture-handler';
import { useKeyboardState } from 'react-native-keyboard-controller';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useUnistyles } from 'react-native-unistyles';
import { installWebComposerViewport } from '@/utils/webComposerViewport';

interface AgentContentViewProps {
    input?: React.ReactNode | null;
    content?: React.ReactNode | null;
    placeholder?: React.ReactNode | null;
    /** Keep the composer as an overlay while the chat scrolls beneath it. */
    floatingDock?: boolean;
    /** Measured visual inset that the inverted chat list reserves at its bottom. */
    onDockInsetChange?: (inset: number) => void;
}

export const AgentContentView: React.FC<AgentContentViewProps> = React.memo(({
    input,
    content,
    placeholder,
    floatingDock = false,
    onDockInsetChange,
}) => {
    const { theme } = useUnistyles();
    // Fade into the chat surface instead of painting black bands over the
    // desktop's graphite background. Native retains its black surface.
    const darkFadeRgb = Platform.OS === 'web' ? '33, 33, 33' : '0, 0, 0';
    const safeArea = useSafeAreaInsets();
    const headerHeight = useHeaderHeight();
    const state = useKeyboardState();
    const keyboardInset = state.isVisible ? Math.max(0, state.height - safeArea.bottom) : 0;
    const [dockHeight, setDockHeight] = React.useState(0);
    const containerRef = React.useRef<View>(null);
    const webDock = Platform.OS === 'web' && floatingDock;
    React.useEffect(() => {
        if (webDock && containerRef.current) {
            return installWebComposerViewport(containerRef.current as unknown as HTMLElement);
        }
    }, [webDock]);
    const dockBottom = (extra: number) => webDock
        ? `calc(var(--lmc-keyboard-inset, 0px) + ${extra}px)` as unknown as number
        : keyboardInset + extra;
    // The compact card stays where its field is anchored (owner's choice,
    // v300): iOS WebKit insists on the caret sitting above the keyboard by a
    // browser-specific strip, so the card may end that far above the keyboard.

    const handleDockLayout = React.useCallback((event: LayoutChangeEvent) => {
        const nextHeight = Math.ceil(event.nativeEvent.layout.height);
        setDockHeight((currentHeight) => (
            Math.abs(currentHeight - nextHeight) < 1 ? currentHeight : nextHeight
        ));
    }, []);

    React.useEffect(() => {
        onDockInsetChange?.(floatingDock ? dockHeight + keyboardInset + safeArea.bottom : 0);
    }, [dockHeight, floatingDock, keyboardInset, onDockInsetChange, safeArea.bottom]);

    if (floatingDock) {
        return (
            <View ref={containerRef} style={{ flexBasis: 0, flexGrow: 1 }}>
                {content && (
                    <View style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: webDock ? dockBottom(0) : 0 }}>
                        {content}
                    </View>
                )}
                {placeholder && (
                    <ScrollView
                        style={{
                            position: 'absolute',
                            top: safeArea.top + headerHeight,
                            left: 0,
                            right: 0,
                            bottom: dockBottom(dockHeight + safeArea.bottom),
                        }}
                        contentContainerStyle={{ alignItems: 'center', justifyContent: 'center', flex: 1 }}
                        keyboardShouldPersistTaps="handled"
                        alwaysBounceVertical={false}
                    >
                        {placeholder}
                    </ScrollView>
                )}
                {dockHeight > 0 && (
                    <View
                        {...(Platform.OS === 'web' ? {dataSet: {lmcChromeFade: 'true'}} : {})}
                        pointerEvents="none"
                        style={{
                            position: 'absolute',
                            left: 0,
                            right: 0,
                            bottom: dockBottom(0),
                            height: dockHeight + safeArea.bottom + 28,
                            zIndex: 1,
                        }}
                    >
                        <LinearGradient
                            colors={theme.dark
                                ? [`rgba(${darkFadeRgb}, 0)`, `rgba(${darkFadeRgb}, 0.20)`, `rgba(${darkFadeRgb}, 0.66)`]
                                : ['rgba(255, 255, 255, 0)', 'rgba(255, 255, 255, 0.18)', 'rgba(255, 255, 255, 0.74)']}
                            locations={[0, 0.42, 1]}
                            start={{ x: 0.5, y: 0 }}
                            end={{ x: 0.5, y: 1 }}
                            style={{ flex: 1 }}
                        />
                    </View>
                )}
                <View
                    onLayout={handleDockLayout}
                    pointerEvents="box-none"
                    style={{
                        position: 'absolute',
                        left: 0,
                        right: 0,
                        bottom: dockBottom(safeArea.bottom),
                        zIndex: 2,
                    }}
                >
                    {input}
                </View>
                {webDock && (
                    // iOS WebKit can pan the page past the document end while
                    // revealing the caret. The dock keeps its document position
                    // (moving it back down provokes the next reveal); this
                    // backdrop covers the exposed strip below the body instead.
                    <View
                        {...({ dataSet: { lmcDockBackdrop: 'true' } } as object)}
                        pointerEvents="none"
                        style={{
                            position: 'absolute',
                            left: 0,
                            right: 0,
                            top: '100%',
                            height: 'var(--lmc-dock-extension, 0px)' as unknown as number,
                            backgroundColor: theme.colors.surface,
                            zIndex: 1,
                        }}
                    />
                )}
            </View>
        );
    }

    return (
        <View style={{ flexBasis:0, flexGrow:1, paddingBottom: keyboardInset }}>
            <View style={{ flexBasis:0, flexGrow:1 }}>
                {content && (
                    <View style={[{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }]}>
                        {content}
                    </View>
                )}
                {placeholder && (
                    <ScrollView
                        style={[{ position: 'absolute', top: safeArea.top + headerHeight, left: 0, right: 0, bottom: 0 }]}
                        contentContainerStyle={{ alignItems: 'center', justifyContent: 'center', flex: 1 }}
                        keyboardShouldPersistTaps="handled"
                        alwaysBounceVertical={false}
                    >
                        {placeholder}
                    </ScrollView>
                )}
            </View>
            <View>
                {input}
            </View>
        </View>
    );
});

// const FallbackKeyboardAvoidingView: React.FC<AgentContentViewProps> = React.memo(({
//     children,
// }) => {
    
// });
