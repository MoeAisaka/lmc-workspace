// Offline POST-only regression through the exported Sync.flushOutbox, storage,
// normalizer, reducer and ChatList. The server and ciphertext are synthetic;
// serve.cjs blocks every external connection with CSP connect-src 'none'.
const init = modules.get(0); __r(init.deps[0]); __r(init.deps[1]);
const React = moduleExport('useState'), h = React.createElement;
const { createRoot } = moduleExport('createRoot');
const { ChatList } = moduleExport('ChatList');
const { ModalProvider } = moduleExport('ModalProvider');
const { SafeAreaProvider } = moduleExport('SafeAreaProvider');
const { storage, useSession, useSessionMessages } = moduleExport('storage');
const { normalizeRawMessage, RawRecordSchema } = moduleExport('normalizeRawMessage');
const { sync } = moduleExport('sync');
const { apiSocket } = moduleExport('apiSocket');
const id = 'http-receipt-fixture';
let posted = [], receipts = [], result = '尚未运行', notify = () => {};
const encryption = {
    encryptRawRecord: async raw => JSON.stringify(raw),
    decryptMessage: async m => ({ ...m, content: JSON.parse(m.content.c) }),
    decryptMessages: async messages => messages.map(m => ({
        ...m, content: JSON.parse(m.content.c),
    })),
};
sync.encryption = { getSessionEncryption: sid => sid === id ? encryption : null };
const apply = messages => storage.getState().applyMessages(id, messages);
const agent = (name, time, seq, text) => ({
    ...normalizeRawMessage(name, null, time, RawRecordSchema.parse({
        role: 'session', content: { id: name, time, role: 'agent', turn: 'fixture-turn', ev: { t: 'text', text } },
    })), serverSeq: seq,
});
function reset(flavor = 'codex', withFile = false) {
    const session = { id, createdAt: 1, updatedAt: 1, active: true, activeAt: 1,
        metadata: { host: 'fixture', path: '/fixture', name: 'HTTP 确认顺序验证', flavor },
        metadataVersion: 1, agentState: {}, agentStateVersion: 1, thinking: true, thinkingAt: 1 };
    storage.setState(s => ({ sessions: { [id]: session }, sessionMessages: {}, settings: { ...s.settings, groupToolCalls: true } }));
    sync.pendingOutbox.clear();
    sync.sessionLastSeq.clear();
    sync.sessionLifecycles.clear();
    sync.sessionLastSeq.set(id, 100);
    sync.appState = 'active';
    apply([agent('old', 5000, 100, '上一轮已结束')]);
    const raw = [{ localId: 'local-text', content: RawRecordSchema.parse({
        role: 'user', content: { type: 'text', text: '继续' },
    }) }];
    if (withFile) raw.unshift({ localId: 'local-file', content: RawRecordSchema.parse({
        role: 'session', content: { id: 'file-envelope', time: 10000, role: 'user',
            ev: { t: 'file', ref: 'fixture-file', name: 'sample.txt', size: 1 } },
    }) });
    posted = raw.map(m => ({ localId: m.localId, content: JSON.stringify(m.content) }));
    receipts = raw.map((m, i) => ({ id: `server-${i}`, localId: m.localId, seq: 101 + i, createdAt: 8000 + i, updatedAt: 8000 + i }));
    // The phone clock is ahead of the server/agent clock. Real sends initially
    // use Date.now(), then the server receipts supply authoritative ordering.
    apply(raw.map((m, i) => normalizeRawMessage(m.localId, m.localId, 10000 + i, m.content)));
    sync.pendingOutbox.set(id, posted.slice());
    apiSocket.request = async (url, request) => {
        if (url !== `/v3/sessions/${id}/messages` || request.method !== 'POST') throw new Error('Unexpected fixture request');
        if (JSON.stringify(JSON.parse(request.body).messages) !== JSON.stringify(posted)) throw new Error('Unexpected batch');
        return { ok: true, json: async () => ({ messages: [...receipts].reverse() }) };
    };
}
function reply() { apply([agent('reply', 9000, 105, '我先补齐恢复，再继续检查。')]); }
function echo() {
    apply(receipts.map(r => ({ ...normalizeRawMessage(r.id, r.localId, r.createdAt,
        JSON.parse(posted.find(m => m.localId === r.localId).content)), serverSeq: r.seq })));
}
function snapshot() {
    const state = storage.getState().sessionMessages[id];
    return [...state.messages].reverse().map(m => ({ label: m.text || m.tool?.name || m.kind, seq: m.serverSeq ?? null }));
}
function check(withFile) {
    const order = snapshot();
    const expected = withFile ? [100, 101, 102, 105] : [100, 101, 105];
    if (JSON.stringify(order.map(m => m.seq)) !== JSON.stringify(expected)) throw new Error(JSON.stringify(order));
    if (sync.pendingOutbox.has(id)) throw new Error('Acknowledged messages remain in outbox');
    return order;
}
async function runMatrix() {
    const results = [];
    for (const flavor of ['codex', 'claude']) for (const withFile of [false, true]) {
        for (const mode of ['no-echo', 'reply-before-http', 'echo-before-http', 'retry-no-echo']) {
            reset(flavor, withFile);
            const request = apiSocket.request;
            try {
                if (mode === 'reply-before-http') {
                    let release;
                    apiSocket.request = async (...args) => { await new Promise(resolve => { release = resolve; }); return request(...args); };
                    const sending = sync.flushOutbox(id);
                    reply(); release(); await sending;
                } else {
                    if (mode === 'echo-before-http') echo();
                    if (mode === 'retry-no-echo') {
                        apiSocket.request = async () => ({ ok: false, status: 503 });
                        try { await sync.flushOutbox(id); } catch (_) { /* next request returns the stored receipt, without a new broadcast */ }
                        apiSocket.request = request;
                    }
                    await sync.flushOutbox(id); reply();
                }
                check(withFile);
                echo(); check(withFile); // Delayed/duplicate socket echo must not duplicate a row.
                results.push({ flavor, withFile, mode, pass: true });
            } catch (error) { results.push({ flavor, withFile, mode, pass: false, error: String(error) }); }
        }
    }
    result = JSON.stringify({ passed: results.filter(r => r.pass).length, total: results.length, results }, null, 2);
    reset(); await sync.flushOutbox(id); reply();
    notify();
}
async function runRecovery() {
    const results = [];
    try {
        reset(); receipts[0].seq = 104;
        await sync.flushOutbox(id);
        if (sync.sessionLastSeq.get(id) !== 100) throw new Error('POST skipped unseen history');
        const history = [
            { id:'intervening',seq:101,localId:null,createdAt:7000,updatedAt:7000,content:{t:'encrypted',c:JSON.stringify(RawRecordSchema.parse({role:'session',content:{id:'intervening',time:7000,role:'agent',turn:'fixture-turn',ev:{t:'text',text:'补同步的消息'}}}))} },
            {...receipts[0],content:{t:'encrypted',c:posted[0].content}},
        ];
        apiSocket.request = async url => {
            if (url !== `/v3/sessions/${id}/messages?after_seq=100&limit=100`) throw new Error('Wrong recovery cursor');
            return {ok:true,json:async()=>({messages:history,hasMore:false})};
        };
        await sync.fetchMessages(id);
        if (JSON.stringify(snapshot().map(m=>m.seq)) !== '[100,101,104]') throw new Error(`History gap not recovered: ${JSON.stringify(snapshot())}`);
        results.push({case:'POST leaves intervening history fetchable',pass:true});
    } catch(error) { results.push({case:'history gap',pass:false,error:String(error)}); }
    try {
        reset('codex',true);
        const all = receipts; receipts = receipts.slice(0,1);
        let rejected = false;
        try { await sync.flushOutbox(id); } catch (_) { rejected = true; }
        if (!rejected || sync.pendingOutbox.get(id)?.length !== 2) throw new Error('Incomplete receipt silently dropped a message');
        receipts = all;
        await sync.flushOutbox(id); reply(); check(true);
        results.push({case:'incomplete receipt retains batch, retry reconciles without echo',pass:true});
    } catch(error) { results.push({case:'incomplete receipt retry',pass:false,error:String(error)}); }
    result = JSON.stringify({passed:results.filter(r=>r.pass).length,total:results.length,results},null,2); notify();
}
async function runSendAndSocket() {
    const results = [];
    for (const flavor of ['codex','claude']) {
        reset(flavor);
        storage.setState({sessionMessages:{}});
        apply([agent('old',5000,100,'上一轮已结束')]);
        sync.pendingOutbox.delete(id);
        let wire;
        apiSocket.request = async (url, request) => {
            if (request?.method === 'POST') {
                const sent = JSON.parse(request.body).messages[0];
                const receipt = {id:'server-real-send',localId:sent.localId,seq:101,createdAt:8000,updatedAt:8000};
                wire = {...receipt,content:{t:'encrypted',c:sent.content}};
                return {ok:true,json:async()=>({messages:[receipt]})};
            }
            // Old code incorrectly requests after_seq=101 for the delayed echo,
            // which cannot retrieve the user's seq=101 message.
            if (url === `/v3/sessions/${id}/messages?after_seq=101&limit=100`) return {ok:true,json:async()=>({messages:[],hasMore:false})};
            throw new Error(`Unexpected fixture request ${url}`);
        };
        try {
            await sync.sendMessage(id,'继续',{awaitDelivery:true});
            if (!wire) throw new Error('Real send did not POST');
            await sync.handleUpdate({id:'echo',seq:1,createdAt:8000,body:{t:'new-message',sid:id,message:wire}});
            await sync.getMessagesSync(id).awaitQueue();
            const replyWire = {id:'server-reply',seq:102,localId:null,createdAt:9000,updatedAt:9000,content:{t:'encrypted',c:JSON.stringify(RawRecordSchema.parse({role:'session',content:{id:'reply',time:9000,role:'agent',turn:'fixture-turn',ev:{t:'text',text:'我先补齐恢复，再继续检查。'}}}))}};
            await sync.handleUpdate({id:'reply-update',seq:2,createdAt:9000,body:{t:'new-message',sid:id,message:replyWire}});
            await sync.getSessionMessageLock(id).inLock(()=>{});
            if (JSON.stringify(snapshot().map(m=>m.seq)) !== '[100,101,102]') throw new Error(`Wrong real send order: ${JSON.stringify(snapshot())}`);
            results.push({flavor,pass:true});
        } catch(error) { results.push({flavor,pass:false,error:String(error)}); }
    }
    result = JSON.stringify({passed:results.filter(r=>r.pass).length,total:results.length,results},null,2); notify();
}
reset();
function App() {
    const current = useSession(id), { messages } = useSessionMessages(id);
    const [, setRevision] = React.useState(0);
    notify = () => setRevision(n => n + 1);
    const actions = {
        '重置并发送': () => reset(),
        '仅 HTTP 确认': () => sync.flushOutbox(id),
        '收到新回复': reply,
        '补到实时确认': echo,
        '运行 16 项回归': runMatrix,
        '验证补同步与重试': runRecovery,
        '真实发送与延迟回推': runSendAndSocket,
    };
    return h(ModalProvider, null, h(SafeAreaProvider, { initialMetrics: { frame: { x: 0, y: 0, width: 1000, height: 900 }, insets: { top: 0, bottom: 0, left: 0, right: 0 } } },
        h('nav', null, '离线 HTTP 确认验证 · 真实 Sync 与 ChatList · 无生产连接', h('div', null,
            Object.entries(actions).map(([label, action]) => h('button', { key: label, onClick: () => Promise.resolve(action()).then(notify).catch(e => { result = String(e); notify(); }) }, label)))),
        h('div', { style: { height: 400, display: 'flex', minHeight: 0, flexDirection: 'column' } }, h(ChatList, { session: current, topContentInset: 0, bottomContentInset: 0 })),
        h('pre', { 'data-order-state': true }, JSON.stringify([...messages].reverse().map(m => ({ label: m.text || m.tool?.name || m.kind, seq: m.serverSeq ?? null })))),
        h('pre', { 'data-regression-result': true }, result),
    ));
}
createRoot(document.getElementById('root')).render(h(App));
