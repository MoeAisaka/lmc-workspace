const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { build } = require('esbuild');

const appRoot = path.resolve(__dirname, '../..');
const repoRoot = path.resolve(appRoot, '../..');

// Account/settings I/O and unrelated visual dependencies are isolated. The
// components under test, RN Web, modal wrappers and group ordering are real.
const mocks={
'react-native-unistyles':`import {StyleSheet as RN} from 'react-native';const theme={dark:false,colors:{surface:'#fff',text:'#222',divider:'#ddd',textSecondary:'#888',status:{error:'#b00'}}};export const useUnistyles=()=>({theme});export const StyleSheet={...RN,create:x=>RN.create(typeof x==='function'?x(theme):x)};`,
'@expo/vector-icons':`import React from 'react';import{Text}from'react-native';export const Ionicons=({name})=><Text>{name==='close'?'×':name}</Text>;`,
'@/constants/Typography':`export const Typography={default:()=>({fontFamily:'sans-serif'})};`,
'@/text':`export const t=(k,p)=>({ 'lmc.common.close':'Close','common.cancel':'Cancel','lmc.orchestration.plain':'Plain','lmc.orchestration.hub':'Hub','lmc.orchestration.worker':'Worker','lmc.orchestration.addWorker':'Add worker','lmc.orchestration.dutyCustom':'Custom duty','lmc.orchestration.dutyCustomPrompt':'Duty','lmc.orchestration.dutyCustomConfirm':'Apply'}[k]??k.split('.').pop());`,
'@/sync/storage':`import React from 'react';export const sessions=['H1','W1','P1','H2','W2','H3'].map((id,i)=>({id,createdAt:i,updatedAt:1,active:true,presence:'online',metadata:{name:id,host:'test',flavor:'claude',orchestration:id[0]==='H'?{role:'hub',workers:id==='H3'?[]:[{sessionId:id==='H1'?'W1':'W2'}]}:id[0]==='W'?{role:'worker',hub:{sessionId:id==='W1'?'H1':'H2'}}:undefined}}));export const useAllSessions=()=>sessions;export const useSession=id=>sessions.find(s=>s.id===id)??null;export const useAllMachines=()=>[];export const store={orders:JSON.parse(localStorage.getItem('orders')||'{}')};export function useSetting(){const[,bump]=React.useState(0);React.useEffect(()=>{const f=()=>bump(n=>n+1);window.addEventListener('saved',f);return()=>window.removeEventListener('saved',f)},[]);return store.orders;}`,
'@/sync/sync':`import{store}from'@/sync/storage';export const sync={applySettings:s=>{store.orders={...store.orders,...s.sessionProjectOrder};localStorage.setItem('orders',JSON.stringify(store.orders));window.dispatchEvent(new Event('saved'));window.saves=(window.saves||0)+1;}};`,
'@/sync/orchestration':`export const bindWorker=async()=>{};export const dissolveHub=async()=>{};export const makeHub=async()=>{};export const migrateWorkers=async()=>{};export const unbindWorker=async()=>{};`,
'@/hooks/useSessionQuickActions':`export const useSessionQuickActions=()=>({actionItems:[]});`,
'@/sync/ops':`export const sessionUpdateMetadata=async()=>{};`,
'@/utils/sessionUtils':`export const getSessionName=s=>s.metadata.name;`,
'@/utils/lmc/deviceEngineGroups':`export const engineKeyForSession=s=>s.metadata.flavor;export const isArchivedForList=s=>false;export const machineDisplayName=(m,h)=>h;`,
'@/components/AnimatedOverlay':`export const AnimatedBlurBackdrop=()=>null;`,
'@/components/CommandPalette/CommandPaletteModal':`export const CommandPaletteModal=()=>null;`,
'@/components/CommandPalette':`export const CommandPalette=()=>null;`,
};

async function buildFixture(outputDir) {
    const dir = outputDir || fs.mkdtempSync(path.join(os.tmpdir(), 'lmc-ui-check-'));
    fs.mkdirSync(dir, { recursive: true });
    const aliases = { 'react-native': 'react-native-web', '@': path.join(appRoot, 'sources') };
    for (const [name, code] of Object.entries(mocks)) {
        const file = path.join(dir, `mock-${Object.keys(aliases).length}.tsx`);
        fs.writeFileSync(file, code);
        aliases[name] = file;
    }
    const unrelatedUi = {
        name: 'unrelated-ui',
        setup(builder) {
            builder.onResolve({ filter: /\/Toast$|\.\/components\/WebAlertModal$|\.\/components\/WebPromptModal$/ }, args => ({ path: args.path, namespace: 'stub' }));
            builder.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
                contents: 'export const showToast=()=>{}; export const WebAlertModal=()=>null; export const WebPromptModal=()=>null;',
                loader: 'js',
            }));
        },
    };
    await build({
        entryPoints: [path.join(__dirname, 'entry.tsx')],
        bundle: true, outfile: path.join(dir, 'app.js'),
        nodePaths: [path.join(appRoot, 'node_modules'), path.join(repoRoot, 'node_modules')],
        alias: aliases, plugins: [unrelatedUi],
        define: { 'process.env.NODE_ENV': '"development"' }, logLevel: 'warning',
    });
    fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0;font:14px sans-serif}</style></head><body><div id="root"></div><script src="app.js"></script></body></html>');
    return dir;
}

module.exports = { buildFixture };
if (require.main === module) {
    buildFixture(process.env.LMC_UI_CHECK_DIR).then(dir => console.log(`Fixture: ${dir}`)).catch(error => {
        console.error(error); process.exitCode = 1;
    });
}
