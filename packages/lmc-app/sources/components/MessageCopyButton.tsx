import * as React from 'react';
import { Pressable, type StyleProp, type ViewStyle } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Modal } from '@/modal';
import { t } from '@/text';

// Keep the transcript glyph small while giving fingers a wider touch target.
const COPY_HIT_SLOP = { top: 14, bottom: 14, left: 14, right: 20 };

export function MessageCopyButton(props: {
    text?: string;
    compact?: boolean;
    style?: StyleProp<ViewStyle>;
}) {
    const { theme } = useUnistyles();
    const [copied, setCopied] = React.useState(false);
    const resetTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

    React.useEffect(() => {
        setCopied(false);
        return () => {
            if (resetTimerRef.current) clearTimeout(resetTimerRef.current);
        };
    }, [props.text]);

    const handleCopy = React.useCallback(async () => {
        if (!props.text) return;
        try {
            if (!await Clipboard.setStringAsync(props.text)) throw new Error('Clipboard write failed');
            setCopied(true);
            if (resetTimerRef.current) clearTimeout(resetTimerRef.current);
            resetTimerRef.current = setTimeout(() => setCopied(false), 1500);
        } catch (error) {
            console.error('Failed to copy message:', error);
            Modal.alert(t('markdown.copyFailed'), t('textSelection.failedToCopy'));
        }
    }, [props.text]);

    return (
        <Pressable
            accessibilityRole="button"
            accessibilityLabel={copied ? t('common.copied') : t('common.copy')}
            accessibilityHint={!props.text ? t('textSelection.noTextToCopy') : undefined}
            disabled={!props.text}
            hitSlop={props.compact ? 4 : COPY_HIT_SLOP}
            onPress={handleCopy}
            style={({ pressed }) => [
                styles.action,
                props.compact && styles.compact,
                props.style,
                (pressed || !props.text) && styles.dimmed,
            ]}
        >
            <Ionicons
                name={copied ? 'checkmark' : 'copy-outline'}
                size={props.compact ? 15 : 16}
                color={props.compact ? theme.colors.textSecondary : theme.colors.text}
            />
        </Pressable>
    );
}

const styles = StyleSheet.create({
    action: {
        alignSelf: 'flex-start',
        height: 20,
        justifyContent: 'center',
    },
    compact: {
        alignSelf: 'center',
        alignItems: 'center',
        width: 26,
        height: 26,
        borderRadius: 8,
        flexShrink: 0,
    },
    dimmed: {
        opacity: 0.5,
    },
});
