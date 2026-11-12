#!/usr/bin/env node
// Yulor is the product name. Existing lmc/happy state and command handling remain shared.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

if (process.argv.length === 3 && ['--version', '-v'].includes(process.argv[2])) {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  console.log(`Yulor version: ${pkg.version}`);
} else if (process.argv.length === 3 && ['--help', '-h'].includes(process.argv[2])) {
  console.log(`Yulor — self-hosted AI collaboration workspace
Formerly LMC / Link my Cli. The lmc and happy command aliases remain supported.

Usage:
  yulor                 Start Claude Code
  yulor codex           Start Codex
  yulor agy             Start Antigravity
  yulor acp             Start an ACP-compatible agent
  yulor resume <id>     Resume a session
  yulor auth login      Pair this machine with your centre
  yulor daemon start    Start the background device agent
  yulor daemon status   Inspect the background agent
  yulor doctor          Check the installation and connection

Configuration: existing LMC_* variables and ~/.lmc/agent are retained.
Documentation: https://github.com/MoeAisaka/yulor
`);
} else {
  // Preserve the established executable boundary without creating a new identity or home.
  process.argv[1] = fileURLToPath(new URL('./happy.mjs', import.meta.url));
  await import('./happy.mjs');
}
