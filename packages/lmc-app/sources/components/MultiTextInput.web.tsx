import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { usesNativeWebKitKeyboardPan } from '@/utils/browserLayoutViewport';
import { KEYBOARD_EXPECTED_EVENT } from '@/utils/webComposerViewport';

export type SupportedKey = 'Enter' | 'Escape' | 'ArrowUp' | 'ArrowDown' | 'ArrowLeft' | 'ArrowRight' | 'Tab';

export interface KeyPressEvent {
    key: SupportedKey;
    shiftKey: boolean;
}

export type OnKeyPressCallback = (event: KeyPressEvent) => boolean;

export const MULTI_TEXT_INPUT_FONT_SIZE = 16;
export const MULTI_TEXT_INPUT_LINE_HEIGHT = 22;

export interface TextInputState {
    text: string;
    selection: {
        start: number;
        end: number;
    };
}

export interface MultiTextInputHandle {
    getText: () => string;
    setTextAndSelection: (text: string, selection: { start: number; end: number }) => void;
    focus: () => void;
    blur: () => void;
}

// Either `value` (controlled) or `defaultValue` (uncontrolled) must be set.
// Uncontrolled mode keeps the DOM textarea content out of React's reconciliation
// so keystrokes don't get batched and dropped on a busy main thread.
interface MultiTextInputProps {
    value?: string;
    defaultValue?: string;
    onChangeText?: (text: string) => void;
    placeholder?: string;
    maxHeight?: number;
    lineHeight?: number;
    paddingTop?: number;
    paddingBottom?: number;
    paddingLeft?: number;
    paddingRight?: number;
    onKeyPress?: OnKeyPressCallback;
    onSelectionChange?: (selection: { start: number; end: number }) => void;
    onStateChange?: (state: TextInputState) => void;
    /** Focus/blur of the underlying field; the composer collapses to a pill when unfocused and empty. */
    onFocusChange?: (focused: boolean) => void;
}

