import { describe, expect, it } from 'vitest';
import { MachineMetadataSchema } from './types';
import { initialMachineMetadata } from '@/daemon/run';

/**
 * Step two of the happy -> lmc wire rename: writers send both spellings while
 * readers catch up.
 *
 * The schema has no passthrough, so zod strips anything undeclared. That makes
 * this worth asserting rather than assuming: if lmcCliVersion were not declared
 * it would be dropped on the way out, the app would keep falling back to the old
 * name, and the rename would look done while nothing had actually moved.
 */
describe('machine metadata dual-write', () => {
    it('sends both names with the same value', () => {
        expect(initialMachineMetadata.lmcCliVersion).toBe(initialMachineMetadata.happyCliVersion);
        expect(initialMachineMetadata.lmcHomeDir).toBe(initialMachineMetadata.happyHomeDir);
    });

    it('keeps the new names through validation instead of stripping them', () => {
        const parsed = MachineMetadataSchema.parse(initialMachineMetadata);
        expect(parsed.lmcCliVersion).toBe(initialMachineMetadata.happyCliVersion);
        expect(parsed.lmcHomeDir).toBe(initialMachineMetadata.happyHomeDir);
    });

    it('still accepts metadata carrying only the old names', () => {
        const { lmcCliVersion, lmcHomeDir, ...oldOnly } = initialMachineMetadata;
        const parsed = MachineMetadataSchema.safeParse(oldOnly);
        expect(parsed.success).toBe(true);
    });
});
