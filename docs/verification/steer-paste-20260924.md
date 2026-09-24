# Steering across app versions and keyboard image paste

Agent 1.2.56 / Web v184.

## Failures and fixes

A running Codex turn and its queued reply had identical model, effort and
permission settings. One browser carried the older options instruction and the
other carried the current instruction. Their full queue hashes differed, so the
runner rejected steering as a settings change before calling the provider.
Steering now compares execution settings only. Queue batching still distinguishes
append prompts, and role changes and real execution-setting changes remain blocked.

The web file-transfer handler awaited a dynamic import before reading the paste
payload. A trusted Chromium keyboard paste exposed one image during dispatch and
zero files after the handler yielded. Files are now captured synchronously before
any await; image preview work remains asynchronous. Drop follows the same rule.
Normal text paste is not cancelled. This follows the browser's event-scoped
[data-transfer lifetime](https://developer.mozilla.org/en-US/docs/Web/API/HTML_Drag_and_Drop_API/Drag_data_store#protected_mode).

## Verification

- The new app-prompt compatibility regression failed on the previous hash
  implementation and passed after the fix. Model, effort and permission changes
  still produce different steering hashes; queue prompt separation is unchanged.
- 37 targeted Agent tests passed (prompt, image steering, queue control and
  interrupt recovery), both package typechecks passed, and the Agent and web
  production builds passed.
- `scripts/composer-paste-smoke/verify.cjs` failed against v183: a trusted paste
  contained an image, but no attachment appeared. It passed on v184 for both
  engine composers: exactly one 16×16 PNG attachment appeared and normal text
  still pasted into the field. The test uses a fresh Chromium context, synthetic
  clipboard data and the actual exported composer modules; non-local network
  requests are blocked. Native Paste is triggered through CDP with the Control
  modifier on macOS. A physical Windows browser was not available for this check.
- A fresh, uniquely identified lab session used the candidate runner. A queued
  reply with different options instructions returned `steered: true`, completed
  on the same provider thread, emptied the queue and returned to idle. Only then
  was the lab runner stopped. No business session received test input.

No full-repository test run was performed.
