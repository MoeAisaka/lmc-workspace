#!/usr/bin/env node
// Add a Yulor alias to an existing managed install. Never relink/stop the daemon.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const source = path.resolve(__dirname, '../bin/yulor-managed.cjs');
const launcher = fs.readFileSync(source);
const ownMarker = 'Managed Yulor alias';
const dir = process.platform === 'win32' ? path.join(process.env.APPDATA, 'npm') : path.join(os.homedir(), '.local', 'bin');
fs.mkdirSync(dir, { recursive: true });
const targets = process.platform === 'win32'
  ? [['yulor.cjs', launcher],
     ['yulor.cmd', Buffer.from('@echo off\r\nrem Managed Yulor alias\r\nnode "%~dp0yulor.cjs" %*\r\n')],
     ['yulor.ps1', Buffer.from('# Managed Yulor alias\r\n& node "$PSScriptRoot/yulor.cjs" @args\r\nexit $LASTEXITCODE\r\n')]]
  : [['yulor', launcher]];
// Reject every unrelated command before changing any alias in the group.
for (const [name, bytes] of targets) {
  const file = path.join(dir, name);
  if (!fs.existsSync(file)) continue;
  const old = fs.readFileSync(file);
  if (!old.equals(bytes) && !old.toString().includes(ownMarker)) throw Error('An unrelated command already exists: ' + file);
}
function install(name, bytes) {
  const file = path.join(dir, name);
  if (fs.existsSync(file)) {
    const old = fs.readFileSync(file);
    if (old.equals(bytes)) return;
    if (!old.toString().includes(ownMarker)) throw Error('An unrelated command already exists: ' + file);
    fs.copyFileSync(file, file + '.before-' + Date.now(), fs.constants.COPYFILE_EXCL);
  }
  const pending = file + '.yulor-' + process.pid + '.tmp';
  fs.writeFileSync(pending, bytes, { mode: 0o755, flag: 'wx' });
  fs.renameSync(pending, file);
  console.log(JSON.stringify({ file, sha256: crypto.createHash('sha256').update(bytes).digest('hex') }));
}
for (const [name, bytes] of targets) install(name, bytes);
