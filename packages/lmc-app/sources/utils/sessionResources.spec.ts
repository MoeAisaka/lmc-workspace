import {it,expect} from 'vitest';
import {collectSessionResources} from './sessionResources';
it('finds explicit file edits, patch outputs and assistant resources only',()=>{
 expect(collectSessionResources([
  {kind:'user-text',text:'[private](/tmp/user.txt)'},
  {kind:'tool-call',tool:{name:'Write',state:'completed',input:{file_path:'output/a.png'}}},
  {kind:'tool-call',tool:{name:'apply_patch',state:'completed',input:'*** Add File: output/b.md\n+hi'}},
  {kind:'agent-text',text:'[image](output/a.png) [site](https://example.com/a.png) [doc](</tmp/file name.pdf:12>)'},
 ])).toEqual(['/tmp/file name.pdf','output/b.md','output/a.png']);
});
it('does not present failed writes or reads as generated resources',()=>{
 expect(collectSessionResources([{kind:'tool-call',tool:{name:'Write',state:'error',input:{path:'failed.txt'}}},{kind:'tool-call',tool:{name:'Read',state:'completed',input:{path:'read.txt'}}}])).toEqual([]);
});
