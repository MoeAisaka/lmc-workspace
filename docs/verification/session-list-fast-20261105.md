# Session list Fast indicator — 2026-11-05

## Behavior

The device/engine session list now shows the same yellow flash used by the composer beside model details for Fast-enabled sessions, including hub headers, worker rows and ordinary/shared session rows. The display follows the local session selection, falls back to synced metadata when absent, and reuses the current model catalog support check. An explicit off selection and unsupported engines/models do not show the icon. This changes presentation only; it does not change model, permission, or runtime settings.

## Verification

- Model display tests: 13 passed, including Codex and Claude Fast support, unsupported Claude/Antigravity selections, off state, and pending local toggles.
- Existing model option tests: 38 passed; session model synchronization tests: 29 passed.
- App TypeScript check and production Web export passed.
- Public commit scan: no secrets detected. Three changed source files match byte-for-byte between the private source and public mirror.
- Live Web version `lmc-redesign-20260908-v390` returned HTTP 200; all three entry scripts matched the exported SHA-256 values.
- Read-only browser inspection confirmed the yellow flash after a Fast-enabled GPT-6-Astra/xHigh session's model details and no flash beside standard-mode sessions. No session settings or prompts were changed during verification.

## Delivery and rollback

Source commits: private `3c926f30`, public `f5204d7`. Both pushed.

Published to both existing Web hosts using the atomic publisher; 2,204 assets copied with no same-name replacements. NAS staging verified all 2,205 file hashes. The old indexes remain as `index.previous-1793851793865.html` (local) and `index.previous-1793851813912.html` (NAS). Restore the relevant previous index to roll back; keep hashed assets for open tabs. Agent runtimes were unchanged.
