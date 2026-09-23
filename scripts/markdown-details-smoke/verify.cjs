// Exercise the actual exported Metro modules, styles and icons with synthetic
// messages. No app bootstrap, authentication, browser profile or production API.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const { chromium } = require(process.env.LMC_PLAYWRIGHT_MODULE || 'playwright-core');
const root = path.resolve(process.argv[2] || '/tmp/lmc-markdown-details-web');
const out = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'lmc-markdown-details-check-'));
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
const fixture = `
const init=modules.get(0); __r(init.deps[0]);__r(init.deps[1]);
const React=moduleExport('useState'),h=React.createElement,{createRoot}=moduleExport('createRoot');
const {MarkdownView}=moduleExport('MarkdownView');
const {UnistylesRuntime}=moduleExport('UnistylesRuntime');
window.setTheme=theme=>{UnistylesRuntime.setAdaptiveThemes(false);UnistylesRuntime.setTheme(theme);document.body.style.background=theme==='dark'?'#202020':'#fff'};
const initial = "本轮未修改配置，也未触发推理测试。\\n<details>\\n\\n<summary>历史核对记录</summary>\\n\\nMCP 搜索：**核对额度来源**。\\n- [官方接入说明](https://example.com)\\n- 保留原有配置\\n\\n| 项目 | 结果 |\\n|---|---|\\n| 默认模型 | 本地运行 |\\n\\n<details><summary>代码示例</summary>\\n\`\`\`html\\n<details>literal example</details>\\n\`\`\`\\n</details>\\n<options>\\n<option>继续查看</option>\\n</options>\\n<img src=x onerror=alert(1)>\\n</details>\\n\\n后文仍然正常显示。\\n\\n<details open><summary>默认展开</summary>已有 open 属性的正文</details>\\n\\n<details><summary>生成中的记录</summary>第一部分";
function App(){const [markdown,setMarkdown]=React.useState(initial);window.updateMarkdown=setMarkdown;window.initialMarkdown=initial;
return h('main',{style:{maxWidth:850,margin:'24px auto',padding:'0 16px'}},h(MarkdownView,{markdown,onOptionPress:option=>{window.chosenOption=option.title}}));}
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
  const history=page.getByRole('button',{name:'历史核对记录',exact:true});
  await history.waitFor();
  assert.equal(await history.getAttribute('aria-expanded'),'false');
  assert.equal(await page.getByText('核对额度来源',{exact:true}).count(),0);
  assert.equal(await page.getByText('已有 open 属性的正文',{exact:true}).count(),1);
  assert.equal(await page.getByText('后文仍然正常显示。',{exact:true}).count(),1);
  assert.ok(!(await page.locator('main').innerText()).includes('<summary>'));
  await history.click();
  await page.getByText('核对额度来源',{exact:true}).waitFor();
  assert.equal(await history.getAttribute('aria-expanded'),'true');
  assert.equal(await page.getByRole('link',{name:'官方接入说明'}).count(),1);
  assert.equal(await page.getByText('默认模型',{exact:true}).count(),1);
  assert.equal(await page.locator('main img').count(),0,'HTML must remain inert');
  await page.getByText('继续查看',{exact:true}).click();
  assert.equal(await page.evaluate(()=>chosenOption),'继续查看');
  const nested=page.getByRole('button',{name:'代码示例',exact:true});
  await nested.click();
  assert.ok((await page.locator('main').innerText()).includes('<details>literal example</details>'));
  await nested.click();
  const streaming=page.getByRole('button',{name:'生成中的记录',exact:true});
  await streaming.click();
  await page.evaluate(()=>updateMarkdown(initialMarkdown+'\n新增证据\n</details>\n后续内容'));
  await page.getByText('新增证据',{exact:true}).waitFor();
  assert.equal(await streaming.getAttribute('aria-expanded'),'true','stream updates preserve the user toggle');
  assert.equal(await history.getAttribute('aria-expanded'),'true');
  await page.getByText('后续内容',{exact:true}).waitFor();
  for(const theme of ['light','dark']){
   await page.evaluate(theme=>setTheme(theme),theme);
   for(const width of [320,390,1100]){
    await page.setViewportSize({width,height:1000});
    await page.waitForTimeout(100);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    const box=await history.boundingBox();assert.ok(box.height>=44 && box.x>=0 && box.x+box.width<=width);
    await page.screenshot({path:path.join(out,theme+'-'+width+'.png'),fullPage:true});
   }
  }
  await history.focus();await page.keyboard.press('Enter');
  assert.equal(await history.getAttribute('aria-expanded'),'false');
  assert.equal(await page.getByText('核对额度来源',{exact:true}).count(),0);
  await page.screenshot({path:path.join(out,'collapsed.png'),fullPage:true});
  assert.deepEqual(errors,[]);
  console.log('PASS actual MarkdownView: default collapse/open, click/keyboard, nested code, lists/table/links/options, inert HTML, streaming state, light/dark 320/390/1100');
 }finally{await browser.close();server.close();}
})().catch(e=>{console.error(e);server.close();process.exit(1)});
