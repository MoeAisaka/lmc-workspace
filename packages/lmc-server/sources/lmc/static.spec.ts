import { afterAll, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startApi } from '@/app/api/api';
let app:any;
afterAll(async()=>{if(app)await app.close();});
it('serves newly published assets and returns 404 for missing scripts without crashing',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'lmc-static-'));writeFileSync(join(dir,'index.html'),'<html><head></head><body>LMC</body></html>');mkdirSync(join(dir,'_expo'));
 const started=await startApi({port:0,host:'127.0.0.1',staticDir:dir,injectHtmlConfig:{disableAnalytics:true}});app=(started as any).app;
 expect(app).toBeDefined();
 writeFileSync(join(dir,'_expo','new.js'),'window.lmc=true;');
 const found=await app.inject({url:'/_expo/new.js'});expect(found.statusCode).toBe(200);expect(found.body).toBe('window.lmc=true;');
 expect((await app.inject({url:'/_expo/missing.js'})).statusCode).toBe(404);
 const html=await app.inject({url:'/terminal/connect'});expect(html.statusCode).toBe(200);expect(html.body).toContain('__HAPPY_CONFIG__');expect(html.headers['content-security-policy']).toContain("connect-src 'self'");
});
