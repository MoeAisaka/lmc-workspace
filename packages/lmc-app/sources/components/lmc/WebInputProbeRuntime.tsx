import * as React from 'react';
import { Platform } from 'react-native';
import { useLocalSetting } from '@/sync/storage';
import { setWebInputProbeEnabled, webInputProbeQueryEnabled } from '@/utils/webInputProbeBootstrap';

export function WebInputProbeRuntime() {
    const enabled = useLocalSetting('devModeEnabled');
    React.useEffect(() => {
        if (Platform.OS !== 'web') return;
        setWebInputProbeEnabled(enabled || webInputProbeQueryEnabled());
        return () => setWebInputProbeEnabled(false);
    }, [enabled]);
    return null;
}
