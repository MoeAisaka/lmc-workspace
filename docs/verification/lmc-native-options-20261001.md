# Native Claude app prompt boundary — 2026-10-01

Agent 1.2.71, build SHA-256
`35419ef6cd0ee1d9c329b3aefd97bbbb2d3e34daadeea08b171801babb9d764e`.

## Defect and fix

A resumed native Claude session could start and receive agent mail without the
app's built-in Options prompt. The next ordinary web message attached that prompt
as `appendSystemPrompt`. The launcher correctly refused to restart while a real
background task was running, but incorrectly treated this built-in formatting
instruction as a new custom policy. Even unchanged model/effort selections left
the message waiting indefinitely behind a long-lived monitor.

The app and native launcher now share the exact Options prompt in `lmc-wire`.
Native startup always installs it, including after refresh. Runtime comparisons
normalize only an exact match of that built-in prompt. Custom appended prompts,
including a built-in prefix followed by custom instructions, retain the existing
safe boundary. Permission and tool restrictions still wait for a safe restart.

The app prompt is byte-for-byte identical to the previous one. Codex and Claude
SDK message behavior is unchanged; existing web clients work with this Agent
release without a web deployment.

## Verification

- 34 focused checks passed: native launcher 17, background task tracking 3,
  shared queue controls 14. New cases cover app metadata both with and without
  a background task and reject a custom appended instruction.
- `lmc-wire` build, final Agent TypeScript/package build and app `tsc --noEmit`
  passed. The shared prompt was compared byte-for-byte with the old app output.
- Real isolated Claude 2.1.286 / Sonnet 5.5 low lab under `~/.lmc/switch-lab`:
  start `sleep 120` with background execution and no app prompt; then send the
  real web metadata with the built-in Options prompt. The assistant answered
  `APP_OPTIONS_DELIVERED_1001` once, with exactly one release receipt, before
  the background completion notification. Native epoch and provider ID were
  unchanged and the queue emptied. The background task finished naturally;
  the owned lab was then stopped and archived.
- Lab transcript ordering: app message 9, queue release 10, assistant reply 12,
  background completion notification 14. The first probe reader expected the
  old wire envelope; the final read-only verifier checked the actual session
  envelope and confirmed the result without resending a test prompt.
- The affected business session's existing user message was delivered once
  through its current native terminal after its monitor completed naturally.
  Its original queued copy was withdrawn before submission to prevent replay.
  It answered the user, then upgraded at an idle boundary. Readback confirmed
  the same LMC/provider identities, the 1.2.71 build, `config=applied`, native
  `idle/composer=true`, and no queued messages or permission requests.

## Delivery

Managed release tag: `native-options-20261001`; rollback: `model-guard-20261001`
(Agent 1.2.70). Activated on Mac mini, MacBook and Ubuntu. Busy sessions keep
running and adopt the release at a natural idle boundary. No business process
was force-stopped, no synthetic prompt was sent to a business session, and this
maintenance did not operate the remote business deployment.
