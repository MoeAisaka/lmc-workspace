// Exercise the actual exported Metro modules, styles and icons with synthetic
// messages. No app bootstrap, authentication, browser profile or production API.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const { chromium } = require(process.env.LMC_PLAYWRIGHT_MODULE || 'playwright-core');
const root = path.resolve(process.argv[2] || '/tmp/lmc-message-image-20261013');
const out = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'lmc-message-image-check-'));
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
const markdown = '# 回复图片验证\n\n这是**完整正文**，包含中文、English、链接 https://example.com 和 `inline code`。\n\n1. 第一项\n2. 第二项\n\n> 引用说明\n\n| 项目 | 验收标准 |\n| --- | --- |\n| Codex | 新消息留在新轮次 |\n| Claude | 同一入口可用 |\n\n```js\nconst example = "a long line preserves the whole code block";\nconsole.log(example);\n```\n\n<details><summary>补充说明</summary>\n\n折叠的正文也要出现在图片里。\n\n</details>\n\n<options>\n<option>继续核对</option>\n<option>完成</option>\n</options>\n\n**正文最后一行 END-MARKER**';
const fixture = `
const init=modules.get(0); __r(init.deps[0]);__r(init.deps[1]);
const React=moduleExport('useState'),h=React.createElement,{createRoot}=moduleExport('createRoot');
const {MessageView}=moduleExport('MessageView');
const {ModalProvider}=moduleExport('ModalProvider');
const {UnistylesRuntime}=moduleExport('UnistylesRuntime');
window.pngs=[];window.toasts=[];window.errors=[];window.downloads=[];window.writes=[];
moduleExport('showToast').showToast=(...args)=>toasts.push(args);
window.addEventListener('unhandledrejection',e=>errors.push(String(e.reason)));
window.setTheme=theme=>{UnistylesRuntime.setAdaptiveThemes(false);UnistylesRuntime.setTheme(theme);document.body.style.background=theme==='dark'?'#202020':'#fff'};
Object.defineProperty(navigator,'clipboard',{configurable:true,value:{write(items){writes.push({time:performance.now(),hasRender:!!document.querySelector('[data-message-image]')});if(window.deny)return Promise.reject(new Error('denied'));return Promise.all(items.map(async item=>{const blob=await item.getType('image/png');const buffer=await blob.arrayBuffer();pngs.push({type:blob.type,bytes:Array.from(new Uint8Array(buffer))})})).then(()=>{})}}});
function App(){const [state,set]=React.useState({sid:'codex',text:${JSON.stringify(markdown)}});window.renderReply=next=>set(next);
return h(ModalProvider,null,h('main',{style:{maxWidth:900,margin:'24px auto',padding:'0 16px'}},h(MessageView,{message:{id:'fixture-reply',kind:'agent-text',text:state.text,createdAt:1,localId:null},metadata:{flavor:state.sid},copyText:state.text,sessionId:state.sid})));}
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
 const browser=await chromium.launch({headless:true,executablePath:process.env.LMC_CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',args:['--disk-cache-size=0','--renderer-process-limit=4','--disable-extensions']});
 const results=[];
 try{
  const origin='http://127.0.0.1:'+server.address().port;
  const context=await browser.newContext({viewport:{width:390,height:900}});
  await context.route('**/*',route=>route.request().url().startsWith(origin)||route.request().url().startsWith('data:')?route.continue():route.abort());
  const page=await context.newPage();
  page.on('pageerror',e=>console.error(e));
  await page.goto(origin);
  for(const [sid,theme,width] of [['codex','light',390],['claude','light',1200],['codex','dark',1200],['claude','dark',390]]){
   await page.setViewportSize({width,height:900});
   await page.evaluate(({sid,text,theme})=>{setTheme(theme);renderReply({sid,text});pngs=[]}, {sid,text:markdown,theme});
   await page.getByRole('button',{name:'复制成图片',exact:true}).click();
   await page.waitForFunction(()=>pngs.length===1,{},{timeout:30000});
   const png=await page.evaluate(()=>pngs[0]);
   assert.equal(png.type,'image/png');
   const bytes=Buffer.from(png.bytes);fs.writeFileSync(path.join(out,`${sid}-${theme}-${width}.png`),bytes);
   const w=bytes.readUInt32BE(16),ht=bytes.readUInt32BE(20);
   assert(w>=760&&ht>900);results.push({sid,theme,width,png:[w,ht]});
   await page.waitForFunction(()=>!document.querySelector('[data-message-image]'));
  }
  const wide='| '+Array.from({length:12},(_,i)=>'第'+i+'列').join(' | ')+' |\n| '+Array(12).fill('---').join(' | ')+' |\n| '+Array.from({length:12},(_,i)=>'完整数据第'+i+'列').join(' | ')+' |';
  await page.evaluate(text=>{renderReply({sid:'codex',text});pngs=[]},wide);
  await page.getByRole('button',{name:'复制成图片',exact:true}).click();
  await page.waitForFunction(()=>pngs.length===1,{},{timeout:30000});
  const wideBytes=Buffer.from(await page.evaluate(()=>pngs[0].bytes));fs.writeFileSync(path.join(out,'wide.png'),wideBytes);
  assert(wideBytes.readUInt32BE(16)>1800);results.push({widePng:[wideBytes.readUInt32BE(16),wideBytes.readUInt32BE(20)]});
  await page.waitForFunction(()=>!document.querySelector('[data-message-image]'));
  const long=markdown+'\n\n'+Array.from({length:65},(_,i)=>`第 ${i+1} 段：完整长正文，不应只截屏幕内的部分。`).join('\n\n')+'\n\n**VERY-LAST-LINE**';
  await page.evaluate(text=>{setTheme('light');renderReply({sid:'codex',text});pngs=[]},long);
  await page.getByRole('button',{name:'复制成图片',exact:true}).click();
  await page.waitForFunction(()=>pngs.length===1,{},{timeout:30000});
  const bytes=Buffer.from(await page.evaluate(()=>pngs[0].bytes));fs.writeFileSync(path.join(out,'long.png'),bytes);
  assert(bytes.readUInt32BE(20)>5000);results.push({longPng:[bytes.readUInt32BE(16),bytes.readUInt32BE(20)]});
  await page.waitForFunction(()=>!document.querySelector('[data-message-image]'));
  await page.evaluate(()=>{deny=true});
  await page.getByRole('button',{name:'复制成图片',exact:true}).click();
  await page.getByText('图片已生成',{exact:true}).waitFor({timeout:30000});
  const download=page.waitForEvent('download');
  await page.getByText('保存图片',{exact:true}).click();
  assert.equal((await download).suggestedFilename(),'lmc-reply.png');
  assert.deepEqual(await page.evaluate(()=>errors),[]);
  assert((await page.evaluate(()=>writes)).every(w=>w.hasRender===false));
  await page.screenshot({path:path.join(out,'controls.png')});
  fs.writeFileSync(path.join(out,'result.json'),JSON.stringify(results,null,2));
  console.log(JSON.stringify({passed:true,results,out}));
 }finally{await browser.close();server.close();}
})().catch(e=>{console.error(e);server.close();process.exitCode=1;});
