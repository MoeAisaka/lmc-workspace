# Model changes, guidance and native background completion — 2026-10-01

Agent 1.2.73, managed tag `model-steer-20261001`.
Agent SHA-256: `c7f0693fe4bec71a2d950a1b667e3fe5bfa30338ad150552d83f80c8c8e90b34`.
Web marker: `lmc-redesign-20260908-v239`.

## Resulting behavior

Changing the selected model or effort no longer rejects explicit guidance into
the running turn. Codex uses the active turn's actual model and effort; native
Claude submits ordinary Enter without interrupting its tool. Desired settings
remain selected for the next eligible turn. Both runtimes explain the deferral
after delivery is confirmed. Codex's legacy automatic steering still requires
unchanged model preferences.

Permission, tool, custom prompt and hub role boundaries stay strict. A queued
plain CLI refresh accepts native guidance while the current turn runs; engine
handoff, a held receive cursor and refresh application still refuse it. Queue
grouping keeps model/effort distinct, so this does not merge differently
configured future turns. Expected-turn guards and uncertain-write/no-resend
rules are retained.

Native TaskStop can succeed without an internal task notification. The old
tracker retained that completed task forever, blocking refresh and model
changes. It now correlates the native assistant tool-use ID, requested task ID
and successful structured result. Terminal TaskOutput results also release a
matching task. Errors, foreign IDs, quoted chat and still-running status never
clear real work. A confirmed transition to zero tasks wakes the boundary pump.

Ordinary chat can continue on the current native model while background work
runs. Applying a different native model still waits for a true safe boundary;
this release does not implement native model hot-switching. It never infers
task completion from elapsed time, an idle UI heartbeat or an agent's chat claim.
The app distinguishes configuration, command, no-active-turn and handoff/refresh
refusals instead of showing one combined explanation.

## Evidence

- 131 distinct focused CLI tests passed across native launcher (37), background
  lifecycle (12), native refresh (1), scanner (11), SafeSessionRefresh (19),
  queue control (14), Codex prompt policy (12), steer delivery (6) and remote mode
  state (19). The final TaskStop wake-up change reran its affected launcher and
  background suites (49 tests); other unchanged evidence was reused. App queue
  capability/RPC tests: 7 passed. CLI release build, App TypeScript and Web export
  passed. Logs: `/tmp/lmc-model-steer-cli-green2.log`,
  `/tmp/lmc-model-steer-final-unit.log`,
  `/tmp/lmc-model-steer-cli-release-build.log`.
- Real isolated Codex catalog and turns: Astra/low kept its foreground HTTP
  command running, accepted queued GPT-6.1-Sol/medium guidance, and answered with
  the guidance marker. The next real SDK turn used GPT-6.1-Sol/medium. Provider
  ID stayed the same; each prompt had one queue release; duplicate guidance
  returned `gone`. Log: `/tmp/lmc-model-steer-codex-e2e.log`.
- Real native Claude 2.1.286: Sonnet/low accepted Opus/high guidance during a
  foreground tool without changing terminal epoch, completed that tool, and
  included the marker. Native enqueue/absorbed-mid-turn receipts were observed.
  Safe idle restart showed the new model/effort on the same provider ID.
  Log: `/tmp/lmc-model-steer-native-e2e.log`.
- Full native overlap: a bounded background HTTP command stayed alive while
  changing model, requesting CLI refresh, steering a queued prompt and sending
  ordinary chat. After real TaskStop success, refresh completed automatically
  and a subsequent native assistant message recorded `claude-opus-5-5`.
  Provider identity remained unchanged; every message was released once.
  Log: `/tmp/lmc-model-steer-background-e2e2.log`. The first fixture omitted the
  real app's durable metadata preference write and failed its model readback;
  that harness mismatch was corrected before the successful run.
- Live engine handoff regression before staging: the owned Claude lab wrote
  its own briefing, resumed as GPT-6.1-Sol, delivered and answered the briefing,
  cleared pending handoff and reached `applied`.
  Log: `/tmp/lmc-model-steer-switch-e2e.log`.
- Actual exported Web modules in isolated Chromium at 390 px and 1280 px:
  capability enablement, correct steer/promote RPC, four distinct Chinese
  refusal dialogs and no horizontal overflow/page errors. Browser emulation,
  not iPhone hardware validation. Log: `/tmp/lmc-model-steer-ui3.log`.
- Only newly owned lab sessions received regression prompts. Their bounded
  fixtures were released; successful native tests exited gracefully, and the
  owned empty lab wrappers were stopped and archived. No business session
  received a test prompt or forced stop.

## Deployment and original stuck-session recovery

Mac mini, MacBook and Ubuntu reported daemon Agent 1.2.73 and the exact digest
above. Idle live macOS sessions confirmed the same build and guidance capability.
Active sessions retain their process until a natural safe boundary; this hub
was still on the previous build while performing the release. Old empty probes
with missing resume data remain preserved, not counted as successful upgrades.

The original stuck MacBook label-system controller had a successful TaskStop
in its native transcript but stale LMC task state. Read-only native `/tasks`
confirmed `No tasks currently running`; it was idle with no queue or approvals.
Only at that verified boundary, ordinary `/exit` ended its native CLI and the
managed refresh restored the same LMC/provider IDs. Readback confirmed 1.2.73,
`sessionConfigState: applied`, native guidance enabled and the prior Opus/max
selection retained. No signal was sent to its business wrapper or remote jobs.
Logs: `/tmp/lmc-model-steer-business-recovery.log` and
`/tmp/lmc-model-steer-macbook-final-session-facts.json`.

Production and preview both returned v239 with the exact exported main bundle:
`/_expo/static/js/web/index-4702b2b1b0e40d9675be528e5fcf119b.js`,
7,001,607 bytes, SHA-256
`e7b6233e3fc9098265f67391dd63e21f0a66e8c4f22c402064faae1f9e005bda`.
No same-name assets were overwritten.

Rollback: previous Agent tag `native-steer-20261001` (1.2.72), with staging's
catalog backups retained; Web homepage `index.previous-1790844052651.html`,
with previous hashed assets retained.

## Unshipped native control experiment

Direct `/model` and `/effort` probes persist global defaults; they are unsuitable
for invisible per-session switching. A separate isolated screen-reader picker
probe did not reliably apply the model selected with session-only `s`, so that
prototype was preserved outside the source tree and is not shipped. The direct
probe wrote Mac mini's global default to Opus/high; the original values were
unknown. Restoring those preference fields is pending the user's choice; no
unknown prior value was invented or overwritten.
