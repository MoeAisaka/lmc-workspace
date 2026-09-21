import { beforeEach, expect, it, vi } from 'vitest';
const { rpc, resume, resolveMode, sendMessage, setModes, metadata, session, sessionMessages } = vi.hoisted(() => {
    const metadata = {flavor:'codex', sessionCapabilities: undefined as undefined | {refresh:boolean;authentication:boolean;runtimeConfiguration:boolean}, sessionConfiguration:true, sessionConfigState:'applied', sessionConfigUpdatedAt:Date.now(), machineId:'m'};
    return {
        rpc: vi.fn(), resume: vi.fn(), resolveMode: vi.fn(), sendMessage: vi.fn(), setModes: vi.fn(), metadata,
        sessionMessages: {s:{messages:[] as any[]}},
        session: {id:'s', active:true, metadata},
    };
});
// Mocked because the real module pulls in react-native, which vitest cannot parse.
vi.mock('./sync', () => ({sync:{sendMessage}}));
vi.mock('./storage', () => ({storage:{getState:()=>({sessions:{s:session},machines:{},settings:{},sessionMessages})}}));
vi.mock('./apiSocket', () => ({apiSocket:{sessionRPC:rpc}}));
vi.mock('./ops', () => ({machineResumeSession:resume,sessionSetAgentModes:setModes}));
vi.mock('./messageMeta', () => ({resolveMessageModeMeta:resolveMode}));
vi.mock('@/text', () => ({t:(key:string)=>key}));
import { applyPendingEngineModel, refreshSessionCli, retrySessionRefresh, switchSessionEngine } from './sessionConfiguration';
beforeEach(()=>{
    rpc.mockReset();resume.mockReset();resolveMode.mockReset();sendMessage.mockReset();setModes.mockReset();session.active=true;
    metadata.flavor='codex';metadata.sessionCapabilities=undefined;
    metadata.sessionConfigState='applied';metadata.sessionConfigUpdatedAt=Date.now();
    (metadata as any).permissionMode=undefined;sessionMessages.s.messages=[];
    resolveMode.mockReturnValue({model:'gpt-test',permissionMode:'auto'});
});
it('does not submit another refresh while the first RPC is pending', async()=>{
    let complete!: (value: unknown)=>void;
    rpc.mockImplementation(()=>new Promise(resolve=>{complete=resolve;}));
    const first=refreshSessionCli('s');
    await refreshSessionCli('s');
    expect(rpc).toHaveBeenCalledTimes(1);
    complete({status:'queued'});await first;
});
it('blocks duplicates across refresh stages and permits retry after failure', async()=>{
    for(const state of ['queued','refreshing','verifying']){
        metadata.sessionConfigState=state;
        await refreshSessionCli('s');
    }
    expect(rpc).not.toHaveBeenCalled();
    metadata.sessionConfigState='error';rpc.mockResolvedValue({status:'queued'});
    await refreshSessionCli('s');
    expect(rpc).toHaveBeenCalledTimes(1);
});
it('permits retry after a restart has exceeded its recovery deadline', async()=>{
    metadata.sessionConfigState='refreshing';
    metadata.sessionConfigUpdatedAt=Date.now()-91_000;
    rpc.mockResolvedValue({status:'queued'});
    await refreshSessionCli('s');
    expect(rpc).toHaveBeenCalledTimes(1);
});
it('resumes the same inactive Happy session when a refresh handoff stalls', async()=>{
    session.active=false;
    metadata.sessionConfigState='refreshing';
    metadata.sessionConfigUpdatedAt=Date.now()-91_000;
    resume.mockResolvedValue({type:'success',sessionId:'s'});

    await expect(retrySessionRefresh('s')).resolves.toEqual({type:'success',sessionId:'s'});
    expect(resume).toHaveBeenCalledWith({machineId:'m',sessionId:'s',model:'gpt-test',permissionMode:'auto'});
});
it('releases the submission lock after a transport failure', async()=>{
    rpc.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({status:'queued'});
    await expect(refreshSessionCli('s')).rejects.toThrow('offline');
    await expect(refreshSessionCli('s')).resolves.toEqual({status:'queued'});
});

it('asks for a relaunch and nothing else, on either engine', async()=>{
    metadata.flavor='claude';
    metadata.sessionCapabilities={refresh:true,authentication:true,runtimeConfiguration:false};
    rpc.mockResolvedValue({status:'queued'});
    await refreshSessionCli('s');
    expect(rpc).toHaveBeenCalledWith('s','configure-session',{refreshCli:true});
    metadata.flavor='codex';
    metadata.sessionCapabilities={refresh:true,authentication:true,runtimeConfiguration:true};
    metadata.sessionConfigState='applied';metadata.sessionConfigUpdatedAt=Date.now();
    rpc.mockClear();
    await refreshSessionCli('s');
    expect(rpc).toHaveBeenCalledWith('s','configure-session',{refreshCli:true});
});
it('refreshes a session whose migrated metadata still carries invalid Codex-only settings',async()=>{
 metadata.flavor='claude';metadata.sessionCapabilities={refresh:true,authentication:true,runtimeConfiguration:false};
 (metadata as any).codexServiceTier='unsupported';rpc.mockResolvedValue({status:'queued'});
 try{await expect(refreshSessionCli('s')).resolves.toEqual({status:'queued'});}
 finally{delete (metadata as any).codexServiceTier;}
});

