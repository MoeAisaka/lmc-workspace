import * as React from 'react';
import { Pressable, type View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';
import { t } from '@/text';
import { SessionActionsPopover, type SessionActionsAnchor } from './SessionActionsPopover';

/** Uses the same actions and visibility rules as the session list menu. */
export function SessionHeaderActions({ sessionId }: { sessionId: string }) {
    const { theme } = useUnistyles();
    const button = React.useRef<View>(null);
    const [anchor, setAnchor] = React.useState<SessionActionsAnchor | null>(null);
    return <>
        <Pressable ref={button} accessibilityRole="button" accessibilityLabel={t('localFeatures.sessionMenu')}
            accessibilityState={{ expanded: anchor !== null }}
            style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}
            onPress={() => button.current?.measureInWindow((x, y, width, height) => setAnchor({ type: 'rect', x, y, width, height }))}>
            <Ionicons name="ellipsis-horizontal" size={24} color={theme.colors.text} />
        </Pressable>
        <SessionActionsPopover sessionId={sessionId} anchor={anchor} visible={anchor !== null} onClose={() => setAnchor(null)} />
    </>;
}
