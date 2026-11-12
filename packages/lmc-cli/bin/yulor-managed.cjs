#!/usr/bin/env node
// Managed Yulor alias: resolve the owner's existing Agent selection on every launch.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
try {
  const home = path.join(os.homedir(), '.lmc', 'agent');
  const selection = JSON.parse(fs.readFileSync(path.join(home, 'runtime-selection.json'), 'utf8'));
  const directory = selection.agent?.directory;
  if (!directory || !path.isAbsolute(directory)) throw Error('No managed Agent selected. Use the existing lmc installation to restore it.');
  let entry = path.join(directory, 'bin', 'yulor.mjs');
  if (!fs.existsSync(entry)) entry = path.join(directory, 'bin', 'happy.mjs');
  if (!fs.existsSync(entry)) throw Error('Selected Agent entry is unavailable. Restore the previous release.');
  const settings = JSON.parse(fs.readFileSync(path.join(home, 'settings.json'), 'utf8'));
  if (!settings.serverUrl) throw Error('The existing centre address is missing.');
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('LMC_') && !key.startsWith('HAPPY_')));
  Object.assign(env, { LMC_HOME_DIR: home, LMC_SERVER_URL: settings.serverUrl, LMC_WEBAPP_URL: settings.serverUrl });
  const result = spawnSync(process.execPath, [entry, ...process.argv.slice(2)], { env, stdio: 'inherit', windowsHide: true });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} catch (error) {
  console.error('Yulor: ' + error.message);
  process.exitCode = 1;
}
