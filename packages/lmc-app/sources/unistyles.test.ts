import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

// Native persistence and theme runtime are the side-effect boundaries. The
// bootstrap and its actual event listeners run unchanged for each case.
const state = vi.hoisted(() => ({
    preference: 'adaptive' as 'adaptive' | 'light' | 'dark',
    system: 'dark' as 'light' | 'dark',
    runtime: {
        themeName: 'dark',
        setTheme: vi.fn(),
        setAdaptiveThemes: vi.fn(),
        setRootViewBackgroundColor: vi.fn(),
    },
}));
vi.mock('react-native-unistyles', () => ({ StyleSheet: { configure: vi.fn() }, UnistylesRuntime: state.runtime }));
vi.mock('./theme', () => ({
    lightTheme: { colors: { groupped: { background: '#fff' } } },
    darkTheme: { colors: { groupped: { background: '#000' } } },
}));
vi.mock('./sync/persistence', () => ({ loadThemePreference: () => state.preference }));
vi.mock('react-native', () => ({ Platform: { OS: 'web' }, Appearance: { getColorScheme: () => state.system } }));
vi.mock('expo-system-ui', () => ({ setBackgroundColorAsync: vi.fn() }));

let documentEvents: EventTarget;
let mediaEvents: EventTarget;
const removeThemeClass = vi.fn();
beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    state.preference = 'adaptive';
    state.system = 'dark';
    state.runtime.themeName = 'dark';
    documentEvents = Object.assign(new EventTarget(), { visibilityState: 'visible', documentElement: { classList: { remove: removeThemeClass } } });
    mediaEvents = new EventTarget();
    vi.stubGlobal('document', documentEvents);
    vi.stubGlobal('window', { matchMedia: () => mediaEvents });
});
afterEach(() => vi.unstubAllGlobals());

describe('web theme resync uses the current preference', () => {
    it.each(['light', 'dark'] as const)('does not override an explicit %s selection after an adaptive startup', async (preference) => {
        await import('./unistyles');
        state.preference = preference;
        state.runtime.themeName = preference;
        state.system = preference === 'light' ? 'dark' : 'light';
        vi.clearAllMocks();

        documentEvents.dispatchEvent(new Event('visibilitychange'));
        mediaEvents.dispatchEvent(new Event('change'));

        expect(state.runtime.setTheme).not.toHaveBeenCalled();
        expect(state.runtime.setAdaptiveThemes).not.toHaveBeenCalled();
        expect(state.runtime.setRootViewBackgroundColor).not.toHaveBeenCalled();
        expect(removeThemeClass).not.toHaveBeenCalled();
    });

    it('resyncs after switching a fixed startup to adaptive', async () => {
        state.preference = 'light';
        await import('./unistyles');
        state.preference = 'adaptive';
        state.runtime.themeName = 'light';
        vi.clearAllMocks();

        mediaEvents.dispatchEvent(new Event('change'));

        expect(state.runtime.setTheme).toHaveBeenCalledWith('dark');
        expect(state.runtime.setRootViewBackgroundColor).toHaveBeenCalledWith('#000');
    });

    it('clears fixed CSS classes even when the adaptive runtime has already changed theme', async () => {
        await import('./unistyles');
        vi.clearAllMocks();
        // Unistyles has handled the media event, but switching to adaptive
        // left a fixed class behind. Matching runtime state is not enough.
        mediaEvents.dispatchEvent(new Event('change'));
        expect(removeThemeClass).toHaveBeenCalledWith('light', 'dark');
        expect(state.runtime.setRootViewBackgroundColor).toHaveBeenCalledWith('#000');
        expect(state.runtime.setTheme).not.toHaveBeenCalled();
    });
});
