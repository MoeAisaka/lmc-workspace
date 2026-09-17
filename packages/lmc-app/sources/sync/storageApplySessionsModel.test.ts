import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The engine-switch model path through the real session merge.
 *
 * `storage.applySessions` is the only place an inbound session meets the local
 * model/effort mirror, so it is the function under test here — not a copy of
 * its rule. Everything downstream of it is real too: the same
 * `resolveMessageModeMeta` the send path calls, and the same picker helpers the
 * composer renders from.
 *
 * Only the module's persistence and socket edges are stubbed: MMKV and the sync
 * socket are native/network side effects the store performs at import (it reads
 * settings, drafts and timestamps from MMKV in its initializer) and on write.
 * Stubbing them removes the storage device, not the merge.
 */
vi.mock('./persistence', () => ({
    loadSettings: () => ({ settings: { viewInline: false }, version: null }),
    saveSettings: vi.fn(),
    loadLocalSettings: () => ({}),
    saveLocalSettings: vi.fn(),
    loadPurchases: () => ({ pro: false }),
    savePurchases: vi.fn(),
    loadProfile: () => ({ id: 'me', timestamp: 0, firstName: null, lastName: null, avatar: null, username: null }),
    saveProfile: vi.fn(),
    loadSessionDrafts: () => ({}),
    saveSessionDrafts: vi.fn(),
    loadSessionLastMessageSentAt: () => ({}),
    saveSessionLastMessageSentAt: vi.fn(),
}));

// The store reads `Platform.OS` for a draft-persistence branch. The real
// module is Flow-typed source this runner cannot parse, and nothing in the
// merge touches the rest of its surface.
vi.mock('react-native', () => ({
    Platform: { OS: 'ios', select: (choices: Record<string, unknown>) => choices.ios ?? choices.default },
}));

// The store asks the tool registry whether a tool mutates, for message
// derivation only. The real registry drags in the whole component tree (icon
// sets and all); the merge never consults it for a mode pick.
vi.mock('@/components/tools/knownTools', () => ({
    isMutableTool: () => false,
}));

vi.mock('./sync', () => ({
    sync: {
        onSessionVisible: vi.fn(),
        invalidate: vi.fn(),
        applySettings: vi.fn(),
    },
}));

import { storage } from './storage';
import { resolveMessageModeMeta } from './messageMeta';
import {
    getAvailableModels,
    getDefaultEffortKey,
    getDefaultModelKey,
    getEffortLevelsForModel,
    resolveCurrentOption,
} from '@/components/modelModeOptions';

const translate = ((key: string) => key) as any;

describe('worker permission projection through the real store', () => {
    it.each([true, false])('does not turn a worker plan tool into an explicit owner permission pick (worker=%s)', (worker) => {
        const id = 'plan-event-' + worker;
        const metadata = { flavor: 'claude', version: '1.0.0', permissionMode: 'default', permissionModeSource: 'ambient',
            ...(worker ? { orchestration: { role: 'worker', hub: { sessionId: 'H', boundAt: 1, by: 'manual', autonomy: true } } } : {}) };
        storage.getState().applySessions([session(metadata, id)]);
        const result = storage.getState().applyMessages(id, [{
            id: 'message-' + id, localId: null, createdAt: 1, role: 'agent', isSidechain: false,
            content: [{ type: 'tool-call', id: 'enter-' + id, name: 'EnterPlanMode', input: {}, description: null, uuid: id, parentUUID: null }],
        }]);
        // This return value is what sync.applyMessages uses to decide whether
        // to call sessionSetAgentModes and persist an explicit permission pick.
        expect(result.enteredPlanMode).toBe(!worker);
        expect(storage.getState().sessions[id].permissionMode).toBe(worker ? 'bypassPermissions' : 'plan');
    });
    it.each([['claude', 'bypassPermissions'], ['codex', 'yolo']])('shows and sends the %s default only while bound', (flavor, full) => {
        const id = 'worker-default-' + flavor;
        const metadata = { flavor, version: '1.0.0', permissionMode: 'default', permissionModeSource: 'ambient',
            orchestration: { role: 'worker', hub: { sessionId: 'H', boundAt: 1, by: 'manual', autonomy: true } } };
        storage.getState().applySessions([session(metadata, id)]);
        const bound = storage.getState().sessions[id];
        expect(bound.permissionMode).toBe(full);
        expect(resolveMessageModeMeta(bound).permissionMode).toBe(full);
        storage.getState().applySessions([session({ ...metadata, permissionMode: full, permissionModeSource: 'explicit' }, id)]);
        storage.getState().applySessions([session({ ...metadata, permissionMode: full, permissionModeSource: 'explicit', orchestration: undefined }, id)]);
        expect(storage.getState().sessions[id].permissionMode).toBe(full);
        storage.getState().applySessions([session(metadata, id)]);
        storage.getState().applySessions([session({ ...metadata, orchestration: undefined }, id)]);
        expect(storage.getState().sessions[id].permissionMode).toBe('default');
    });
});

