import * as React from 'react';
import { Platform } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { hubShellAsset } from './hubShellAsset';

/** Shared web navigation lives outside the chat tree and does no input work. */
export function ModuleSwitcher() {
    const { theme } = useUnistyles();
    React.useEffect(() => {
        if (Platform.OS !== 'web') return;
        const host = document.createElement('hub-module-switcher');
        host.setAttribute('module', 'lmc');
        // The character's images are deployed with the site, not kept in the repository; without them the plain ball shows.
        host.setAttribute('pet', '/pets/kurisu');
        document.body.append(host);
        if (!document.getElementById('hub-shell-script')) {
            const script = document.createElement('script');
            script.id = 'hub-shell-script'; script.src = `/hub-assets/${hubShellAsset}.js`;
            script.async = true; document.head.append(script);
        }
        return () => host.remove();
    }, []);
    React.useLayoutEffect(() => {
        if (Platform.OS === 'web') document.documentElement.dataset.hubAppearance = theme.dark ? 'dark' : 'light';
    }, [theme.dark]);
    return null;
}
