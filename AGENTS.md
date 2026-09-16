# Agent Workflow

## Controller execution policy

Read and follow [the project execution policy](docs/execution-policy.md). It is the single source for DIRECT/DELEGATE routing, one-return limits and cost accounting. Hub identity does not disable tools.

## Dual-engine contract

All new LMC features must cover both Claude Code and Codex in the same change and acceptance matrix. Menus use explicit Agent capabilities. Unsupported provider-specific options must not be sent to the other engine. Legacy Agents must fail closed with an upgrade explanation.

Session refresh must preserve the LMC session and provider resume identity, wait for the real turn boundary and queued input/permission requests, validate authentication and resume data before handoff, and never kill an active process. Authentication checks may publish only sanitized status, never credentials.

## Sync To Main

When the user says `sync to main` or `synt to main`, they mean:

1. Fetch `origin/main`.
2. Rebase the current branch on `origin/main`.
3. Push the current HEAD directly to `main` with a normal push, for example:
   `git push origin HEAD:main`

Do not force push for this workflow.
