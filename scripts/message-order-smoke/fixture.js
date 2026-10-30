const init = modules.get(0); __r(init.deps[0]); __r(init.deps[1]);
const React = moduleExport('useState'), h = React.createElement;
const { createRoot } = moduleExport('createRoot');
const { ChatList } = moduleExport('ChatList');
const { ModalProvider } = moduleExport('ModalProvider');
const { SafeAreaProvider } = moduleExport('SafeAreaProvider');
const { storage, useSession, useSessionMessages } = moduleExport('storage');
const { normalizeRawMessage, RawRecordSchema } = moduleExport('normalizeRawMessage');
const id = 'message-order-fixture';
const session = { id, createdAt: 1, updatedAt: 1, active: true, activeAt: 1,
    metadata: { host: 'fixture', path: '/fixture', name: '消息顺序验证', flavor: 'codex' },
    metadataVersion: 1, agentState: {}, agentStateVersion: 1, thinking: true, thinkingAt: 1 };
const agent = (id, time, seq, ev) => ({
    ...normalizeRawMessage(id, null, time, RawRecordSchema.parse({
        role: 'session', content: { id, time, role: 'agent', turn: 'fixture-turn', ev },
    })), serverSeq: seq,
});
const record = RawRecordSchema.parse({ role: 'session', content: {
    id: 'image-envelope', time: 10000, role: 'user',
    ev: { t: 'file', ref: 'fixture-image', name: 'image.png', size: 100, image: { width: 80, height: 60 } },
} });
const file = normalizeRawMessage('local-file', 'local-file', 10000, record);
const fileEcho = { ...normalizeRawMessage('server-file', 'local-file', 8000, record), serverSeq: 101 };
const prompt = { id: 'local-text', localId: 'local-text', createdAt: 10001, role: 'user',
    content: { type: 'text', text: '我在MacBook上看不到' }, isSidechain: false };
const promptEcho = { ...prompt, id: 'server-text', createdAt: 8001, serverSeq: 102 };
const apply = messages => storage.getState().applyMessages(id, messages);
function reset() {
    storage.setState(s => ({ sessions: { [id]: session }, sessionMessages: {}, settings: { ...s.settings, groupToolCalls: true } }));
    apply([agent('old', 5000, 100, { t: 'text', text: '上一轮已结束' })]);
}
reset();
function App() {
    const current = useSession(id);
    const { messages } = useSessionMessages(id);
    const actions = {
        '重置': reset,
        '发送图片和文字': () => { apply([file]); apply([prompt]); },
        '确认文字': () => apply([promptEcho]),
        '确认图片': () => apply([fileEcho]),
        '收到新回复': () => apply([agent('reply', 9000, 105, { t: 'text', text: '我来改成可下载的附件' })]),
        '收到工具调用': () => apply([agent('work', 10500, 106, { t: 'tool-call-start', call: 'command', name: 'Bash', title: '运行命令', description: '', args: { command: 'pwd' } })]),
        '完成本轮': () => {
            apply([agent('done', 11000, 107, { t: 'tool-call-end', call: 'command' })]);
            apply([agent('final', 11100, 108, { t: 'text', text: '附件已准备好' })]);
            storage.setState(s => ({ sessions: { ...s.sessions, [id]: { ...s.sessions[id], thinking: false } } }));
        },
        '重复确认': () => apply([fileEcho, promptEcho]),
    };
    const order = [...messages].reverse().map(m => ({ label: m.text || m.tool?.name || m.kind, seq: m.serverSeq ?? null }));
    return h(ModalProvider, null, h(SafeAreaProvider, { initialMetrics: { frame: { x: 0, y: 0, width: 1000, height: 900 }, insets: { top: 0, bottom: 0, left: 0, right: 0 } } },
        h('nav', null, '离线消息顺序验证 · 正式构建 · 无生产连接', h('div', null, Object.entries(actions).map(([label, action]) => h('button', { key: label, onClick: action }, label)))),
        h('div', { style: { flex: 1, display: 'flex', minHeight: 0, flexDirection: 'column' } }, h(ChatList, { session: current, topContentInset: 0, bottomContentInset: 0 })),
        h('pre', { 'data-order-state': true }, JSON.stringify(order)),
    ));
}
createRoot(document.getElementById('root')).render(h(App));
