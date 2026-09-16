import {it,expect} from 'vitest';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {ResourceReview} from './resourceReview';
it('keeps explicit Claude and Codex file changes across reconnect and viewed checkpoints',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'lmc-review-'));
 try{
  const review=new ResourceReview(dir);
  await review.observe({id:'start',turn:'t1',ev:{t:'turn-start'}} as any);
  await review.observe({id:'a',turn:'t1',ev:{t:'tool-call-start',call:'a',name:'Edit',args:{file_path:'a.ts',old_string:'old',new_string:'new'}}} as any);
  await review.observe({id:'b',turn:'t1',ev:{t:'tool-call-start',call:'b',name:'CodexPatch',args:{changes:{'b.ts':{type:'add',content:'hi'},'old.ts':{type:'update',move_path:'new.ts',unified_diff:'-a\n+b'}}}}} as any);
  const result=await new ResourceReview(dir).read('turn');
  expect(result.entries.map(e=>e.path)).toEqual(['a.ts','b.ts','old.ts']);
  expect(result.entries[2].destination).toBe('new.ts');
  await review.markViewed(result.cursor);
  expect((await review.read('unseen')).entries).toEqual([]);
  await review.observe({id:'c',turn:'t2',ev:{t:'tool-call-start',call:'c',name:'apply_patch',args:{input:'*** Begin Patch\n*** Delete File: a.ts\n*** End Patch'}}} as any);
  expect((await review.read('unseen')).entries[0].kind).toBe('delete');
  expect((await review.read('all')).paths).toContain('b.ts');
 }finally{await rm(dir,{recursive:true,force:true});}
});
