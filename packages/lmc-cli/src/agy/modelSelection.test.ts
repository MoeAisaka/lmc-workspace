import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { parseAgyModels } from './modelDiscovery';
import { resolveAgySelection } from './modelSelection';
import { buildAgyArgs } from './cliArgs';
import { spawnWorkerSchema } from '@/modules/orchestration/toolSchemas';
import { applyWorkerConfig } from '@/modules/orchestration/workerConfig';

const catalog = { source: 'native' as const, runtimeVersion: '1.4.7', capturedAt: 1, models: parseAgyModels([
    'claude-opus-5-5-low\tClaude Opus 5.5 (Low)',
    'claude-opus-5-5-medium\tClaude Opus 5.5 (Medium)',
    'claude-opus-5-5-high\tClaude Opus 5.5 (High)',
    'other-model\tOther model',
].join('\n')) };

describe('Antigravity worker model contract', () => {
    it('accepts agy in the actual MCP schema and produces native Medium / YOLO argv', () => {
        const request = z.object(spawnWorkerSchema).parse({duty:'评审',agent:'agy',model:'claude-opus-5-5',effort:'medium',permission_mode:'yolo'});
        const selected = resolveAgySelection(request.model, request.effort, catalog);
        const args = buildAgyArgs({prompt:'fixture',model:selected.model,permissionMode:'yolo'});
        expect(args).toContain('--dangerously-skip-permissions');
        expect(args[args.indexOf('--model')+1]).toBe('claude-opus-5-5-medium');
        expect(args).not.toContain('--effort'); // Official CLI encodes effort in the ID.
    });
    it('retains full native variants from the web UI and can change their effort', () => {
        expect(resolveAgySelection('claude-opus-5-5-high',null,catalog)).toEqual({model:'claude-opus-5-5-high',effort:'high'});
        expect(resolveAgySelection('claude-opus-5-5-high','medium',catalog).model).toBe('claude-opus-5-5-medium');
    });
    it('rejects unadvertised combinations instead of silently changing the model', () => {
        for (const [model,effort] of [['claude-opus-5-5','max'],['unknown','medium'],['default','medium'],['other-model','high']]) {
            expect(()=>resolveAgySelection(model,effort,catalog)).toThrow();
        }
        expect(resolveAgySelection(null,null,catalog).model).toBe('default');
    });
    it('accepts a bound Antigravity worker configuration without routing it through Claude Code', () => {
        const configured = applyWorkerConfig({flavor:'agy',permissionModeSource:'explicit'} as any,
            {model:'claude-opus-5-5',effort:'medium',permissionMode:'yolo'});
        expect(configured).toMatchObject({flavor:'agy',modelMode:'claude-opus-5-5',effortLevel:'medium',permissionMode:'yolo'});
        expect(()=>applyWorkerConfig({flavor:'agy'} as any,{permissionMode:'invented'})).toThrow();
    });
    it('defaults Gemini 4 family selection to high even on older cached catalogs while preserving explicit variants', () => {
        const staleGeminiCatalog = {
            source: 'native' as const,
            runtimeVersion: '1.4.8',
            capturedAt: 1,
            models: [{
                id: 'gemini-4-argon',
                name: 'Gemini 4 Argon',
                efforts: ['medium', 'high', 'low'],
                defaultEffort: 'medium',
                effortModels: { medium: 'gemini-4-argon-medium', high: 'gemini-4-argon-high', low: 'gemini-4-argon-low' },
                aliases: ['gemini-4-argon-medium', 'gemini-4-argon-high', 'gemini-4-argon-low'],
            }],
        };
        expect(resolveAgySelection('gemini-4-argon', undefined, staleGeminiCatalog)).toEqual({ model: 'gemini-4-argon-high', effort: 'high' });
        expect(resolveAgySelection('gemini-4-argon', 'medium', staleGeminiCatalog)).toEqual({ model: 'gemini-4-argon-medium', effort: 'medium' });
        expect(resolveAgySelection('gemini-4-argon-medium', undefined, staleGeminiCatalog)).toEqual({ model: 'gemini-4-argon-medium', effort: 'medium' });
    });
});
