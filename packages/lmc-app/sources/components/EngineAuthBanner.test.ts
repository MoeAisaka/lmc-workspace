// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({ session: {} as any, flow: null as any, check: vi.fn(), login: vi.fn() }));
vi.mock('react-native', () => ({
    Platform: { OS: 'web' }, ActivityIndicator: () => null,
    View: ({ children }: any) => React.createElement('div', null, children),
    Text: ({ children }: any) => React.createElement('span', null, children),
    Pressable: ({ children, disabled, onPress }: any) => React.createElement('button', { disabled, onClick: onPress }, children),
}));
vi.mock('react-native-unistyles', () => ({ useUnistyles: () => ({ theme: { colors: { status: {} } } }) }));
vi.mock('@/sync/storage', () => ({ useSession: () => mock.session, useMachine: () => ({ active: true, metadata: { engineLogin: { claude: true, codex: true } } }) }));
vi.mock('@/sync/engineAuthentication', () => ({ checkSessionAuthentication: mock.check }));
vi.mock('@/components/lmc/elevation', () => ({ lmcElevation: () => ({}), lmcSurfaceBorder: () => ({}) }));
vi.mock('@/text', () => ({ t: (key: string) => key }));
vi.mock('@/modal', () => ({ Modal: { show: vi.fn() } }));
vi.mock('./engineLogin/EngineLoginDialog', () => ({ EngineLoginDialog: () => null }));
vi.mock('./engineLogin/useEngineLogin', () => ({ useEngineLogin: () => ({ flow: mock.flow, request: mock.login, error: 'unsupported' }) }));
vi.mock('@/sync/engineLogin', () => ({ engineLoginError: (code: string) => code, shouldAutoRecover: () => true }));
import { EngineAuthBanner } from './EngineAuthBanner';

let container: HTMLDivElement;
let root: Root;
const render = () => act(async () => { root.render(React.createElement(EngineAuthBanner, { sessionId: 's' })); });
beforeEach(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    vi.clearAllMocks(); mock.flow = null;
    mock.session = { active: true, metadata: { flavor: 'codex', machineId: 'm', host: 'MacBook', engineAuth: { status: 'unknown', checkedAt: 1 }, sessionCapabilities: { authentication: true, authenticationRecovery: true } } };
    mock.check.mockResolvedValue({ status: 'unknown', checkedAt: 2 });
    container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

it.each(['claude', 'codex'])('rechecks unknown %s auth in the live session without starting login or refresh', async engine => {
    mock.session.metadata.flavor = engine;
    await render();
    expect(mock.check).toHaveBeenCalledExactlyOnceWith('s');
    expect(mock.login).not.toHaveBeenCalled();
    expect(container.textContent).toContain('localFeatures.loginErrorUnknown');
    expect(container.textContent).not.toContain('localFeatures.loginTitle');
    expect(container.textContent).not.toContain('unsupported');
    mock.session.metadata.engineAuth.checkedAt = 2;
    await render();
    expect(mock.check).toHaveBeenCalledTimes(1); // An unknown result cannot create a retry loop.
    mock.session.metadata.engineAuth.status = 'ready';
    await render();
    expect(container.textContent).toBe('');
});

it('rechecks after the session reconnects and allows a deliberate retry', async () => {
    mock.session.active = false; await render();
    expect(mock.check).not.toHaveBeenCalled();
    expect(container.querySelector('button')?.disabled).toBe(true);
    mock.session.active = true; await render();
    expect(mock.check).toHaveBeenCalledTimes(1);
    await act(async () => { container.querySelector('button')!.click(); });
    expect(mock.check).toHaveBeenCalledTimes(2);
    expect(mock.login).not.toHaveBeenCalled();
});

it('keeps an unavailable legacy auth check neutral and fails closed', async () => {
    mock.session.metadata.sessionCapabilities = {};
    await render();
    expect(mock.check).not.toHaveBeenCalled();
    expect(container.textContent).toContain('localFeatures.loginErrorUpgrade');
    expect(container.textContent).not.toContain('codex login');
    expect(container.querySelector('button')?.disabled).toBe(true);
});

it('keeps real logout recovery and an already-running login flow available', async () => {
    mock.session.metadata.engineAuth.status = 'required'; await render();
    expect(mock.check).not.toHaveBeenCalled();
    expect(mock.login).toHaveBeenCalledWith('auto');
    expect(container.textContent).toContain('localFeatures.loginTitle');
    mock.flow = { sourceSessionId: 's', state: 'recovering', sessions: [] };
    mock.session.metadata.engineAuth.status = 'ready'; await render();
    expect(container.textContent).toContain('localFeatures.loginRecovering');
});

it('shows a sanitized retry error without treating an RPC failure as logout', async () => {
    mock.check.mockRejectedValueOnce(new Error('private transport detail'));
    await render();
    expect(container.textContent).toContain('localFeatures.engineAuthCheckFailed');
    expect(container.textContent).not.toContain('private transport detail');
    expect(container.textContent).not.toContain('localFeatures.loginTitle');
    expect(mock.login).not.toHaveBeenCalled();
});
