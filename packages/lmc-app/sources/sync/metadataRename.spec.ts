import { describe, expect, it } from 'vitest';
import { MachineMetadataSchema, MetadataSchema } from './storageTypes';

/**
 * Renaming happy -> lmc on the wire runs in three steps: readers learn the new
 * names, then writers switch, then the old names go. These lock step one.
 *
 * The stake is high because a machine whose metadata fails to parse does not
 * degrade — machineEncryption returns null and the machine vanishes from the
 * app. So both spellings must parse, in either direction, for as long as any
 * device might still be running the other side of the rename.
 */
const machine = (extra: Record<string, unknown>) => ({
    host: 'mini.local',
    platform: 'darwin',
    homeDir: '/Users/me',
    ...extra,
});

describe('machine metadata during the happy -> lmc rename', () => {
    it('reads a pre-rename CLI', () => {
        const parsed = MachineMetadataSchema.parse(machine({
            happyCliVersion: '1.2.42', happyHomeDir: '/Users/me/.lmc/agent',
        }));
        expect(parsed.happyCliVersion).toBe('1.2.42');
        expect(parsed.happyHomeDir).toBe('/Users/me/.lmc/agent');
    });

    it('reads a post-rename CLI through the same fields', () => {
        const parsed = MachineMetadataSchema.parse(machine({
            lmcCliVersion: '1.3.0', lmcHomeDir: '/Users/me/.lmc/agent',
        }));
        expect(parsed.happyCliVersion).toBe('1.3.0');
        expect(parsed.happyHomeDir).toBe('/Users/me/.lmc/agent');
    });

    it('prefers the new name while adual-writing CLI sends both', () => {
        const parsed = MachineMetadataSchema.parse(machine({
            happyCliVersion: 'old', lmcCliVersion: 'new',
            happyHomeDir: '/old', lmcHomeDir: '/new',
        }));
        expect(parsed.happyCliVersion).toBe('new');
        expect(parsed.happyHomeDir).toBe('/new');
    });

    it('still parses when neither is present, rather than dropping the machine', () => {
        const parsed = MachineMetadataSchema.safeParse(machine({}));
        expect(parsed.success).toBe(true);
    });

    it('leaves unknown fields alone', () => {
        const parsed = MachineMetadataSchema.parse(machine({ somethingNewer: 1 })) as Record<string, unknown>;
        expect(parsed.somethingNewer).toBe(1);
    });
});

describe('session metadata during the rename', () => {
    const session = (extra: Record<string, unknown>) => ({ path: '/repo', host: 'mini.local', ...extra });

    it('reads either spelling of the home directory', () => {
        expect(MetadataSchema.parse(session({ happyHomeDir: '/a' })).happyHomeDir).toBe('/a');
        expect(MetadataSchema.parse(session({ lmcHomeDir: '/b' })).happyHomeDir).toBe('/b');
        expect(MetadataSchema.parse(session({ happyHomeDir: '/a', lmcHomeDir: '/b' })).happyHomeDir).toBe('/b');
    });

    it('does not invent the field when it was never sent', () => {
        expect(MetadataSchema.parse(session({})).happyHomeDir).toBeUndefined();
    });
});
