# Native Claude queue / cancellation regression — 2026-09-30

Agent 1.2.69. Build SHA-256:
`0f61f6b0fbf0a4c5ff6ff6675c9876e25832131569f8d19d86022052cbd7da85`.

## Defects and resulting behavior

- Model/effort changes previously blocked every later prompt while a native
  background task existed. Continue normal messages on the running model and
  explicitly state the deferral; apply the requested model at the safe boundary.
  Permission/tool/system-prompt changes still wait for a safe restart.
- A sticky "ever ran background work" flag never cleared. Track actual tool
  starts/results and terminal notifications from Claude's internal transcript
  queue; never trust task notification markup in ordinary chat.
- Escape cancels native generation without emitting Stop. Wait for a fresh idle
  composer after the interrupt, finish that turn, and deliver the promoted item.
  Repeated stop requests cannot issue repeated Escape. Promotion wakes an idle
  consumer as well as interrupting an active one.

## Evidence

All probes use fresh `~/.lmc/switch-lab` sessions, not business prompts.

- Native CLI 2.1.285 on Mac mini; candidate source in the daemon-owned runner.
- `cmuo7cv6a0oav9aq8cg8w2nbv`, provider
  `dcc77cb6-1569-48c9-b5da-0b47f008d761`: real background sleep started at
  22:30; while it remained alive, an Opus/high prompt received the exact assistant
  response `BG_CHANGED_930` under the running Sonnet/low terminal. After the task
  completed, the epoch changed and the terminal reported Opus 5.5/high on the
  same provider ID. No forced task termination.
- This probe also reproduced native Escape returning to an idle composer while
  LMC still reported busy, without a Stop hook. A foreground sleep probe was
  rejected by Claude's own policy; it did not run and is not counted as passing.
- `cmuo7jlp50oc99aq8cjq9j849`, provider
  `aec362e7-6cbb-4f87-b6ee-14b3853dd4c1`: final cancellation fix interrupted real
  text generation through `promote`, then delivered the queued prompt exactly
  once; assistant replied `AFTER_INTERRUPT_931`. No Stop hook was required for
  the interrupted turn. LMC remained on the same native provider session.
- 50 focused tests passed across launcher, task lifecycle, transcript scanner,
  native refresh, permissions, relay and shared queue control. After tightening
  the fresh-screen interrupt revision guard, the 14 affected launcher tests and
  the full TypeScript/package build passed again; unchanged checks were reused.

No business process was stopped or test prompt sent to a business session.
Deployment / recovery receipts are recorded separately from these lab results.
