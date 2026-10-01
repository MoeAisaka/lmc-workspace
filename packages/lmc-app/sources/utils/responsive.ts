import { Dimensions, Platform } from 'react-native';
import { useWindowDimensions } from 'react-native';
import { useMemo, useSyncExternalStore } from 'react';
import { calculateDeviceDimensions, determineDeviceType, calculateHeaderHeight } from './deviceCalculations';
import { isRunningOnMac } from './platform';

// Re-export calculation functions for use in other components
export { calculateDeviceDimensions, determineDeviceType, calculateHeaderHeight };

const WEB_TABLET_QUERY = '(min-width: 900px)';

function getWebTabletSnapshot(): boolean {
    return Platform.OS === 'web' && typeof window !== 'undefined'
        && window.matchMedia(WEB_TABLET_QUERY).matches;
}

function getServerTabletSnapshot(): boolean {
    return false;
}

function subscribeWebLayout(onChange: () => void): () => void {
    if (Platform.OS !== 'web' || typeof window === 'undefined') return () => {};

    // RN Web caches visualViewport dimensions. Rotation while the browser is
    // suspended can leave that cache wider than the actual CSS layout viewport.
    // A permanent drawer must follow the CSS breakpoint, including on restore.
    const query = window.matchMedia(WEB_TABLET_QUERY);
    const onVisible = () => {
        if (document.visibilityState !== 'hidden') onChange();
    };
    query.addEventListener('change', onChange);
    window.addEventListener('resize', onChange);
    window.addEventListener('pageshow', onChange);
    window.addEventListener('focus', onChange);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
        query.removeEventListener('change', onChange);
        window.removeEventListener('resize', onChange);
        window.removeEventListener('pageshow', onChange);
        window.removeEventListener('focus', onChange);
        document.removeEventListener('visibilitychange', onVisible);
    };
}

// Get header height based on platform, device type, and orientation (wrapper for backward compatibility)
export function getHeaderHeight(isLandscape: boolean, deviceType: 'phone' | 'tablet'): number {
    return calculateHeaderHeight({
        platform: Platform.OS,
        isLandscape,
        // @ts-ignore - isPad is not in the type definitions but exists at runtime on iOS
        isPad: Platform.OS === 'ios' ? Platform.isPad : undefined,
        deviceType: Platform.OS === 'android' ? deviceType : undefined,
        isMacCatalyst: isRunningOnMac()
    });
}

// Device type detection based on screen size and aspect ratio
export function getDeviceType(): 'phone' | 'tablet' {
    if (Platform.OS === 'web') return getWebTabletSnapshot() ? 'tablet' : 'phone';
    const { width, height } = Dimensions.get('screen');

    const dimensions = calculateDeviceDimensions({
        widthPoints: width,
        heightPoints: height,
        pointsPerInch: Platform.OS === 'ios' ? 163 : 160
    });

    return determineDeviceType({
        diagonalInches: dimensions.diagonalInches,
        platform: Platform.OS,
        // @ts-ignore - isPad is not in the type definitions but exists at runtime on iOS
        isPad: Platform.OS === 'ios' ? Platform.isPad : false
    });
}

// Hook to get device type (reactive to dimension changes)
export function useDeviceType(): 'phone' | 'tablet' {
    const { width, height } = useWindowDimensions();
    const webTablet = useSyncExternalStore(subscribeWebLayout, getWebTabletSnapshot, getServerTabletSnapshot);
    
    return useMemo(() => {
        if (Platform.OS === 'web') return webTablet ? 'tablet' : 'phone';
        const dimensions = calculateDeviceDimensions({
            widthPoints: width,
            heightPoints: height,
            pointsPerInch: Platform.OS === 'ios' ? 163 : 160
        });

        return determineDeviceType({
            diagonalInches: dimensions.diagonalInches,
            platform: Platform.OS,
            // @ts-ignore - isPad is not in the type definitions but exists at runtime on iOS
            isPad: Platform.OS === 'ios' ? Platform.isPad : false
        });
    }, [width, height, webTablet]);
}

// Hook to detect if device is tablet
export function useIsTablet(): boolean {
    const deviceType = useDeviceType();
    return deviceType === 'tablet';
}

// Hook to detect landscape orientation
export function useIsLandscape(): boolean {
    const { width, height } = useWindowDimensions();
    return width > height;
}

// Hook to get header height based on platform, device type, and orientation
export function useHeaderHeight(): number {
    const isLandscape = useIsLandscape();
    const deviceType = useDeviceType();
    
    return useMemo(() => {
        return calculateHeaderHeight({
            platform: Platform.OS,
            isLandscape,
            // @ts-ignore - isPad is not in the type definitions but exists at runtime on iOS
            isPad: Platform.OS === 'ios' ? Platform.isPad : undefined,
            deviceType: Platform.OS === 'android' ? deviceType : undefined,
            isMacCatalyst: isRunningOnMac()
        });
    }, [isLandscape, deviceType]);
}
