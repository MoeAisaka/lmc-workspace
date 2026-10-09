import * as React from 'react';
import { Platform } from 'react-native';
import { useLocalSetting } from '@/sync/storage';
import { effectiveMotion } from '@/sync/personalization';

export function usePersonalizationMotion() {
    const value = useLocalSetting('personalization');
    const [reduced, setReduced] = React.useState(() => Platform.OS === 'web' && typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
    React.useEffect(() => {
        if (Platform.OS !== 'web') return;
        const query = window.matchMedia?.('(prefers-reduced-motion: reduce)');
        if (!query) return;
        const changed = () => setReduced(query.matches);
        changed();
        query.addEventListener?.('change', changed);
        return () => query.removeEventListener?.('change', changed);
    }, []);
    return effectiveMotion(Platform.OS === 'web' ? value.motion : 'full', reduced);
}
