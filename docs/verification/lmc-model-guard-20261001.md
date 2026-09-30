# Codex account model validation and worker failure reporting — 2026-10-01

Agent 1.2.70. Build SHA-256:
`a865f44637c432e5df137d406f31b9d06cbf2b68217e85ce357b00aa14d4a93e`.

## Defect and behavior

The affected worker received `model=gpt-6.1` through configuration/task mail.
LMC checked effort and cross-engine names but accepted unknown model names.
The actual Codex turn failed with HTTP 400: that model is not supported with a
ChatGPT account. The old runner reported only quota failures to its hub, so the
task board remained dispatched even though no deployment work had happened.

- Codex configuration mail now checks the active app-server account and live
  model catalog before applying model/effort settings. Ordinary turns also
  check before `turn/start`. Unknown names are rejected with the available
  full names; no guessed alias or silent model substitution.
- The allowlist applies only to the normal OpenAI ChatGPT route. API-key and
  custom provider namespaces remain provider-owned. A failed metadata lookup
  is reported as inability to check, not proof of an unsupported model.
- Both Codex and Claude use a runner-level terminal failure reporter. Model,
  authentication, quota and other terminal errors report the original task,
  dispatch and attempt as blocked. Concurrent notifications are deduplicated;
  no automatic retry or budget reset is introduced.
- Rejected task configuration keeps the original contract on the board and
  sends a blocked report before any model turn. Control-only rejection retains
  the previous settings and sends a notice, without creating another task.
- Accepted tasks are projected before model delivery so immediate failure sees
  the correct task identity. Storage failure still does not discard a claimed
  instruction. Existing role/binding checks remain in place.

## Evidence

- Mac mini, selected Codex CLI 0.159.2: live `account/read` returned
  `chatgpt` / `plus`; `model/list` included `gpt-6.1-sol` and Medium, but not
  `gpt-6.1`. A fresh isolated provider thread completed with `gpt-6.1-sol` /
  Medium and the exact expected assistant reply.
- Candidate client probe `scripts/switch-lab/e2e-codex-model-guard.ts`:
  `blockedBeforeTurn=true`, `realTurnCompleted=true`,
  `assistantReplyMatched=true`, `turns=1`. The invalid name issued zero native
  turns. The probe uses a new ephemeral thread under `~/.lmc/switch-lab`.
- Deployed 1.2.70 mail probe (`e2e-model-mail.mts`), lab hub
  `cmuohcbny0pyb9aq83swiccjj`, worker `cmuohccra0pyd9aq8vnfz25y4`:
  blocked report received, original dispatch retained, full available model
  named, prior model retained, board blocked at attempt 1, and zero user/model
  turns delivered. Both lab sessions were stopped and archived afterwards.
- 91 focused unit checks across account model guards/routing, app-server,
  interrupt recovery, worker configuration/failures/quota and agent mail.
  The affected interrupt fixture was updated for its custom test provider and
  its 5 checks passed; after the mail ordering fix all 12 mail checks passed.
  Unchanged passing checks were reused. Final TypeScript/package build passed.
- The owning business hub configured the original worker to the verified
  `gpt-6.1-sol` / Medium / yolo and reported actual successful local tools at
  2026-10-01 02:56 CST. Subsequent metadata retained the original LMC and Codex
  identities and showed working, with the same task/attempt/deadline. This is
  recovery evidence, not a claim that its business deployment is finished.

## Delivery

Activated on Mac mini, MacBook and Ubuntu via the managed safe rollout.
Busy sessions continue on their current build until their natural idle boundary.
GPD was unreachable over both direct SSH and the router path at this release;
its existing 1.2.69 remains unchanged and its update is pending.
Rollback artifact: `native-queue-20260930` (Agent 1.2.69).
No business process was stopped or synthetic prompt sent to a business session.
