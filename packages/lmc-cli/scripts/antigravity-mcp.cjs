#!/usr/bin/env node
// Native Antigravity MCP entry; this has no credentials or fixed session URL.
const { spawnSync } = require('node:child_process');
const { existsSync } = require('node:fs');
const { isAbsolute } = require('node:path');
const entry = process.env.LMC_AGY_MCP_MODULE;
let target;
try { target = new URL(process.env.HAPPY_HTTP_MCP_URL || ''); } catch {}
if (!entry || !isAbsolute(entry) || !existsSync(entry) || !target || target.protocol !== 'http:' || target.hostname !== '127.0.0.1' || !target.port || target.username || target.password || target.search || target.hash) {
  process.stderr.write('LMC MCP is available only inside its Antigravity session. Start the session through LMC.\n');
  process.exit(2);
}
const nodeBin = (process.platform === 'darwin' && /\/Cellar\/node(?:@\d+)?\//.test(process.execPath) && existsSync('/opt/homebrew/bin/node')) ? '/opt/homebrew/bin/node' : process.execPath;
const child = spawnSync(nodeBin, ['--no-warnings', '--no-deprecation', entry], { env: process.env, stdio: 'inherit', windowsHide: true });
process.exit(child.status ?? 1);
