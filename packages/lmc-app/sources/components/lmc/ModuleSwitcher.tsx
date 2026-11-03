import * as React from 'react';
import { Platform } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { useOptionalAuth } from '@/auth/AuthContext';
import { accountList, accountMe, type LmcAccount } from '@/sync/apiAccounts';
import { hubShellAsset } from './hubShellAsset';

/**
 * Only the founding enabled admin account owns the personal hub launcher;
 * invited members and any later-promoted admins never mount or load it.
 */
export function isPrimaryOwnerAccount(self: LmcAccount, accounts: readonly LmcAccount[]): boolean {
    if (!self.enabled || self.role !== 'admin') {
        return false;
    }
    const primaryAdmin = accounts.find((account) => account.enabled && account.role === 'admin');
    return primaryAdmin?.id === self.id;
}

function removeSwitcherElements() {
    if (typeof document === 'undefined') return;
    document.querySelectorAll?.('hub-module-switcher').forEach((node) => node.remove());
}

/** Shared web navigation lives outside the chat tree and does no input work. */
export function ModuleSwitcher() {
    const { theme } = useUnistyles();
    const auth = useOptionalAuth();
    const token = auth?.isAuthenticated ? auth.credentials?.token ?? null : null;
    const [allowed, setAllowed] = React.useState(false);

    React.useEffect(() => {
        if (Platform.OS !== 'web' || !token) {
            setAllowed(false);
            removeSwitcherElements();
            return;
        }
        let cancelled = false;
        setAllowed(false);
        void (async () => {
            try {
                const me = await accountMe();
                if (cancelled) return;
                if (!me.account.enabled || me.account.role !== 'admin') {
                    setAllowed(false);
                    return;
                }
                const list = await accountList();
                if (cancelled) return;
                setAllowed(isPrimaryOwnerAccount(me.account, list.accounts));
            } catch {
                if (!cancelled) {
                    setAllowed(false);
                }
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [token]);

    React.useEffect(() => {
        if (Platform.OS !== 'web') return;
        if (!allowed) {
            removeSwitcherElements();
            return;
        }
        removeSwitcherElements();
        const host = document.createElement('hub-module-switcher');
        host.setAttribute('module', 'lmc');
        // The character's images are deployed with the site, not kept in the repository; without them the plain ball shows.
        host.setAttribute('pet', '/pets/kurisu');
        document.body.append(host);
        if (!document.getElementById('hub-shell-script')) {
            const script = document.createElement('script');
            script.id = 'hub-shell-script';
            script.src = `/hub-assets/${hubShellAsset}.js`;
            script.async = true;
            document.head.append(script);
        }
        return () => {
            host.remove();
        };
    }, [allowed]);

    React.useLayoutEffect(() => {
        if (Platform.OS !== 'web' || typeof document === 'undefined') return;
        if (allowed) {
            document.documentElement.dataset.hubAppearance = theme.dark ? 'dark' : 'light';
        } else if (document.documentElement?.dataset) {
            delete document.documentElement.dataset.hubAppearance;
        }
    }, [allowed, theme.dark]);

    return null;
}
