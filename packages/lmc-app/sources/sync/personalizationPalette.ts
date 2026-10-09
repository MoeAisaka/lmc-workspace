import type { Theme } from '../theme';
import { accentColors, type Personalization } from './personalization';

// Derive from the immutable base so Classic restores all tokens. Status,
// permission and diff colors retain their existing meaning in either style.
export function personalizationPalette(base: Theme, value: Personalization): Theme['colors'] {
    const colors = base.colors;
    const accent = accentColors[value.accent][base.dark ? 'dark' : 'light'];
    const surface = base.dark ? '#11191D' : '#FAFCF9';
    const background = base.dark ? '#0C1215' : '#EDF2EC';
    const raised = base.dark ? '#19252A' : '#E7EEE6';
    const border = base.dark ? '#466258' : '#718575';
    const text = base.dark ? '#D9E7DC' : '#203729';
    const secondary = base.dark ? '#9BB4A6' : '#536B5A';
    return {
        ...colors,
        ...(value.chrome === 'terminal' ? {
            text, textSecondary: secondary, surface, surfaceHigh: raised, surfaceHighest: raised,
            surfacePressed: raised, surfaceSelected: raised, divider: border,
            processSurface: surface, processGroupBorder: border,
            agentMessageText: text, agentEventText: secondary,
            header: {...colors.header, background: surface, tint: text},
            groupped: {...colors.groupped, background, sectionTitle: secondary},
            input: {...colors.input, background: raised, text, placeholder: secondary},
            glass: {...colors.glass, background: surface, backgroundStrong: surface, backgroundSubtle: surface,
                overlay: background, overlayTint: surface, border, divider: border, highlight: 'transparent',
                shadow: 'transparent', tint: surface, backdrop: [background, background, background],
                glowPrimary: 'transparent', glowSecondary: 'transparent'},
        } : {}),
        textLink: value.accent === 'blue' ? colors.textLink : accent,
        switch: {...colors.switch, track: {...colors.switch.track, active: value.accent === 'blue' ? colors.switch.track.active : accent}},
        radio: {...colors.radio, active: value.accent === 'blue' ? colors.radio.active : accent, dot: value.accent === 'blue' ? colors.radio.dot : accent},
    };
}

// Semantic surfaces only: images, charts, status rings and hit targets keep
// their geometry. This is a visual style, with no shell or command behavior.
export const terminalChromeStyles = `
html[data-lmc-chrome="terminal"] :is([data-lmc-surface="panel"], [data-testid="lmc-settings-dialog"], [data-testid="settings-select-menu"]) {
    border-radius: 2px !important;
    border: 1px solid var(--lmc-terminal-border) !important;
    box-shadow: none !important;
    backdrop-filter: none !important;
}
html[data-lmc-chrome="terminal"] :is(button, [role="button"], [role="tab"], [data-lmc-chrome-surface], [data-lmc-resource-window], textarea, input:not([type="checkbox"]):not([type="radio"]), pre) {
    border-radius: 2px !important;
}
html[data-lmc-chrome="terminal"] [data-lmc-chrome-surface] { box-shadow: none !important; backdrop-filter: none !important; }
html[data-lmc-chrome="terminal"] [data-lmc-accent-action] { background-color: transparent !important; border: 1px solid var(--lmc-prose-accent) !important; }
html[data-lmc-chrome="terminal"] [data-lmc-accent-action] * { color: var(--lmc-prose-accent) !important; }
html[data-lmc-chrome="terminal"] :is([data-lmc-glow], [data-lmc-rainbow], [data-lmc-chrome-fade]) { display: none !important; }
html[data-lmc-chrome="terminal"] :is(button, [role="button"], a, input, textarea):focus-visible {
    outline: 2px solid var(--lmc-prose-accent); outline-offset: 2px;
}
`;
