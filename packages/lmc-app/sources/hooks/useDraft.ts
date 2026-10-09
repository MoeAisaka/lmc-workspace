import { useEffect, useLayoutEffect, useMemo, useRef, useCallback } from 'react';
import { AppState, AppStateStatus } from 'react-native';
import { storage } from '@/sync/storage';
import { useIsFocused } from '@react-navigation/native';

interface UseDraftOptions {
    autoSaveInterval?: number; // in milliseconds, default 2000
}

export function useDraft(
    sessionId: string | null | undefined,
    value: string,
    onChange: (value: string) => void,
    options: UseDraftOptions = {}
) {
    const { autoSaveInterval = 2000 } = options;
    const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    // Seed with the initial value so a pre-hydrated draft (e.g. ChatComposer
    // reads storage synchronously on mount) doesn't trip the autosave into
    // re-writing what we just loaded.
    // A session-scoped cell lets unmount/background handlers read the latest
    // committed draft without re-registering their cleanup on every keystroke.
    const state = useMemo(() => ({ value, lastSaved: value }), [sessionId]);
    useLayoutEffect(() => { state.value = value; }, [state, value]);
    const isFocused = useIsFocused();

    // Save draft to storage
    const saveDraft = useCallback((draft: string) => {
        if (!sessionId) return;
        
        storage.getState().updateSessionDraft(sessionId, draft);
        state.lastSaved = draft;
    }, [sessionId, state]);

    // Load draft on mount and when focused
    useEffect(() => {
        if (!sessionId || !isFocused) return;

        const session = storage.getState().sessions[sessionId];
        if (session?.draft && !value) {
            onChange(session.draft);
            state.lastSaved = session.draft;
        } else if (!session?.draft) {
            // Ensure lastSavedValue is empty if there's no draft
            state.lastSaved = '';
        }
    }, [sessionId, isFocused, onChange, state]);

    const flushDraft = useCallback(() => {
        if (state.value !== state.lastSaved) saveDraft(state.value);
    }, [state, saveDraft]);

    // Auto-save with smart debouncing
    useEffect(() => {
        if (!sessionId) return;

        // Clear any existing timeout
        if (saveTimeoutRef.current) {
            clearTimeout(saveTimeoutRef.current);
        }

        // Only save if value has changed
        if (value !== state.lastSaved) {
            const wasEmpty = !state.lastSaved.trim();
            const isEmpty = !value.trim();

            if (wasEmpty !== isEmpty) {
                // State transition: empty <-> non-empty
                // Save immediately for instant feedback
                saveDraft(value);
            } else if (!isEmpty) {
                // Text is being modified (non-empty to non-empty)
                // Debounce to avoid excessive saves
                saveTimeoutRef.current = setTimeout(flushDraft, autoSaveInterval);
            }
            // If both are empty, no need to save
        }

        return () => {
            if (saveTimeoutRef.current) {
                clearTimeout(saveTimeoutRef.current);
            }
        };
    }, [value, sessionId, autoSaveInterval, saveDraft, flushDraft, state]);

    // Save on app state change (background/inactive)
    useEffect(() => {
        if (!sessionId) return;

        const handleAppStateChange = (nextAppState: AppStateStatus) => {
            if (nextAppState === 'background' || nextAppState === 'inactive') {
                flushDraft();
            }
        };

        const subscription = AppState.addEventListener('change', handleAppStateChange);

        return () => {
            subscription.remove();
        };
    }, [sessionId, flushDraft]);

    // Save on unmount
    useEffect(() => {
        return () => {
            if (sessionId) flushDraft();
        };
    }, [sessionId, flushDraft]);

    // Clear draft (used after message is sent)
    const clearDraft = useCallback(() => {
        if (!sessionId) return;
        
        storage.getState().updateSessionDraft(sessionId, null);
        state.value = '';
        state.lastSaved = '';
        if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
    }, [sessionId, state]);

    return {
        clearDraft
    };
}