export const MultiTextInput = React.memo(React.forwardRef<MultiTextInputHandle, MultiTextInputProps>((props, ref) => {
    const {
        value,
        defaultValue,
        onChangeText,
        placeholder,
        maxHeight = 120,
        lineHeight = MULTI_TEXT_INPUT_LINE_HEIGHT,
        onKeyPress,
        onSelectionChange,
        onStateChange
    } = props;

    const isControlled = value !== undefined;
    const { theme } = useUnistyles();
    const textareaRef = React.useRef<HTMLTextAreaElement>(null);
    const mirrorRef = React.useRef<HTMLDivElement>(null);
    const composingRef = React.useRef(false);
    const touchRef = React.useRef<{ id: number; x: number; y: number } | null>(null);
    const [nativeSizing] = React.useState(() => typeof CSS !== 'undefined' && CSS.supports('field-sizing', 'content'));
    const maxRows = Math.floor(maxHeight / lineHeight);
    // Native field sizing performs no JavaScript geometry reads. Older engines
    // use a grid mirror with identical typography, without scrollHeight, style
    // measurement, a resize observer, or a React state update per key.
    const updateMirror = React.useCallback((text: string) => {
        if (mirrorRef.current) {
            // The final space preserves the height of a trailing empty line.
            mirrorRef.current.textContent = `${text || placeholder || ''} `;
        }
    }, [placeholder]);
    React.useLayoutEffect(() => { updateMirror(textareaRef.current?.value ?? ''); }, [value, defaultValue, updateMirror]);

    const focusWithoutScroll = React.useCallback((node: HTMLTextAreaElement) => {
        if (document.activeElement === node) return;
        // Mark before focusin, so keyboard avoidance and the native focus call
        // have the same owner. WebKit retains preventScroll in its focused
        // element information, suppressing its deferred zoom/reveal pass.
        if (usesNativeWebKitKeyboardPan()) node.dataset.lmcFocusScroll = 'controlled';
        node.focus({ preventScroll: true });
    }, []);

    const handleKeyDown = React.useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        if (!onKeyPress) return;

        const isComposing = composingRef.current || e.nativeEvent.isComposing || e.keyCode === 229;
        if (isComposing) {
            return;
        }

        const key = e.key;
        
        // Map browser key names to our normalized format
        let normalizedKey: SupportedKey | null = null;
        
        switch (key) {
            case 'Enter':
                normalizedKey = 'Enter';
                break;
            case 'Escape':
                normalizedKey = 'Escape';
                break;
            case 'ArrowUp':
                normalizedKey = 'ArrowUp';
                break;
            case 'ArrowDown':
                normalizedKey = 'ArrowDown';
                break;
            case 'ArrowLeft':
                normalizedKey = 'ArrowLeft';
                break;
            case 'ArrowRight':
                normalizedKey = 'ArrowRight';
                break;
            case 'Tab':
                normalizedKey = 'Tab';
                break;
        }

        if (normalizedKey) {
            const keyEvent: KeyPressEvent = {
                key: normalizedKey,
                shiftKey: e.shiftKey
            };
            
            const handled = onKeyPress(keyEvent);
            if (handled) {
                e.preventDefault();
            }
        }
    }, [onKeyPress]);

    const handleChange = React.useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
        const text = e.target.value;
        const selection = {
            start: e.target.selectionStart,
            end: e.target.selectionEnd
        };
        updateMirror(text);
        onChangeText?.(text);

        if (onStateChange) {
            onStateChange({ text, selection });
        }
        if (onSelectionChange) {
            onSelectionChange(selection);
        }
    }, [onChangeText, onStateChange, onSelectionChange, updateMirror]);

    const handleSelect = React.useCallback((e: React.SyntheticEvent<HTMLTextAreaElement>) => {
        const target = e.target as HTMLTextAreaElement;
        const selection = {
            start: target.selectionStart,
            end: target.selectionEnd
        };

        if (onSelectionChange) {
            onSelectionChange(selection);
        }
        if (onStateChange) {
            onStateChange({ text: target.value, selection });
        }
    }, [onSelectionChange, onStateChange]);

    // Imperative handle for direct control
    React.useImperativeHandle(ref, () => ({
        getText: () => textareaRef.current?.value ?? '',
        setTextAndSelection: (text: string, selection: { start: number; end: number }) => {
            if (textareaRef.current) {
                const node = textareaRef.current;
                const changed = node.value !== text;
                // Notify React once, including the fallback mirror, even when
                // memoization skips a render after inserting/clearing a draft.
                const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
                setter.call(node, text);
                node.setSelectionRange(selection.start, selection.end);
                if (changed) {
                    node.dispatchEvent(new Event('input', { bubbles: true }));
                } else {
                    onStateChange?.({ text, selection });
                    onSelectionChange?.(selection);
                }
            }
        },
        focus: () => {
            const node = textareaRef.current;
            if (node) focusWithoutScroll(node);
        },
        blur: () => {
            textareaRef.current?.blur();
        }
    }), [onChangeText, onStateChange, onSelectionChange, focusWithoutScroll]);

    return (
        <div
            className="lmc-auto-textarea"
            data-native-sizing={nativeSizing ? 'true' : 'false'}
            style={{
                fontSize: `${MULTI_TEXT_INPUT_FONT_SIZE}px`,
                fontFamily: Typography.default().fontFamily,
                lineHeight: `${lineHeight}px`,
                '--lmc-field-min-height': `${lineHeight + (props.paddingTop ?? 0) + (props.paddingBottom ?? 0)}px`,
                '--lmc-field-max-height': `${maxRows * lineHeight + (props.paddingTop ?? 0) + (props.paddingBottom ?? 0)}px`,
                '--lmc-field-padding': `${props.paddingTop ?? 0}px ${props.paddingRight ?? 0}px ${props.paddingBottom ?? 0}px ${props.paddingLeft ?? 0}px`,
            } as React.CSSProperties}
        >
            <div ref={mirrorRef} className="lmc-textarea-mirror" aria-hidden="true" />
            <textarea
                ref={textareaRef}
                data-lmc-text-input="true"
                style={{
                    color: theme.colors.input.text,
                }}
                placeholder={placeholder}
                {...(isControlled ? { value } : { defaultValue })}
                onChange={handleChange}
                onSelect={handleSelect}
                onKeyDown={handleKeyDown}
                onCompositionStart={() => { composingRef.current = true; }}
                onCompositionEnd={() => { composingRef.current = false; }}
                onTouchStart={(event) => {
                    const touch = event.touches[0];
                    // Also track a tap on the focused field while the keyboard
                    // is dismissed: WebKit re-sends focus information without
                    // preventScroll and force-scrolls the field's pre-lift
                    // position to the page limit (v296/v298 device traces).
                    touchRef.current = usesNativeWebKitKeyboardPan() && event.touches.length === 1
                        && (document.activeElement !== event.currentTarget || event.currentTarget.dataset.lmcKeyboardDismissed === 'true')
                        ? { id: touch.identifier, x: touch.clientX, y: touch.clientY } : null;
                }}
                onTouchMove={(event) => {
                    const start = touchRef.current;
                    const touch = Array.from(event.touches).find(touch => touch.identifier === start?.id);
                    if (event.touches.length !== 1 || !touch || (start && Math.hypot(touch.clientX - start.x, touch.clientY - start.y) > 12)) {
                        touchRef.current = null;
                    }
                }}
                onTouchCancel={() => { touchRef.current = null; }}
                onTouchEnd={(event) => {
                    const start = touchRef.current;
                    touchRef.current = null;
                    const touch = Array.from(event.changedTouches).find(touch => touch.identifier === start?.id);
                    if (!start || !touch || event.touches.length || !event.cancelable
                        || Math.hypot(touch.clientX - start.x, touch.clientY - start.y) > 12) return;
                    const node = event.currentTarget;
                    if (document.activeElement === node) {
                        // Keyboard dismissed but the field kept focus: a native
                        // re-tap would re-reveal from the old position. Blur
                        // and refocus inside the gesture so the new focus
                        // information carries preventScroll; the caret stays.
                        if (node.dataset.lmcKeyboardDismissed !== 'true') return;
                        event.preventDefault();
                        delete node.dataset.lmcKeyboardDismissed;
                        // Lift first: WebKit checks the caret while the keyboard
                        // frame is still animating, before any viewport event.
                        node.dispatchEvent(new CustomEvent(KEYBOARD_EXPECTED_EVENT, { bubbles: true }));
                        node.blur();
                        focusWithoutScroll(node);
                        return;
                    }
                    // Cancel touch's native focus before the compatibility
                    // mousedown/click. An already-focused field retains native
                    // caret placement, selection handles and long-press menus.
                    event.preventDefault();
                    focusWithoutScroll(node);
                }}
                onMouseDown={(event) => {
                    // Touch compatibility mousedown precedes default focus.
                    // Focus explicitly before WebKit's default caret reveal
                    // can scroll the entire page; the dock handles occlusion.
                    // Once editing, leave native caret placement/selection alone.
                    if (event.button !== 0 || document.activeElement === event.currentTarget
                        || !window.matchMedia('(pointer: coarse)').matches) return;
                    event.preventDefault();
                    focusWithoutScroll(event.currentTarget);
                }}
                onFocus={() => props.onFocusChange?.(true)}
                onBlur={(event) => {
                    delete event.currentTarget.dataset.lmcFocusScroll;
                    props.onFocusChange?.(false);
                }}
                rows={1}
                autoCapitalize="sentences"
                autoCorrect="on"
                autoComplete="off"
            />
        </div>
    );
}));

MultiTextInput.displayName = 'MultiTextInput';
