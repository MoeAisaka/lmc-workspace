// Real React sorters and browser CSS. Synthetic settings only; no production API.
const fs=require('fs'),path=require('path'),os=require('os'),assert=require('assert/strict'),http=require('http');
const esbuild=require('esbuild');
const {chromium}=require(process.env.LMC_PLAYWRIGHT_MODULE||'playwright-core');
const app=path.resolve('packages/lmc-app/sources');
const out=fs.mkdtempSync(path.join(os.tmpdir(),'lmc-sort-animation-'));
const stub=`import * as React from 'react';
let state={},listeners=new Set();window.saves=[];
export const useSetting=()=>React.useSyncExternalStore(f=>{listeners.add(f);return()=>listeners.delete(f)},()=>state);
export const sync={applySettings(delta){state={...state,...delta.sessionProjectOrder};window.saves.push(performance.now());listeners.forEach(f=>f())}};
export const useUnistyles=()=>({theme:{colors:{surface:'#fff',surfaceHighest:'#eee'}}});
export const t=s=>s;
export const useDragTarget={getState:()=>({setTarget(){}})};`;
const entry=`import * as React from 'react';import {createRoot} from 'react-dom/client';
import {SortableHubGroups} from './packages/lmc-app/sources/components/lmc/SortableHubGroups.web';
import {SortableSessionRows} from './packages/lmc-app/sources/components/SortableSessionRows.web';
const rows=[{id:'A'},{id:'B'},{id:'C'}],h=React.createElement;
let kindNow;const item=(s)=>h('div',{'data-item':s.id,style:{marginTop:kindNow==='hubs'?8:0,height:({A:80,B:120,C:64})[s.id],background:'#ddd'}},s.id);
window.mount=(kind)=>{kindNow=kind;window.saves.length=0;createRoot(document.getElementById('root')).render(kind==='hubs'?h(SortableHubGroups,{storageKey:'test',items:rows,getId:s=>s.id,renderItem:item}):h(SortableSessionRows,{groupId:'test',sessions:rows,renderRow:item}));};`;
(async()=>{
 await esbuild.build({stdin:{contents:entry,resolveDir:process.cwd(),loader:'tsx'},bundle:true,outfile:path.join(out,'app.js'),platform:'browser',plugins:[{name:'fixture',setup(b){b.onResolve({filter:/^(react-native-unistyles|@\/sync\/(storage|sync)|@\/text|\.\/lmc\/dragTargetStore)$/},()=>({path:'stub',namespace:'fixture'}));b.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:stub,loader:'js',resolveDir:process.cwd()}));b.onResolve({filter:/^@\//},args=>({path:path.join(app,args.path.slice(2)+'.ts')}));}}]});
 const server=http.createServer((req,res)=>{res.end(req.url==='/app.js'?fs.readFileSync(path.join(out,'app.js')):'<div id="root" style="width:300px"></div><script src="/app.js"></script>')});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
 const results=[];
 try{for(const kind of ['hubs','rows'])for(const direction of ['down','up']){
 const page=await browser.newPage();await page.goto('http://127.0.0.1:'+server.address().port);await page.evaluate(k=>mount(k),kind);
 await page.waitForSelector('[data-item="A"]');
 const id=direction==='down'?'A':'C',node=page.locator('[data-item="'+id+'"]'),box=await node.boundingBox();
 await page.mouse.move(box.x+40,box.y+20);await page.mouse.down();await page.waitForTimeout(360);await page.mouse.move(box.x+40,direction==='down'?260:20,{steps:12});await page.waitForTimeout(220);
 await page.evaluate(()=>{window.samples=[];window.record=true;function tick(){if(!window.record)return; samples.push({saved:saves.length,positions:[...document.querySelectorAll('[data-item]')].map(e=>({id:e.dataset.item,top:e.getBoundingClientRect().top}))});requestAnimationFrame(tick)}requestAnimationFrame(tick)});
 await page.mouse.up();await page.waitForTimeout(500);
 const data=await page.evaluate(()=>{window.record=false;return{samples,saves:saves.length,order:[...document.querySelectorAll('[data-item]')].map(e=>e.dataset.item)}});
 const final=data.samples.at(-1).positions;const drift=Math.max(0,...data.samples.filter(s=>s.saved).flatMap(s=>s.positions.map(p=>Math.abs(p.top-final.find(f=>f.id===p.id).top))));
 const beforeCommit=data.samples.filter(s=>!s.saved).at(-1);const afterCommit=data.samples.find(s=>s.saved);const commitJump=Math.max(...afterCommit.positions.filter(p=>p.id!==id).map(p=>Math.abs(p.top-beforeCommit.positions.find(f=>f.id===p.id).top)));
 results.push({kind,direction,drift,commitJump,saves:data.saves,order:data.order});await page.close();
 }
 fs.writeFileSync(path.join(out,'results.json'),JSON.stringify(results,null,2));console.log(JSON.stringify({out,results},null,2));
 for(const r of results){assert.equal(r.saves,1);assert.deepEqual(r.order,r.direction==='down'?['B','C','A']:['C','A','B']);assert.ok(r.commitJump<1,`${r.kind}/${r.direction}: neighbour commit jump ${r.commitJump}px`);assert.ok(r.drift<1,`${r.kind}/${r.direction}: second movement ${r.drift}px`)}
 }finally{await browser.close();server.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
