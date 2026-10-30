import { describe, expect, it } from 'vitest';
import { assertAntigravityProtocol } from './antigravityCompatibility';
import { resolveMessageModeMeta } from './messageMeta';
import { machineModelMetadata } from './modelCatalogMetadata';

describe('Antigravity Agent compatibility', () => {
    it('blocks messages to an old or unknown adapter before they are posted', () => {
        for (const version of [undefined, '1.2.117', 'invalid']) {
            expect(() => resolveMessageModeMeta({ permissionMode: 'default', modelMode: 'default', effortLevel: null, metadata: { path: '', host: '', flavor: 'agy', version } })).toThrow(/Update the LMC Agent/);
        }
    });

    it('allows a compatible adapter without changing Claude or Codex behavior', () => {
        expect(() => assertAntigravityProtocol('agy', '1.2.118')).not.toThrow();
        for (const flavor of ['claude', 'codex']) expect(() => assertAntigravityProtocol(flavor, '1.0.0')).not.toThrow();
    });

    it('carries the selected machine Agent version into new-session model validation', () => {
        expect(machineModelMetadata({ happyCliVersion: '1.2.118' } as any).version).toBe('1.2.118');
    });
});
