import * as React from 'react';

/**
 * When true, Item / ItemGroup / ItemList render as flat ChatGPT-style rows
 * (hairline dividers, no grouped cards) so the existing settings screens fit
 * inside the LMC settings dialog without being rewritten.
 */
export const FlatSettingsContext = React.createContext(false);
export const useFlatSettings = () => React.useContext(FlatSettingsContext);
