import * as React from 'react';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';
import { getProviderIconKind } from '@/sync/rig';

const providerImages = {
    codex: require('@/assets/images/icon-gpt.png'),
    claude: require('@/assets/images/icon-claude.png'),
} as const;

export function ProviderIcon({ kind, size = 14 }: { kind?: string | null; size?: number }) {
    const { theme } = useUnistyles();
    const mapped = getProviderIconKind(kind);
    if (mapped === 'codex' || mapped === 'claude') {
        return (
            <Image
                source={providerImages[mapped]}
                style={{ width: size, height: size }}
                contentFit="contain"
                // Each mark keeps its own colour. OpenAI's is black, which
                // disappears on a dark surface — so there it becomes the white
                // mark OpenAI itself uses on dark, not a greyed-out version.
                tintColor={mapped === 'codex' && theme.dark ? theme.colors.text : undefined}
            />
        );
    }
    const icon = mapped === 'grok'
        ? 'flash-outline'
        : mapped === 'kimi'
            ? 'moon-outline'
            : 'sparkles-outline';
    return <Ionicons name={icon} size={size} color={theme.colors.textSecondary} />;
}
