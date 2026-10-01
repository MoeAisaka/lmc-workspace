# Claude native guidance — 2026-10-01

Agent 1.2.72, managed tag `native-steer-20261001`.
Agent SHA-256: `2cf3b0833edc482d607cc71879e3f19fdb4914b7a9eb1171693f4e474d2ba98e`.
Web marker: `lmc-redesign-20260908-v238`.

## Behavior

Native Claude 2.1.286+ advertises `sessionCapabilities.turnSteer`. The existing
queue-strip guidance button sends plain text using bracketed paste and ordinary
Enter. It does not send Escape, interrupt the foreground tool, or restart Claude.
Native Claude absorbs queued text after a tool completes; if the turn has already
ended, it can read it next turn. This is not a guarantee of immediate interruption
or exact parity with Codex `turn/steer`.

The Agent acknowledges delivery only after a fresh, matching native
`queue-operation/enqueue` receipt. Historical/foreign/malformed receipts are
ignored, and receipt records never become duplicate chat messages. Commands,
attachments, changed policy/model/role, manual terminal drafts and concurrent
delivery are refused before writing and restored to their queue position.
After any PTY write attempt, a timeout/exception is unconfirmed and never causes
an automatic resend. Manual native recovery remains available. Once its uncertain
draft is gone at an idle composer, the guard clears so normal chat can continue.

Claude SDK, older/unknown native runtimes and older Agents remain unavailable.
Codex retains its existing text/image guidance and legacy capability behavior.

## Evidence

- 138 distinct focused CLI tests passed: native launcher 30, scanner 11,
  terminal relay 6, background tasks 3, native refresh 1, shared queue controls 14,
  Codex steer prompt 6, Codex prompt policy 12, runtime capabilities 4, Codex
  app-server client 51. App queue capability/RPC tests: 7 passed.
- CLI TypeScript/package build, App TypeScript and production Web export passed.
  The initial TypeScript run found test-mock typing and optional capability-field
  errors; both were corrected before the successful final build.
- Real isolated Claude 2.1.286 / Sonnet 5.5 low test: loopback HTTP fixture held a
  foreground curl; the real App queue key was steered through the Agent RPC while
  curl was still running. Duplicate click returned `gone`. Releasing the fixture
  let curl complete normally, and the assistant included the new guidance marker.
  The native transcript contained one enqueue and `remove/absorbed_mid_turn`.
  Both ordinary and guided messages had exactly one durable queue-release event.
  Provider identity and native terminal epoch were unchanged.
- Repro: `e2e-native-claude.mjs --candidate --bypass-fixture --steer` under the
  switch-lab scripts. The candidate ran only in a newly created lab. Test output:
  `/tmp/lmc-native-steer-e2e-candidate.log`. The owned labs were stopped after an
  idle native `/exit` and archived; no business session received test prompts.
- Actual exported Web components in isolated Chromium at 390 px and 1280 px:
  native Claude and legacy Codex buttons enabled; old native/SDK buttons dimmed;
  correct guidance/interrupt RPCs, no horizontal overflow or page errors.
  This was browser emulation, not an iPhone hardware test.

## Delivery and rollback

Activated on Mac mini, MacBook and Ubuntu; readback confirmed daemon 1.2.72 and
the same Agent digest on all three. Live macOS session metadata confirmed native
guidance on upgraded sessions. Busy sessions retain their process and wait for a
natural safe boundary. The MacBook label-system controller still had background
work and queued messages at readback, so its old running transport had not yet
gained guidance. One old empty Mini probe lacked resume data and was preserved;
it was not treated as a successful upgrade or a business-session failure.

Both production and preview sites returned v238 and the exact exported main
bundle SHA-256 `98464526db2933bb444b187b0a314828641d021c4ccc7cef6aa0ac480d361d54`
(6,999,910 bytes). No same-name assets were overwritten.

Agent rollback target: previous `native-options-20261001` (1.2.71), with its
catalog backup retained by staging. Web rollback homepage:
`index.previous-1790839612947.html`; previous hashed assets remain present.
