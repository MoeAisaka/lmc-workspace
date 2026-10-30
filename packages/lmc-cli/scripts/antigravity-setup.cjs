#!/usr/bin/env node
// Per-user preparation only. Run with the absolute official agy path.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { execFileSync } = require('node:child_process');
const agy = process.argv[2];
if (!agy || !path.isAbsolute(agy) || !fs.existsSync(agy)) throw new Error('Pass the absolute official agy executable path');
const home = os.homedir();
const run = args => execFileSync(agy, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15_000, windowsHide: true });
const version = run(['--version']).trim();
const directory = path.join(home, '.lmc', 'agent'); fs.mkdirSync(directory, { recursive: true });
const bridge = path.join(directory, 'antigravity-mcp.cjs');
const content = fs.readFileSync(path.join(__dirname, 'antigravity-mcp.cjs'));
if (fs.existsSync(bridge) && !fs.readFileSync(bridge).equals(content)) throw new Error('Existing Antigravity bridge differs; refusing overwrite');
if (!fs.existsSync(bridge)) fs.writeFileSync(bridge, content, { mode: 0o600, flag: 'wx' });
const configPath = path.join(home, '.gemini', 'config', 'mcp_config.json');
const nodeBin = (process.platform === 'darwin' && /\/Cellar\/node(?:@\d+)?\//.test(process.execPath))
  ? ([`${process.execPath.split('/Cellar/')[0]}/bin/node`, '/opt/homebrew/bin/node', '/usr/local/bin/node'].find(p => fs.existsSync(p)) || process.execPath)
  : process.execPath;
const readConfig = () => {
  const text = fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf8').trim() : '';
  return text ? JSON.parse(text) : {};
};
const existing = readConfig().mcpServers?.lmc;
if (existing && (existing.command !== nodeBin || JSON.stringify(existing.args) !== JSON.stringify([bridge]))) throw new Error('An existing lmc MCP server differs; refusing overwrite');
if (!existing) run(['mcp', 'add', 'lmc', nodeBin, bridge]);
const configured = readConfig().mcpServers?.lmc;
if (!configured || configured.command !== nodeBin || JSON.stringify(configured.args) !== JSON.stringify([bridge])) throw new Error('Native CLI MCP registration did not match its documented config; inspect locally');
const rules = path.join(home, '.gemini', 'AGENTS.md'); fs.mkdirSync(path.dirname(rules), { recursive: true });
const marker = '<!-- LMC-ANTIGRAVITY-PREP v1 BEGIN -->';
const block = `\n${marker}\nUse this machine's ~/.agents/controller-policy.md when present, and the project's AGENTS.md. Keep the user's model and permission choices. On continuation or regressions, read the relevant LMC session transcript and recall Nowledge Mem before acting. Discover installed MCP tools and ~/.agents/skills before declaring a capability unavailable; do not copy credentials between tools or devices.\nWhen delivering a requested file in LMC, use publish_file and wait for ready; a local path is insufficient. Saved links require the same LMC account. Create an expiring anonymous share only when external sharing is explicitly requested. Do not publish incidental code, logs or credentials.\n<!-- LMC-ANTIGRAVITY-PREP END -->\n`;
const old = fs.existsSync(rules) ? fs.readFileSync(rules, 'utf8') : '';
if (!old.includes(marker)) fs.appendFileSync(rules, block, { mode: 0o600 });
console.log(JSON.stringify({ machine: os.hostname(), version, executable: agy, mcp: { name: 'lmc', configured: true, bridge }, rules, controllerPolicyPresent: fs.existsSync(path.join(home, '.agents', 'controller-policy.md')), skillsDirectoryPresent: fs.existsSync(path.join(home, '.agents', 'skills')), authentication: 'not_started', inferenceRequests: 0 }));
