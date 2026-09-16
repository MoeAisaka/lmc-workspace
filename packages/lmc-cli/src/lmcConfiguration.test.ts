import { afterEach, expect, it, vi } from 'vitest';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
const directory=fs.mkdtempSync(path.join(os.tmpdir(),'lmc-config-'));
afterEach(()=>{vi.unstubAllEnvs();vi.resetModules();});
it('keeps candidate identity separate and uses only the configured center',async()=>{
 vi.stubEnv('LMC_HOME_DIR',directory);vi.stubEnv('LMC_SERVER_URL','http://127.0.0.1:4193');
 vi.stubEnv('HAPPY_SERVER_URL','https://api.cluster-fluster.com');
 // Cleared, not set: the point of the last assertion is that webappUrl falls
 // back to serverUrl when it is not configured. Left inherited, this test reads
 // the real machine's center whenever it runs inside an LMC session.
 vi.stubEnv('LMC_WEBAPP_URL', undefined);
 const {configuration}=await import('./configuration');
 expect(configuration.lmcHomeDir).toBe(directory);expect(configuration.serverUrl).toBe('http://127.0.0.1:4193');expect(configuration.webappUrl).toBe(configuration.serverUrl);
});
