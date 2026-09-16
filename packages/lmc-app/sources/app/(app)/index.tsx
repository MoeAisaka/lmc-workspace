import React from 'react';
import { ActivityIndicator, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useIsFocused } from '@react-navigation/native';
import { useUnistyles } from 'react-native-unistyles';
import { useAuth } from '@/auth/AuthContext';
import { LmcLogin } from '@/components/LmcLogin';
import { storage, useIsDataReady } from '@/sync/storage';
import { getSessionActivityAt } from '@/utils/sessionActivity';
import { isArchivedForList } from '@/utils/lmc/deviceEngineGroups';

/**
 * LMC lands directly in a session: the list is a floating drawer (phone) or
 * the sidebar (desktop), never a page of its own. The most recently active
 * live session wins; with nothing to resume, the new-session screen opens.
 *
 * The redirect runs once each time this screen gains focus and reads the
 * store at that moment. It deliberately does not subscribe to the sessions
 * array: this screen stays mounted under the session stack, and following
 * every activity update would drag the user to whichever session just spoke.
 */
function LmcHome() {
    const router = useRouter();
    const { theme } = useUnistyles();
    const ready = useIsDataReady();
    const focused = useIsFocused();
    const redirected = React.useRef(false);
    React.useEffect(() => {
        if (!focused) { redirected.current = false; return; }
        if (!ready || redirected.current) return;
        redirected.current = true;
        const sessions = Object.values(storage.getState().sessions).filter((s) => !s.metadata?.isSideChat && !isArchivedForList(s));
        const latest = sessions.sort((a, b) => getSessionActivityAt(b) - getSessionActivityAt(a))[0];
        router.replace(latest ? `/session/${encodeURIComponent(latest.id)}` : '/new');
    }, [focused, ready, router]);
    return (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: theme.colors.surface }}>
            <ActivityIndicator size="small" color={theme.colors.textSecondary} />
        </View>
    );
}

export default function Home() { return useAuth().isAuthenticated ? <LmcHome /> : <LmcLogin />; }
