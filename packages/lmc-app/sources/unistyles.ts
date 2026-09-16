import { StyleSheet, UnistylesRuntime } from 'react-native-unistyles';
import { darkTheme, lightTheme } from './theme';
import { loadThemePreference } from './sync/persistence';
import { Appearance, Platform } from 'react-native';
import * as SystemUI from 'expo-system-ui';

//
// Theme
//

const appThemes = {
    light: lightTheme,
    dark: darkTheme
};

const breakpoints = {
    xs: 0, // <-- make sure to register one breakpoint with value 0
    sm: 300,
    md: 500,
    lg: 800,
    xl: 1200
    // use as many breakpoints as you need
};

// Load theme preference from storage
const themePreference = loadThemePreference();

// Determine initial theme and adaptive settings
const getInitialTheme = (): 'light' | 'dark' => {
    if (themePreference === 'adaptive') {
        const systemTheme = Appearance.getColorScheme();
        return systemTheme === 'dark' ? 'dark' : 'light';
    }
    return themePreference;
};

const settings = themePreference === 'adaptive'
    ? {
        // When adaptive, let Unistyles handle theme switching automatically
        adaptiveThemes: true,
        CSSVars: true, // Enable CSS variables for web
    }
    : {
        // When fixed theme, set the initial theme explicitly
        initialTheme: getInitialTheme(),
        CSSVars: true, // Enable CSS variables for web
    };

//
// Bootstrap
//

type AppThemes = typeof appThemes
type AppBreakpoints = typeof breakpoints

declare module 'react-native-unistyles' {
    export interface UnistylesThemes extends AppThemes { }
    export interface UnistylesBreakpoints extends AppBreakpoints { }
}

StyleSheet.configure({
    settings,
    breakpoints,
    themes: appThemes,
})

// Set initial root view background color based on theme
const setRootBackgroundColor = () => {
    if (themePreference === 'adaptive') {
        const systemTheme = Appearance.getColorScheme();
        const color = systemTheme === 'dark' ? appThemes.dark.colors.groupped.background : appThemes.light.colors.groupped.background;
        UnistylesRuntime.setRootViewBackgroundColor(color);
        SystemUI.setBackgroundColorAsync(color);
    } else {
        const color = themePreference === 'dark' ? appThemes.dark.colors.groupped.background : appThemes.light.colors.groupped.background;
        UnistylesRuntime.setRootViewBackgroundColor(color);
        SystemUI.setBackgroundColorAsync(color);
    }
};

// Set initial background color
setRootBackgroundColor();

// Align the NATIVE appearance with the app theme. Unistyles only themes the
// React tree; UIKit keeps following the system, so with an explicit app theme
// everything native — SwiftUI composer menus, the keyboard, context menus —
// rendered in the other scheme (white-on-white chips on the light composer
// with a dark system). Adaptive resets the override back to the system.
if (Platform.OS !== 'web') {
    Appearance.setColorScheme(themePreference === 'adaptive' ? 'unspecified' : themePreference);
}

// Re-sync theme on web, where the Appearance API can miss a change.
//
// Visibility alone is not enough: a tab left open in the foreground across a
// scheduled light/dark switch never fires visibilitychange, so the media query
// is watched too. Both paths force the theme rather than trusting adaptive to
// have noticed.
if (Platform.OS === 'web' && themePreference === 'adaptive') {
    const resync = () => {
        const themeName = Appearance.getColorScheme() === 'dark' ? 'dark' : 'light';
        if (UnistylesRuntime.themeName === themeName) return;
        // Toggle adaptive off, set correct theme, toggle back on
        UnistylesRuntime.setAdaptiveThemes(false);
        UnistylesRuntime.setTheme(themeName);
        UnistylesRuntime.setAdaptiveThemes(true);
        UnistylesRuntime.setRootViewBackgroundColor(appThemes[themeName].colors.groupped.background);
    };
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') resync();
    });
    window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener?.('change', resync);
}