#!/usr/bin/env node
// Add a Yulor alias to an existing managed install. Never relink/stop the daemon.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const source = path.resolve(process.argv[2] || path.resolve(__dirname, '..'), 'bin/yulor-managed.cjs');
const launcher = fs.readFileSync(source);
const ownMarker = 'Managed Yulor alias';
const dir = process.platform === 'win32' ? path.join(process.env.APPDATA, 'npm') : path.join(os.homedir(), '.local', 'bin');
fs.mkdirSync(dir, { recursive: true });
const nodePath = process.platform === 'win32' ? process.execPath
  : ['/opt/homebrew/bin/node', '/usr/local/bin/node', process.execPath].find(file => fs.existsSync(file));
const quotedNode = "'" + nodePath.replace(/'/g, "'\\''") + "'";
const targets = process.platform === 'win32'
  ? [['yulor.cjs', launcher],
     ['yulor.cmd', Buffer.from('@echo off\r\nrem Managed Yulor alias\r\nnode "%~dp0yulor.cjs" %*\r\n')]]
  : [['yulor.cjs', launcher],
     ['yulor', Buffer.from('#!/bin/sh\n# Managed Yulor alias\nexec ' + quotedNode + ' "$(dirname "$0")/yulor.cjs" "$@"\n')]];
// PowerShell can run the .cmd entry under Restricted policy. A .ps1 entry
// shadows it and fails before the launcher runs; retire only our own shim.
const retired = process.platform === 'win32' ? [path.join(dir, 'yulor.ps1')] : [];
for (const file of retired) {
  if (fs.existsSync(file) && !fs.readFileSync(file, 'utf8').includes(ownMarker)) {
    throw Error('An unrelated command already exists: ' + file);
  }
}
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
for (const file of retired) {
  if (fs.existsSync(file)) {
    fs.renameSync(file, file + '.before-' + Date.now());
    console.log(JSON.stringify({ retired: file, replacement: 'yulor.cmd' }));
  }
}