it('asks the engine before requesting the switch, so an idle session cannot exit first', async()=>{
    metadata.sessionCapabilities={refresh:true,authentication:true,runtimeConfiguration:true};
    sessionMessages.s.messages=[{kind:'user-text',id:'u1',localId:null,createdAt:1,text:'Fix the grouping'}];
    rpc.mockResolvedValue({status:'queued'});
    await switchSessionEngine('s','claude');
    // An idle runner reaches its boundary the moment the switch lands. The
    // question has to be in its queue by then, or it is replayed to the engine
    // that has already taken over — which has nothing to hand over.
    expect(sendMessage.mock.invocationCallOrder[0]).toBeLessThan(rpc.mock.invocationCallOrder[0]);
    expect(sendMessage.mock.calls[0][2]).toMatchObject({source:'engine_switch',awaitDelivery:true});
    const request=rpc.mock.calls[0][2] as any;
    expect(request.engine).toBe('claude');
    // The fallback still rides the switch itself: it has to be in place before
    // the engine is given a chance to refuse, crash, or say nothing.
    expect(request.fallbackBriefing).toContain('Fix the grouping');
});

it('asks the engine being left for its own handoff once the switch is queued', async()=>{
    metadata.sessionCapabilities={refresh:true,authentication:true,runtimeConfiguration:true};
    rpc.mockResolvedValue({status:'queued'});
    await switchSessionEngine('s','claude');
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0][1]).toContain('submit_handoff');
    expect(sendMessage.mock.calls[0][2]).toMatchObject({source:'engine_switch'});
});

it('surfaces a refused switch, having already asked — the cost of asking first', async()=>{
    metadata.sessionCapabilities={refresh:true,authentication:true,runtimeConfiguration:true};
    rpc.mockResolvedValue({status:'rejected'});
    await expect(switchSessionEngine('s','claude')).rejects.toThrow();
    // The question is out by then and the engine will answer it. submit_handoff
    // refuses when nothing is pending and says why, which is the trade for not
    // losing the handoff on every idle switch.
    expect(sendMessage).toHaveBeenCalledTimes(1);
});

it('maps the permission mode into the target engine’s vocabulary', async()=>{
    metadata.sessionCapabilities={refresh:true,authentication:true,runtimeConfiguration:true};
    (metadata as any).permissionMode='read-only';
    rpc.mockResolvedValue({status:'queued'});
    await switchSessionEngine('s','claude');
    expect((rpc.mock.calls[0][2] as any).permissionMode).toBe('plan');
});

it('does nothing when asked to switch to the engine already running', async()=>{
    metadata.sessionCapabilities={refresh:true,authentication:true,runtimeConfiguration:true};
    await expect(switchSessionEngine('s','codex')).resolves.toEqual({status:'queued'});
    expect(rpc).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
});

it('refuses a session too old to refresh, rather than stranding it mid-switch', async()=>{
    metadata.sessionCapabilities={refresh:false,authentication:false,runtimeConfiguration:false};
    await expect(switchSessionEngine('s','claude')).rejects.toThrow();
    expect(rpc).not.toHaveBeenCalled();
});

it('keeps the chosen model off the engine being left, whose turn is still running', async()=>{
    metadata.sessionCapabilities={refresh:true,authentication:true,runtimeConfiguration:true};
    rpc.mockResolvedValue({status:'queued'});
    await switchSessionEngine('s','claude','claude-opus-5');
    // The handoff request goes out on this session's own model; a Claude model
    // reaching the running Codex would fail the one turn that must not.
    expect(setModes).not.toHaveBeenCalled();
    applyPendingEngineModel('s','codex');
    expect(setModes).not.toHaveBeenCalled();
});

it('applies it the moment the session is on the engine it was chosen for', async()=>{
    metadata.sessionCapabilities={refresh:true,authentication:true,runtimeConfiguration:true};
    rpc.mockResolvedValue({status:'queued'});
    await switchSessionEngine('s','claude','claude-opus-5');
    applyPendingEngineModel('s','claude');
    expect(setModes).toHaveBeenCalledWith('s',{modelMode:'claude-opus-5',effortLevel:null});
    setModes.mockClear();
    // Once applied it is spent: a later relaunch must not re-apply it over a
    // model the user has since chosen.
    applyPendingEngineModel('s','claude');
    expect(setModes).not.toHaveBeenCalled();
});

it('leaves the model alone when the switch named none', async()=>{
    metadata.sessionCapabilities={refresh:true,authentication:true,runtimeConfiguration:true};
    rpc.mockResolvedValue({status:'queued'});
    await switchSessionEngine('s','claude');
    applyPendingEngineModel('s','claude');
    expect(setModes).not.toHaveBeenCalled();
});

// The direction the reported defect took. Every case above leaves Codex for
// Claude, so claude→codex had no coverage at all.
it('carries a chosen codex model onto a session leaving claude', async()=>{
    metadata.flavor='claude';
    metadata.sessionCapabilities={refresh:true,authentication:true,runtimeConfiguration:true};
    rpc.mockResolvedValue({status:'queued'});
    await switchSessionEngine('s','codex','gpt-6-astra');
    expect(setModes).not.toHaveBeenCalled();
    applyPendingEngineModel('s','claude');
    expect(setModes).not.toHaveBeenCalled();
    applyPendingEngineModel('s','codex');
    expect(setModes).toHaveBeenCalledWith('s',{modelMode:'gpt-6-astra',effortLevel:null});
});
