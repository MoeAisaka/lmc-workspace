import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('react-native', async () => {
    const ReactModule = await import('react');
    const host = (name: string) => (props: any) => ReactModule.createElement(name, props, props.children);
    class AnimatedValue {
        interpolate() {
            return 1;
        }
    }
    return {
        Animated: {
            Value: AnimatedValue,
            View: host('AnimatedView'),
            timing: () => ({ start: () => undefined }),
        },
        KeyboardAvoidingView: host('KeyboardAvoidingView'),
        Modal: host('Modal'),
        Platform: { OS: 'android', select: (values: any) => values.android ?? values.default },
        StyleSheet: { absoluteFillObject: {}, create: (styles: unknown) => styles },
        TouchableWithoutFeedback: host('TouchableWithoutFeedback'),
        View: host('View'),
    };
});

vi.mock('@/components/AnimatedOverlay', async () => {
    const ReactModule = await import('react');
    return {
        AnimatedBlurBackdrop: (props: any) => ReactModule.createElement('AnimatedBlurBackdrop', props),
    };
});

import { BaseModal } from './BaseModal';

beforeAll(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

function renderModal(props: Record<string, unknown>): ReactTestRenderer {
    let renderer!: ReactTestRenderer;
    act(() => {
        renderer = create(React.createElement(
            BaseModal as any,
            { visible: true, ...props },
            React.createElement('Child'),
        ));
    });
    return renderer;
}

describe('BaseModal request-close policy', () => {
    it('keeps hardware request-close independent from backdrop policy', () => {
        const onClose = vi.fn();
        const renderer = renderModal({ onClose, closeOnBackdrop: false });

        act(() => renderer.root.findByType('Modal').props.onRequestClose());

        expect(onClose).toHaveBeenCalledOnce();
    });

    it('can explicitly suppress hardware request-close', () => {
        const onClose = vi.fn();
        const renderer = renderModal({ onClose, closeOnRequestClose: false });

        act(() => renderer.root.findByType('Modal').props.onRequestClose());

        expect(onClose).not.toHaveBeenCalled();
    });
});
