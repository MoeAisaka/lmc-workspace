import { afterEach, expect, it, vi } from 'vitest';
vi.mock('@/configuration',()=>({configuration:{serverUrl:'http://127.0.0.1:4193'}}));
import { revokeDeviceLogin } from './lmcLogout';
afterEach(()=>vi.unstubAllGlobals());
it('revokes the current device at its own center',async()=>{
 const request=vi.fn().mockResolvedValue({ok:true});vi.stubGlobal('fetch',request);
 await revokeDeviceLogin('synthetic');
 expect(request.mock.calls[0][0]).toBe('http://127.0.0.1:4193/v1/lmc/device/logout');
 expect(request.mock.calls[0][1].headers.Authorization).toBe('Bearer synthetic');
});
it('accepts already revoked credentials but reports unavailable centers',async()=>{
 vi.stubGlobal('fetch',vi.fn().mockResolvedValue({ok:false,status:401}));await expect(revokeDeviceLogin('synthetic')).resolves.toBeUndefined();
 vi.stubGlobal('fetch',vi.fn().mockResolvedValue({ok:false,status:503}));await expect(revokeDeviceLogin('synthetic')).rejects.toThrow('本地凭据仍保留');
});