/** Session metadata as it arrives: JSON, so an absent field and an explicit
 *  null are the two different things they are on the wire. */
const wire = (metadata: Record<string, unknown>) => JSON.parse(JSON.stringify(metadata));

let nextId = 0;

function session(metadata: Record<string, unknown>, id: string) {
    return {
        id,
        seq: 1,
        createdAt: 1,
        updatedAt: 1,
        active: true,
        activeAt: Date.now(),
        metadata: wire(metadata),
        metadataVersion: 1,
        agentState: null,
        agentStateVersion: 1,
        thinking: false,
        thinkingAt: 0,
        presence: 'online' as const,
        draft: null,
        permissionMode: null,
        modelMode: null,
        effortLevel: null,
    } as any;
}

/**
 * Runs a session through the real merge twice: once as the Claude session it
 * was, then as whatever the switch published. Returns what the store holds.
 */
function mergeSwitch(before: Record<string, unknown>, after: Record<string, unknown>) {
    const id = `s${nextId++}`;
    storage.getState().applySessions([session(before, id)]);
    storage.getState().applySessions([session(after, id)]);
    return storage.getState().sessions[id];
}

const CLAUDE_BEFORE = {
    flavor: 'claude',
    path: '/p',
    host: 'h',
    version: '1.0.0',
    modelMode: 'claude-fable-5-1',
    effortLevel: 'max',
};

const CODEX_AFTER = { flavor: 'codex', path: '/p', host: 'h', version: '1.0.0' };

describe('applySessions with delayed session updates', () => {
    const queued = { queue: [{ key: 'reply', preview: 'next reply', createdAt: 1 }] };

    it('does not resurrect a consumed prompt when an older state finishes decrypting last', () => {
        const initial = session(CLAUDE_BEFORE, 'queue-race');
        storage.getState().applySessions([{ ...initial, agentState: queued, agentStateVersion: 10 }]);
        storage.getState().applySessions([{ ...initial, agentState: {}, agentStateVersion: 11 }]);
        storage.getState().applySessions([{ ...initial, agentState: queued, agentStateVersion: 10 }]);
        expect(storage.getState().sessions[initial.id]).toMatchObject({ agentStateVersion: 11, agentState: {} });
        expect(storage.getState().sessions[initial.id].agentState?.queue).toBeUndefined();
    });

    it('applies new metadata without restoring the queued state captured before decryption', () => {
        const initial = session(CLAUDE_BEFORE, 'metadata-race');
        storage.getState().applySessions([{ ...initial, agentState: {}, agentStateVersion: 11 }]);
        storage.getState().applySessions([{
            ...initial, metadata: { ...initial.metadata, effortLevel: 'high' }, metadataVersion: 2,
            agentState: queued, agentStateVersion: 10,
        }]);
        const current = storage.getState().sessions[initial.id];
        expect(current.agentStateVersion).toBe(11);
        expect(current.agentState?.queue).toBeUndefined();
        expect(current.effortLevel).toBe('high');
        expect(current.metadataVersion).toBe(2);
    });

    it('accepts a new queue while preserving newer metadata and its model/effort mirrors', () => {
        const initial = session(CLAUDE_BEFORE, 'state-race');
        storage.getState().applySessions([{
            ...initial, metadata: { ...initial.metadata, effortLevel: 'high' }, metadataVersion: 2,
        }]);
        storage.getState().applySessions([{ ...initial, agentState: queued, agentStateVersion: 2 }]);
        const current = storage.getState().sessions[initial.id];
        expect(current.agentState?.queue).toEqual(queued.queue);
        expect(current.agentStateVersion).toBe(2);
        expect(current.metadataVersion).toBe(2);
        expect(current.metadata?.effortLevel).toBe('high');
        expect(current.effortLevel).toBe('high');
    });

    it('allows a newer explicit state reset and a subsequent genuinely queued prompt', () => {
        const initial = session(CLAUDE_BEFORE, 'queue-reset');
        storage.getState().applySessions([{ ...initial, agentState: queued, agentStateVersion: 10 }]);
        storage.getState().applySessions([{ ...initial, agentState: null, agentStateVersion: 11 }]);
        expect(storage.getState().sessions[initial.id].agentState).toBeNull();
        storage.getState().applySessions([{ ...initial, agentState: queued, agentStateVersion: 12 }]);
        expect(storage.getState().sessions[initial.id].agentState?.queue).toEqual(queued.queue);
    });
});

/** What the picker would show for a session, the way the composer resolves it. */
function shown(merged: any) {
    const models = getAvailableModels('codex', merged.metadata, translate, merged.modelMode);
    const model = resolveCurrentOption(models, [merged.modelMode, getDefaultModelKey('codex')]);
    const effort = resolveCurrentOption(
        getEffortLevelsForModel('codex', model?.key ?? 'default', merged.metadata, translate),
        [merged.effortLevel, getDefaultEffortKey('codex')],
    );
    return { models, modelKey: model?.key ?? null, effortKey: effort?.key ?? null };
}

