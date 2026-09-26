# Engine switch keeps the picked model

Picking a model from the other engine's list switches the session, but until Agent 1.2.58 / Web v188 the pick never reached the device. The app held it in memory and applied it only if the same app instance was still open when the relaunch landed. Reloading the page, switching several sessions in a row, or reading the session on another device left the new engine without a model. The runner then recorded no model, and the composer fell back to the app's hard-coded Claude default, Opus 5.

Evidence from the 2026-09-26 switches on the Mini: six Codex → Claude sessions launched with `no model override, using current: default`, and the composer showed Opus 5. Claude Code's own default on that machine, `claude-opus-5-5[1m]`, is what actually answered. The model only became visible after it was picked again by hand.

## Change

- App: `switchSessionEngine` sends the picked `model` in the `configure-session` switch request. The in-memory copy stays as the fallback for runners that ignore the field.
- Agent: both runners read `permissionMode`, `model` and `effort` from the switch request (`readSwitchSettings`) and pass them to the daemon relaunch. The daemon already turned these into `--model` / `--effort`. The arriving runner records the model in session metadata, so every device shows it and later messages carry it.
- The departing engine's own model and effort still stay behind.

## Verification

- CLI typecheck and build passed. `engineSwitchRequest` tests (9) passed, as did the affected runner and refresh unit files (23 tests). App typecheck passed, and `sessionConfiguration` + `engineSwitch` tests (26) passed.
- Real switches on the Mini daemon with Agent 1.2.58, in `~/.lmc/switch-lab`, with no business sessions involved:
  - `LAB_FROM=codex LAB_SWITCH_MODEL=claude-sonnet-5 e2e-switch.mjs`: all fields green, `launchModel: claude-sonnet-5`, `modelCarried: true`. The arriving Claude transcript shows only `claude-sonnet-5`, not the machine default.
  - `e2e-switch.mjs` (Claude → Codex, no model picked): all fields green, `launchModel: gpt-6-astra`.
  - `e2e-cancel.mjs`: all fields green.
- Web v188 was verified on the formal and preview sites: the marker matched and all 6 homepage resources returned 200. The live bundle sends `model` with the switch request.

## Release / rollback

Agent release `switch-model-20260926` (sha256 `73e75290…`) is staged beside `auto-goals-20260925` on the Mini, MacBook and Ubuntu, and selected through the upgrade coordinator. Active sessions wait for a safe boundary. The Web publisher kept the previous index (`index.previous-1790384860201.html`) and assets.
