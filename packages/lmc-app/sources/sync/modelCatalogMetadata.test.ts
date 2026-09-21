import { describe, expect, it } from 'vitest';
import { withModelCatalogs } from './modelCatalogMetadata';
import { getAvailableModels, getEffortLevelsForModel, getCatalogDefaultEffort, assertModelEffort } from '@/components/modelModeOptions';
import { engineModelGroups } from './engineModelCatalog';
import { resolveMessageModeMeta } from './messageMeta';
import type { Metadata, MachineMetadata } from './storageTypes';

const catalog = (id: string, efforts: string[] | undefined = ['new-depth']) => ({
    runtimeVersion: '9.0.0', capturedAt: 100,
    models: [{ id, name: `Discovered ${id}`, efforts, defaultEffort: efforts?.[0], aliases: ['workspace-alias'] }],
});
const machine = { modelDiscovery: true, modelCatalogs: { claude: catalog('claude-future'), codex: catalog('gpt-future') } } as MachineMetadata;
const metadata = (flavor: string) => ({ path: '/', host: 'test', flavor, sessionCapabilities: { modelDiscovery: true }, engineRuntime: { version: '9.0.0' } } as Metadata);
const t = (key: string) => key;

describe('discovered model catalogs', () => {
    it.each(['claude', 'codex'])('updates %s menus, preserving a selected custom model', engine => {
        const merged = withModelCatalogs(metadata(engine), machine)!;
        const models = getAvailableModels(engine, merged, t, 'private-model');
        expect(models.map(m => m.key)).toEqual([engine === 'claude' ? 'claude-future' : 'gpt-future', 'private-model']);
        expect(getEffortLevelsForModel(engine, 'workspace-alias', merged, t).map(e => e.key)).toEqual(['new-depth']);
        expect(getCatalogDefaultEffort(engine, 'workspace-alias', merged, 'medium')).toBe('new-depth');
        expect(getAvailableModels(engine, merged, t, 'default').some(m => m.key === 'default')).toBe(true);
        const groups = engineModelGroups(engine, merged, t)!;
        expect(groups.flatMap(g => g.models.map(m => m.key))).toEqual(expect.arrayContaining(['claude-future', 'gpt-future']));
    });
    it('does not expose new capabilities to legacy sessions', () => {
        const old = { ...metadata('codex'), sessionCapabilities: undefined };
        expect(withModelCatalogs(old, machine)?.modelCatalogs).toBeUndefined();
    });
    it('keeps a matching session snapshot while the device upgrades its engine', () => {
        const old = { ...metadata('codex'), engineRuntime: { version: '8.0.0' }, modelCatalogs: { codex: { ...catalog('gpt-old'), runtimeVersion: '8.0.0' } } } as Metadata;
        expect(withModelCatalogs(old, machine)?.modelCatalogs?.codex?.models[0].id).toBe('gpt-old');
        expect(withModelCatalogs({ ...old, modelCatalogs: machine.modelCatalogs }, machine)?.modelCatalogs?.codex).toBeUndefined();
    });
    it('uses the SDK package version, not its embedded CLI version', () => {
        const session = { ...metadata('claude'), engineRuntime: { version: '2.1.0', packageVersion: '9.0.0' } } as Metadata;
        expect(withModelCatalogs(session, machine)?.modelCatalogs?.claude?.models[0].id).toBe('claude-future');
    });
    it.each(['claude', 'codex'])('sends discovered %s effort and rejects incompatible explicit choices', engine => {
        const model = engine === 'claude' ? 'claude-future' : 'gpt-future';
        const session = { metadata: metadata(engine), modelMode: model, permissionMode: null, effortLevel: null };
        expect(resolveMessageModeMeta(session, undefined, machine)).toMatchObject({ model, effort: 'new-depth' });
        expect(() => resolveMessageModeMeta({ ...session, effortLevel: 'medium' }, undefined, machine)).toThrow('does not support');
    });
    it('distinguishes no effort from unknown capability and keeps stale catalogs usable', () => {
        const catalogs = { claude: { ...catalog('claude-basic', []), stale: true } };
        expect(getCatalogDefaultEffort('claude', 'claude-basic', { modelCatalogs: catalogs }, 'medium')).toBeNull();
        expect(() => assertModelEffort('claude', 'claude-basic', 'medium', catalogs)).toThrow();
        expect(() => assertModelEffort('claude', 'private-model', 'custom', catalogs)).not.toThrow();
        expect(getCatalogDefaultEffort('claude', 'unknown', { modelCatalogs: catalogs }, 'medium')).toBe('medium');
    });
});
