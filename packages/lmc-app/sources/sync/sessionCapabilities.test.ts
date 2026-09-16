import { expect, it } from 'vitest';
import { sessionCapabilities } from './sessionCapabilities';
import type { Metadata } from './storageTypes';
it('uses explicit capabilities for both engines and refuses unadvertised Claude RPCs', () => {
    for (const flavor of ['claude','codex']) {
        expect(sessionCapabilities({ flavor, sessionCapabilities: { refresh:true, authentication:true, runtimeConfiguration:false } } as Metadata)).toEqual({refresh:true,authentication:true,runtimeConfiguration:false});
    }
    expect(sessionCapabilities({flavor:'claude',sessionConfiguration:true} as Metadata).refresh).toBe(false);
    expect(sessionCapabilities({flavor:'codex',sessionConfiguration:true} as Metadata).refresh).toBe(true);
    expect(sessionCapabilities(undefined).refresh).toBe(false);
});
