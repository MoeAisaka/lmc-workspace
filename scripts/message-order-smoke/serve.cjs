// Serve an exported Metro build with synthetic messages and the real storage /
// ChatList. No app bootstrap, authentication or production network access.
// Usage: node scripts/message-order-smoke/serve.cjs /tmp/web-build [port]
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const root = path.resolve(process.argv[2]);
const fixtureFile = process.argv[4] ? path.resolve(process.argv[4]) : path.join(__dirname, 'fixture.js');
const scripts = [...fs.readFileSync(path.join(root, 'index.html'), 'utf8').matchAll(/<script src="([^"]+)"/g)].map(m => m[1]);
const main = scripts.at(-1);
const capture = `window.modules=new Map();const define=window.__d;
window.__d=(factory,id,deps)=>{modules.set(id,{factory,deps});define(factory,id,deps)};
window.moduleExport=name=>{const re=new RegExp('\\\\.'+name+'\\\\s*=(?!=)');
for(const[id,m]of modules)if(re.test(m.factory.toString())||m.factory.toString().includes(JSON.stringify(name))){const e=__r(id);if(e[name])return e;}
throw new Error('Missing export: '+name);};`;
const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>html,body,#root{margin:0;height:100%;font:14px system-ui}button{padding:10px;margin:3px}nav{padding:8px;background:#eef3fa}pre{margin:8px;white-space:pre-wrap;font-size:12px}</style></head>
<body><div id="root"></div>${scripts.map((s,i)=>`<script src="${s}"></script>${i===0?'<script src="/capture.js"></script>':''}`).join('')}<script src="/fixture.js"></script></body></html>`;
const server = http.createServer((req, res) => {
    let content, type = 'text/javascript';
    if (req.url === '/') { content = html; type = 'text/html'; }
    else if (req.url === '/capture.js') content = capture;
    else if (req.url === '/fixture.js') content = fs.readFileSync(fixtureFile);
    else {
        const pathname = decodeURIComponent(req.url.split('?')[0]);
        const file = path.resolve(root, '.' + pathname);
        if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); res.end(); return; }
        content = fs.readFileSync(file);
        if (pathname === main) content = content.toString().replace(/__r\(0\);\s*$/, '');
        if (pathname.endsWith('.ttf')) type = 'font/ttf';
        if (pathname.endsWith('.png')) type = 'image/png';
        if (pathname.endsWith('.css')) type = 'text/css';
    }
    res.setHeader('Content-Type', type);
    res.setHeader('Content-Security-Policy', "default-src 'self' data: blob:; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; connect-src 'none'");
    res.end(content);
});
server.listen(Number(process.argv[3] || 0), '127.0.0.1', () => console.log(`Order fixture: http://127.0.0.1:${server.address().port}`));
process.on('SIGTERM', () => server.close());
