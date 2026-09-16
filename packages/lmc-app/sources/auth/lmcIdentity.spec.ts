import { expect, it, vi } from 'vitest';
vi.mock('@/sync/serverConfig',()=>({getServerUrl:()=> 'http://127.0.0.1:4193'}));
// lmcAuth now reports errors through the translation layer, which reads stored
// settings at import time.
vi.mock('@/sync/persistence', () => ({ loadSettings: () => ({ settings: {} }) }));
import { lmcIdentity } from './lmcAuth';
it('gets the authoritative account ID without decoding opaque credentials',async()=>{
 vi.stubGlobal('fetch',async()=>new Response(JSON.stringify({id:'account-id'}),{status:200}));
 try{expect(await lmcIdentity('opaque-credential')).toBe('account-id');}finally{vi.unstubAllGlobals();}
});
it('rejects an expired login instead of using a guessed identity',async()=>{
 vi.stubGlobal('fetch',async()=>new Response('{}',{status:401}));
 try{await expect(lmcIdentity('expired')).rejects.toThrow();}finally{vi.unstubAllGlobals();}
});
