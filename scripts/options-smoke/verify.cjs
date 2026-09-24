// Exercise the actual exported Metro modules, styles and icons with synthetic
// messages. No app bootstrap, authentication, browser profile or production API.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const { chromium } = require(process.env.LMC_PLAYWRIGHT_MODULE || 'playwright-core');
const root = path.resolve(process.argv[2] || '/tmp/lmc-options-web');
const out = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'lmc-options-check-'));
console.log('Artifacts: '+out);
const originalHtml = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const scripts = [...originalHtml.matchAll(/<script src="([^"]+)"/g)].map(m => m[1]);
const main = scripts.at(-1);
const capture = `window.modules = new Map(); const define = window.__d;
window.__d = (factory,id,deps) => { window.modules.set(id,{factory,deps}); define(factory,id,deps); };
window.moduleExport = name => {
 const re = new RegExp('\\\\.'+name+'\\\\s*=(?!=)');
 for (const [id,m] of window.modules) if (re.test(m.factory.toString()) || m.factory.toString().includes(JSON.stringify(name))) { const e=window.__r(id); if(e[name]) return e; }
 throw new Error('Module export not found: '+name);
};`;
const question = '在现场按 Ctrl+Alt+F3，能否切到登录界面并输入？这能帮助判断还能否先读取故障证据。';
const labels = ['能切换并输入', '能切换，但无法登录', '完全没有响应'];
const initialMarkdown = question+'\n'+labels.map(label=>'- '+label).join('\n');
const fixture = `
const init=modules.get(0); __r(init.deps[0]);__r(init.deps[1]);
const React=moduleExport('useState'),h=React.createElement,{createRoot}=moduleExport('createRoot');
const {MessageView}=moduleExport('MessageView'),{MarkdownView}=moduleExport('MarkdownView');
const {normalizeRawMessage}=moduleExport('normalizeRawMessage');
const {createReducer,reducer}=moduleExport('createReducer');
const {sync}=moduleExport('sync');
const {UnistylesRuntime}=moduleExport('UnistylesRuntime');
window.setTheme=theme=>{UnistylesRuntime.setAdaptiveThemes(false);UnistylesRuntime.setTheme(theme);document.body.style.background=theme==='dark'?'#202020':'#fff'};
window.sent=[];
sync.sendMessage=async (...args)=>window.sent.push(args);
window.initialMarkdown=${JSON.stringify(initialMarkdown)};
function messageFor(engine,text){
 const raw=engine==='codex'
  ?{role:'session',content:{id:'fixture-message',time:1000,role:'agent',turn:'fixture-turn',ev:{t:'text',text}}}
  :{role:'agent',content:{type:'output',data:{type:'assistant',uuid:'fixture-message',message:{role:'assistant',model:'claude-fixture',content:[{type:'text',text}]}}}};
 const normalized=normalizeRawMessage('fixture-raw',null,1000,raw);
 if(!normalized)throw Error('Fixture normalization failed: '+engine);
 const message=reducer(createReducer(),[normalized]).messages.find(m=>m.kind==='agent-text');
 if(!message)throw Error('Missing assistant prose: '+engine);
 return message;
}
function App(){
 const [markdown,setMarkdown]=React.useState(initialMarkdown),[engine,setEngine]=React.useState('codex');
 window.updateMarkdown=setMarkdown;window.setEngine=setEngine;
 return h('main',{style:{maxWidth:850,margin:'24px auto',padding:'0 16px'}},
  h('section',{id:'reply'},h(MessageView,{message:messageFor(engine,markdown),sessionId:'options-fixture',metadata:{flavor:engine}})),
  h('section',{id:'document'},h(MarkdownView,{markdown:initialMarkdown})))
}
const initialMarkdown=window.initialMarkdown;
createRoot(document.getElementById('root')).render(h(App));
`;
const fonts=fs.readdirSync(path.join(root,'assets/sources/assets/fonts')).filter(f=>f.startsWith('IBMPlexSans-')).map(f=>`@font-face{font-family:'${f.split('.')[0]}';src:url('/assets/sources/assets/fonts/${f}')}`).join('');
const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${fonts}body{margin:0;font-family:IBMPlexSans-Regular,Arial,sans-serif}</style><div id="root"></div>${scripts.map((s,i)=>`<script src="${s}"></script>${i===0?'<script src="/capture.js"></script>':''}`).join('')}<script src="/fixture.js"></script>`;
const server=http.createServer((req,res)=>{
 let content, type='text/javascript';
 if(req.url==='/'){content=html;type='text/html';}
 else if(req.url==='/capture.js')content=capture;
 else if(req.url==='/fixture.js')content=fixture;
 else {
  const pathname=decodeURIComponent(req.url.split('?')[0]);
  const file=path.resolve(root,'.'+pathname);
  if(!file.startsWith(root+path.sep)||!fs.existsSync(file)||!fs.statSync(file).isFile()){res.writeHead(404);res.end();return;}
  content=fs.readFileSync(file);
  if(pathname===main)content=content.toString().replace(/__r\(0\);\s*$/,'');
  if(pathname.endsWith('.ttf'))type='font/ttf';
  if(pathname.endsWith('.png'))type='image/png';
  if(pathname.endsWith('.css'))type='text/css';
 }
 res.setHeader('Content-Type',type);res.end(content);
});
(async()=>{
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const browser=await chromium.launch({headless:true,executablePath:process.env.LMC_CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
 try{
  const context=await browser.newContext({viewport:{width:390,height:1000},locale:'zh-CN'});
  await context.route('**/*',route=>new URL(route.request().url()).hostname==='127.0.0.1'?route.continue():route.abort());
  const page=await context.newPage();page.setDefaultTimeout(10000);const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto('http://127.0.0.1:'+server.address().port);
  const reply=page.locator('#reply');
  await reply.getByRole('button',{name:labels[0],exact:true}).waitFor();
  assert.equal(await page.locator('#document').getByRole('button').count(),0,'documents stay ordinary lists');
  const cases=[];
  for(const engine of ['codex','claude']) {
   await page.evaluate(engine=>setEngine(engine),engine);
   for(const theme of ['light','dark']) {
    await page.evaluate(theme=>setTheme(theme),theme);
    for(const width of [320,390,1100]) {
     await page.setViewportSize({width,height:900});
     await page.waitForTimeout(50);
     assert.equal(await reply.getByRole('button').count(),3);
     assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
     for(const label of labels) {
      const button=reply.getByRole('button',{name:label,exact:true});
      const box=await button.boundingBox();
      assert.ok(box.height>=40 && box.x>=0 && box.x+box.width<=width);
     }
     await page.evaluate(()=>{window.sent=[]});
     await reply.getByRole('button',{name:labels[1],exact:true}).click();
     assert.deepEqual(await page.evaluate(()=>sent),[['options-fixture',labels[1],{source:'option'}]]);
     await page.screenshot({path:path.join(out,engine+'-'+theme+'-'+width+'.png'),fullPage:true});
     cases.push({engine,theme,width,buttons:3,clickSentOnce:true});
    }
   }
  }
  await page.evaluate(()=>{window.sent=[]});
  await reply.getByRole('button',{name:labels[2],exact:true}).focus();
  await page.keyboard.press('Enter');
  assert.deepEqual(await page.evaluate(()=>sent),[['options-fixture',labels[2],{source:'option'}]]);
  await page.evaluate(()=>updateMarkdown('检查结果：\n- 已完成构建\n- 已完成验证'));
  await reply.getByText('已完成构建',{exact:true}).waitFor();
  assert.equal(await reply.getByRole('button').count(),0,'ordinary findings stay a list');
  await page.evaluate(()=>updateMarkdown('请选择下一步：\n- 继续'));
  await reply.getByText('继续',{exact:true}).waitFor();
  assert.equal(await reply.getByRole('button').count(),0,'one incomplete choice stays a list');
  await page.evaluate(()=>updateMarkdown('请选择下一步：\n- 继续\n- 暂停'));
  await reply.getByRole('button',{name:'暂停',exact:true}).waitFor();
  assert.equal(await reply.getByRole('button').count(),2);
  await page.evaluate(()=>updateMarkdown('请选择下一步：\n<options>\n<option>明确选项 A</option>\n<option>明确选项 B</option>\n</options>'));
  await reply.getByRole('button',{name:'明确选项 A',exact:true}).waitFor();
  assert.equal(await reply.getByRole('button').count(),2,'explicit XML still renders');
  assert.deepEqual(errors,[]);
  fs.writeFileSync(path.join(out,'results.json'),JSON.stringify({cases,keyboard:true,ordinaryLists:true,streaming:true,explicitXml:true,errors},null,2));
  console.log('PASS actual raw Codex/Claude → reducer → MessageView: 12 light/dark/viewport cases, option click sends once, keyboard, documents and ordinary lists, streaming and explicit XML');
 }finally{await browser.close();server.close();}
})().catch(e=>{console.error(e);server.close();process.exit(1)});
