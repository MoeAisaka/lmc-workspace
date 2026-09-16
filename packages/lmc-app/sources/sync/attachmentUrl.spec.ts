import {describe,it,expect} from 'vitest';
import {resolveAttachmentUrl,isSameServerUrl} from './attachmentUrl';
describe('attachment origin migration',()=>{
 const current='https://lmc.example:11455';
 it('moves local attachment upload/download to current center',()=>{
  expect(resolveAttachmentUrl('https://preview.example/v1/sessions/s1/attachments/a.enc',current,'s1')).toBe(current+'/v1/sessions/s1/attachments/a.enc');
 });
 it('preserves signed object storage and other sessions',()=>{
  const signed='https://s3.example/bucket/a.enc?signature=abc';
  expect(resolveAttachmentUrl(signed,current,'s1')).toBe(signed);
  const other='https://preview.example/v1/sessions/s2/attachments/a.enc';
  expect(resolveAttachmentUrl(other,current,'s1')).toBe(other);
 });
 it('never attaches credentials to lookalike origins',()=>{
  expect(isSameServerUrl(current+'/v1/file',current)).toBe(true);
  expect(isSameServerUrl('https://lmc.example.evil.test:11455/file',current)).toBe(false);
 });
});