beforeEach(() => {
    storage.setState({ sessions: {}, sessionsData: null, sessionListViewData: null } as any);
});

describe('applySessions merging an engine switch', () => {
    it('clears the departed engine model and effort when the CLI publishes them as null', () => {
        const merged = mergeSwitch(CLAUDE_BEFORE, {
            ...CODEX_AFTER,
            // The cleared pair as happy-cli spells it — present and null, which
            // is what survives JSON (see sessionRuntimeMetadata.test.ts).
            modelMode: null,
            effortLevel: null,
        });

        expect(merged.modelMode).toBeNull();
        expect(merged.effortLevel).toBeNull();
        expect(merged.metadata?.flavor).toBe('codex');
    });

    it('sends this engine own default once the pair is cleared, and shows what it sends', () => {
        const merged = mergeSwitch(CLAUDE_BEFORE, { ...CODEX_AFTER, modelMode: null, effortLevel: null });

        const meta = resolveMessageModeMeta(merged);
        expect(meta.model).toBe('gpt-6-astra');
        expect(meta.effort).toBe('medium');

        const ui = shown(merged);
        expect(ui.modelKey).toBe(meta.model);
        expect(ui.effortKey).toBe(meta.effort);
        expect(ui.models.map((model) => model.key)).not.toContain('claude-fable-5-1');
    });

    it('keeps the stale mirror when the switch publishes no model field at all', () => {
        const merged = mergeSwitch(CLAUDE_BEFORE, CODEX_AFTER);

        // Absent, not null: the merge has nothing to apply and the local
        // mirror survives. This is the shape the CLI must never publish.
        expect(merged.modelMode).toBe('claude-fable-5-1');
        expect(merged.effortLevel).toBe('max');
    });

    it('still keeps the stale Claude model off the wire, and offers no row to reselect it', () => {
        const merged = mergeSwitch(CLAUDE_BEFORE, CODEX_AFTER);

        const meta = resolveMessageModeMeta(merged);
        expect(meta.model).not.toBe('claude-fable-5-1');
        expect(meta.model).toBe('gpt-6-astra');
        // The effort went back to Codex's default with the model it belonged to.
        expect(meta.effort).toBe('medium');

        const ui = shown(merged);
        expect(ui.models.map((model) => model.key)).not.toContain('claude-fable-5-1');
        expect(ui.modelKey).toBe(meta.model);
        // The one thing the outbound guard cannot repair: the picker still
        // shows the Claude effort the stale mirror kept, while the turn goes
        // out on Codex's own. That divergence is why the cleared pair has to
        // arrive as an explicit null rather than as an absent field.
        expect(ui.effortKey).toBe('max');
        expect(ui.effortKey).not.toBe(meta.effort);
    });

    it('leaves a custom key no engine claims alone, and shows the same key it sends', () => {
        const merged = mergeSwitch(
            { ...CLAUDE_BEFORE, modelMode: 'codex-test-custom-model', effortLevel: 'high' },
            CODEX_AFTER,
        );

        // Nobody's catalog lists it, so it is not the other engine's model —
        // it belongs to whoever configured it and keeps working.
        expect(merged.modelMode).toBe('codex-test-custom-model');
        const meta = resolveMessageModeMeta(merged);
        expect(meta.model).toBe('codex-test-custom-model');
        expect(meta.effort).toBe('high');

        const ui = shown(merged);
        expect(ui.modelKey).toBe(meta.model);
        expect(ui.effortKey).toBe(meta.effort);
    });
});

describe('applySessions on a same-engine refresh', () => {
    it('keeps the user own Codex pick when the refresh carries no model field', () => {
        const codex = { ...CODEX_AFTER, modelMode: 'gpt-6-astra', effortLevel: 'high' };
        const merged = mergeSwitch(codex, CODEX_AFTER);

        expect(merged.modelMode).toBe('gpt-6-astra');
        expect(merged.effortLevel).toBe('high');

        const meta = resolveMessageModeMeta(merged);
        expect(meta.model).toBe('gpt-6-astra');
        expect(meta.effort).toBe('high');
        expect(shown(merged)).toMatchObject({ modelKey: 'gpt-6-astra', effortKey: 'high' });
    });

    it('applies a model the refresh does carry', () => {
        const merged = mergeSwitch(
            { ...CODEX_AFTER, modelMode: 'codex-test-custom-model', effortLevel: 'high' },
            { ...CODEX_AFTER, modelMode: 'gpt-6-astra', effortLevel: 'medium' },
        );

        expect(merged.modelMode).toBe('gpt-6-astra');
        expect(merged.effortLevel).toBe('medium');
        expect(resolveMessageModeMeta(merged).model).toBe('gpt-6-astra');
    });
});
