import { useSyncExternalStore } from 'react';
import { Platform, useWindowDimensions } from 'react-native';
import { readBrowserLayoutWidth, subscribeBrowserLayoutViewport } from '@/utils/browserLayoutViewport';

const emptySubscribe = () => () => {};
const serverWidth = () => 0;

/** Keep keyboard-sensitive height, but use the layout viewport for web columns. */
export function useLayoutWindowDimensions() {
    const dimensions = useWindowDimensions();
    const web = Platform.OS === 'web';
    const width = useSyncExternalStore(
        web ? subscribeBrowserLayoutViewport : emptySubscribe,
        web ? readBrowserLayoutWidth : serverWidth,
        serverWidth,
    );
    return web && width > 0 ? { ...dimensions, width } : dimensions;
}
