const path=require('node:path');
const esbuild=require('esbuild');
const reviewDir=process.env.LMC_SORT_REVIEW_DIR;
if(!reviewDir)throw new Error('Run verify.cjs to create the isolated fixture directory');
const fs=require('fs');
const root=path.resolve(__dirname,'../..');
const mocks={
'@/hooks/useSessionQuickActions':`export const useSessionActionAlert=()=>()=>{};`,
'react-native-unistyles':`export const useUnistyles=()=>({theme:{colors:{surface:'#fff',surfaceHighest:'#eceff4',textSecondary:'#7b8494',groupped:{background:'#f7f8fa'}}}});`,
'@/text':`export const t=()=> '拖动排序';`,
'@/sync/storage':`import React from 'react';export const store={orders:{}};export function useSetting(){const [,update]=React.useState(0);React.useEffect(()=>{const f=()=>update(n=>n+1);window.addEventListener('saved',f);return()=>window.removeEventListener('saved',f)},[]);return store.orders;}`,
'@/sync/sync':`import {store} from '@/sync/storage';export const sync={applySettings:(s)=>{store.orders={...store.orders,...s.sessionProjectOrder};window.dispatchEvent(new Event('saved'));document.getElementById('result').textContent=JSON.stringify(store.orders)}};`
};
fs.writeFileSync(reviewDir+'/entry.tsx',`import React from 'react';import{createRoot}from'react-dom/client';import{SortableSessionRows}from '${root}/packages/lmc-app/sources/components/SortableSessionRows.web';
import{Pressable}from'react-native';import{useSessionRowMenu}from '${root}/packages/lmc-app/sources/hooks/useSessionRowMenu';function Row({s}){const{anchor,menuProps}=useSessionRowMenu(s.id);React.useEffect(()=>{if(anchor)document.getElementById('action').textContent='菜单 '+s.id},[anchor]);return <Pressable {...menuProps} onPress={()=>document.getElementById('action').textContent='打开 '+s.id} style={{height:40,paddingHorizontal:12,justifyContent:'center'}}>【项目】会话 {s.id}</Pressable>;}function App(){const [disabled,setDisabled]=React.useState(false);return <><h2>LMC 列表排序验收</h2><label><input type="checkbox" onChange={e=>setDisabled(e.target.checked)}/>搜索中（禁用排序）</label><div style={{background:'#f7f8fa',padding:24,width:280,marginTop:20}}><p>MacBook Codex</p><SortableSessionRows groupId="test" disabled={disabled} sessions={['A','B','C'].map(id=>({id})) as any} renderRow={s=><Row s={s}/>}/></div><p id="action">无误触</p><pre id="result">未修改顺序</pre></>};createRoot(document.getElementById('root')!).render(<App/>);`);
const aliases={};for(const [name,code]of Object.entries(mocks)){const path=reviewDir+'/mock-'+Object.keys(aliases).length+'.js';fs.writeFileSync(path,code);aliases[name]=path;}
esbuild.buildSync({entryPoints:[reviewDir+'/entry.tsx'],bundle:true,outfile:reviewDir+'/app.js',nodePaths:[root+'/node_modules'],alias:{...aliases,'react-native':'react-native-web','@/utils/pointerEvents':root+'/packages/lmc-app/sources/utils/pointerEvents.ts','@/sync/sessionOrder':root+'/packages/lmc-app/sources/sync/sessionOrder.ts','@/utils/sessionSortGesture':root+'/packages/lmc-app/sources/utils/sessionSortGesture.ts'},plugins:[]});

fs.writeFileSync(reviewDir+'/index.html','<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{font:14px system-ui}</style><div id="root"></div><script src="app.js"></script>');
