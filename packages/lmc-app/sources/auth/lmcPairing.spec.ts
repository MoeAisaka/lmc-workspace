import { expect, it, vi } from 'vitest';
// These modules now report through the translation layer, and i18n reads
// stored settings when it loads.
vi.mock('@/sync/persistence', () => ({ loadSettings: () => ({ settings: {} }) }));
vi.mock('@/sync/serverConfig',()=>({getServerUrl:()=> 'https://lmc.example'}));
import { lmcPairingKey } from './lmcPairing';
it('accepts only this center’s browser pairing link',()=>{
 const key='a'.repeat(43);
 expect(lmcPairingKey('https://lmc.example/terminal/connect#key='+key)).toBe(key);
 expect(()=>lmcPairingKey('https://other.example/terminal/connect#key='+key)).toThrow();
 expect(()=>lmcPairingKey('https://lmc.example/terminal/connect#key=bad')).toThrow();
});
