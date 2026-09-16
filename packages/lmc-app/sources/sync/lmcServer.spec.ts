import { expect, it, vi } from 'vitest';
vi.mock('react-native-mmkv',()=>({MMKV:class{getString(){return undefined;}getBoolean(){return false;}set(){}delete(){}}}));
import { getServerUrl, validateServerUrl } from './serverConfig';
it('uses the current web origin and refuses official server URLs',()=>{
 vi.stubGlobal('window',{location:{origin:'https://lmc.example.test'}});
 expect(getServerUrl()).toBe('https://lmc.example.test');
 expect(validateServerUrl('https://api.cluster-fluster.com').valid).toBe(false);
 expect(validateServerUrl('https://lmc.example.test').valid).toBe(true);
 vi.unstubAllGlobals();
});
