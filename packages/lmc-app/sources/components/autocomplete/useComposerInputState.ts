import * as React from 'react';
import type { TextInputState } from '../MultiTextInput';
import { findActiveWord } from './findActiveWord';

/** Keep the live caret/text available for insertion without rendering the whole
 * composer for ordinary typing or the duplicate select event after input. */
export function useComposerInputState(initialText: string, prefixes: string[]) {
    const inputState = React.useRef<TextInputState>({
        text: initialText,
        selection: { start: initialText.length, end: initialText.length },
    });
    const [activeWord, setActiveWord] = React.useState(() => (
        findActiveWord(initialText, inputState.current.selection, prefixes)?.activeWord ?? null
    ));
    const latestQuery = React.useRef(activeWord);
    const handleInputStateChange = React.useCallback((state: TextInputState) => {
        inputState.current = state;
        const query = findActiveWord(state.text, state.selection, prefixes)?.activeWord ?? null;
        if (query !== latestQuery.current) {
            latestQuery.current = query;
            React.startTransition(() => setActiveWord(query));
        }
    }, [prefixes]);
    React.useEffect(() => { handleInputStateChange(inputState.current); }, [handleInputStateChange]);
    return { inputState, activeWord, handleInputStateChange };
}
