const init = modules.get(0); __r(init.deps[0]); __r(init.deps[1]);
const React = moduleExport('useState'), h = React.createElement, { createRoot } = moduleExport('createRoot');
const { EngineDiagnosticBanner } = moduleExport('EngineDiagnosticBanner'), { ModalProvider } = moduleExport('ModalProvider');
const { storage } = moduleExport('storage'), { apiSocket } = moduleExport('apiSocket'), { UnistylesRuntime } = moduleExport('UnistylesRuntime');
const { MMKV } = moduleExport('MMKV'); new MMKV().set('settings', JSON.stringify({ settings: { preferredLanguage: 'zh-Hans' }, version: 1 }));
storage.getState().applySettingsLocal({ preferredLanguage: 'zh-Hans' });
const query = new URLSearchParams(location.search);
UnistylesRuntime.setAdaptiveThemes(false); UnistylesRuntime.setTheme(query.get('theme') || 'light');
document.body.style.background = query.get('theme') === 'dark' ? '#181818' : '#fafafa';
const prompt = [
    'tool: Calling computer-use… (ctrl+o to expand)',
    'Computer Use wants to control these apps',
    '> 打开绩效系统并验证登录，不查看聊天内容。',
    '  ◉ 钉钉',
    '2 other apps will be hidden while Claude works.',
    '1. Deny, and tell Claude what to do differently (esc)',
    '2. Allow for this session (1 app)',
    'Select with numbers [1-2]. Then Enter to submit or Escape to cancel:',
    'Enter to confirm · Esc to cancel',
];
window.calls = []; window.connected = true; window.changed = false; window.lostReply = false; window.owner = null;
window.native = { epoch: 'fixture_epoch', revision: 7, active: true, exited: false, composer: false, phase: 'busy', lines: prompt };
const listeners = new Set();
apiSocket.onStatusChange = listener => { listeners.add(listener); listener('connected'); return () => listeners.delete(listener); };
window.setConnected = value => { connected = value; for (const listener of listeners) listener(value ? 'connected' : 'disconnected'); };
window.setPrompt = kind => {
    native.lines = kind === 'unknown' ? [...prompt.slice(0, 5), 'Allow clipboard access', ...prompt.slice(5)]
        : kind === 'done' ? ['claude: 已继续工作。'] : prompt;
    native.revision++;
};
apiSocket.sessionRPC = async (sid, method, params) => {
    calls.push({ sid, method, params });
    if (!connected) throw Error('offline');
    if (params.action === 'screen') return { ...native, ownsInput: owner === params.clientId };
    if (params.action === 'claim') {
        await new Promise(resolve => setTimeout(resolve, 150));
        if (owner && owner !== params.clientId) throw Error('Controlled in another window');
        owner = params.clientId;
        if (changed) { native.lines = prompt.map(line => line.replace('钉钉', 'Calendar')); native.revision++; changed = false; }
        return { ...native, ownsInput: true };
    }
    if (params.action === 'input') {
        if (params.epoch !== native.epoch || params.revision !== native.revision || params.clientId !== owner) throw Error('Stale screen');
        if (lostReply) throw Error('Reply lost');
        native.revision++; native.lines = ['claude: 已继续工作。'];
        return { revision: native.revision };
    }
    if (params.action === 'release') { if (owner === params.clientId) owner = null; return {}; }
    throw Error('Unexpected action: ' + params.action);
};
const engine = query.get('engine') || 'claude';
storage.setState({ sessions: { fixture: { id: 'fixture', active: true, presence: 'online', thinking: true,
    metadata: { flavor: engine, claudeNativeActive: true, host: 'Fixture Mac', sessionCapabilities: { nativeComputer: !query.has('legacy') } },
    agentState: { engineDiagnostics: { noProgress: { since: Date.now() - 22 * 60000, observedAt: Date.now(), thresholdMs: 300000,
        toolProcesses: { status: 'alive', liveCount: 1, checkedAt: Date.now() }, systemPrompt: { status: 'none', checkedAt: Date.now() } } } },
} } });
function App() {
    const [visible, setVisible] = React.useState(true);
    window.setVisible = setVisible;
    return h(ModalProvider, null,
        h('div', { style: { position: 'absolute', top: 64, left: 12, right: 12, display: 'flex', justifyContent: 'center' } },
            h(EngineDiagnosticBanner, { sessionId: 'fixture', maxWidth: 520, visible })));
}
createRoot(document.getElementById('root')).render(h(App));
