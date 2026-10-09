// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({ session: {} as any, retry: vi.fn(), cancel: vi.fn() }));
vi.mock('react-native', () => ({
    ActivityIndicator: () => null,
    View: ({ children, testID }: any) => React.createElement('div', { 'data-testid': testID }, children),
    Pressable: ({ children, accessibilityLabel, accessibilityState, disabled, onPress }: any) => React.createElement('button', {
        'aria-label': accessibilityLabel, 'aria-expanded': accessibilityState?.expanded, disabled, onClick: onPress,
    }, children),
}));
vi.mock('@/components/StyledText', () => ({ Text: ({ children }: any) => React.createElement('span', null, children) }));
vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({ theme: { colors: { status: { error: 'red' } } } }),
    StyleSheet: { create: (fn: any) => fn() },
}));
vi.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
vi.mock('@/sync/storage', () => ({ useSession: () => mock.session, useSessionMessages: () => ({ messages: [] }) }));
vi.mock('@/sync/engineSwitchProgress', () => ({ latestSwitchRequest: () => null }));
vi.mock('@/sync/sessionConfiguration', () => ({ retrySessionRefresh: mock.retry, cancelSessionRefresh: mock.cancel }));
vi.mock('@/components/lmc/elevation', () => ({ lmcElevation: () => ({}), lmcSurfaceBorder: () => ({}) }));
vi.mock('@/components/lmc/ProgressSteps', () => ({
    ProgressStepRow: ({ title, detail }: any) => React.createElement('div', { 'data-step': true }, title, detail),
    formatElapsed: (ms: number) => `${ms}ms`,
}));
vi.mock('@/text', () => ({ t: (key: string) => key }));
import { SessionRefreshBanner } from './SessionRefreshBanner';

let root: Root;
let container: HTMLDivElement;
const render = (id = 'session') => act(async () => { root.render(React.createElement(SessionRefreshBanner, { sessionId: id, minHeight: 140 })); });
const button = (label: string) => container.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!;
const click = (button: HTMLButtonElement) => act(async () => { button.click(); });
beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.clearAllMocks();
    mock.retry.mockResolvedValue(undefined);
    mock.cancel.mockResolvedValue('cancelled');
    mock.session = { metadata: { flavor: 'claude', sessionConfigState: 'error', sessionConfigRequestedAt: 10_000, sessionConfigUpdatedAt: 170_000, sessionConfigError: 'Scheduled work was preserved.' } };
    container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

it.each(['claude', 'codex'])('keeps a failed %s refresh compact until details are opened, without retrying', async flavor => {
    mock.session.metadata.flavor = flavor;
    await render();
    expect(container.querySelectorAll('[data-step]')).toHaveLength(0);
    expect(container.textContent).toContain('Scheduled work was preserved.');
    expect(container.textContent).toContain('160000ms');
    await click(button('lmc.refresh.showDetails'));
    expect(container.querySelectorAll('[data-step]')).toHaveLength(4);
    expect(mock.retry).not.toHaveBeenCalled();
    await click(button('lmc.refresh.hideDetails'));
    expect(container.querySelectorAll('[data-step]')).toHaveLength(0);
    expect(mock.cancel).not.toHaveBeenCalled();
    await click(button('lmc.refresh.showDetails'));
    await click([...container.querySelectorAll('button')].find(b => b.textContent === 'lmc.refresh.retry')!);
    expect(mock.retry).toHaveBeenCalledExactlyOnceWith('session');
});

it('does not carry an expanded old failure into another session or refresh attempt', async () => {
    await render(); await click(button('lmc.refresh.showDetails'));
    await render('another-session');
    expect(container.querySelectorAll('[data-step]')).toHaveLength(0);
    await click(button('lmc.refresh.showDetails'));
    mock.session.metadata = { ...mock.session.metadata, sessionConfigRequestedAt: 180_000, sessionConfigUpdatedAt: 190_000 };
    await render('another-session');
    expect(container.querySelectorAll('[data-step]')).toHaveLength(0);
});

it('shows live progress and then folds only when the attempt actually fails', async () => {
    mock.session.metadata = { ...mock.session.metadata, sessionConfigState: 'queued', sessionCapabilities: { cancelRefresh: true } };
    await render();
    expect(container.querySelectorAll('[data-step]')).toHaveLength(4);
    expect(button('lmc.refresh.showDetails')).toBeNull();
    mock.session.metadata = { ...mock.session.metadata, sessionConfigState: 'error', sessionConfigUpdatedAt: Date.now() };
    await render();
    expect(container.querySelectorAll('[data-step]')).toHaveLength(0);
    expect(button('lmc.refresh.showDetails')).not.toBeNull();
    expect(mock.retry).not.toHaveBeenCalled();
});
