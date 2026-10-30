import {describe,it,expect} from 'vitest';
import {canonicalPageRedirect as redirect} from './canonicalPageOrigin';
describe('canonical same-host browser entry',()=>{
 it('preserves the route/query and uses only the configured target',()=>{
  expect(redirect('lmc.example','/new?test=1','https://lmc.example:8443')).toBe('https://lmc.example:8443/new?test=1');
  expect(redirect('lmc.example','//evil.example/new','https://lmc.example:8443')).toBe('https://lmc.example:8443/new');
 });
 it('does not redirect the canonical entry, other hosts, or non-HTTPS setups',()=>{
  expect(redirect('lmc.example:8443','/','https://lmc.example:8443')).toBeNull();
  expect(redirect('center:4193','/','https://lmc.example:8443')).toBeNull();
  expect(redirect('localhost','/','http://localhost:4193')).toBeNull();
 });
});
