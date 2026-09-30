# Image resource fallback and settings exit — 2026-09-30

Delivered: Agent 1.2.65 (`image-resource-20260930`) and web
`lmc-redesign-20260908-v229`. This release does not enable Claude native PTY mode.

## Changes

Image Markdown links now use the same zoomable preview as inline images,
including angle-bracketed paths with spaces. If a session resource RPC is no
longer registered or disconnects, read-only downloads retry through that
session's original machine ID. Relative paths retain the original project cwd;
unknown hosts/roots and Rig sessions never guess a device. File errors and
permission failures are not retried. The daemon accepts only absolute-path
resource downloads, bounded to 32 MB with chunk revisions; it cannot open a
host application through this fallback. The computer must still be online and
the file must still exist. No conversation is restarted just to read a file.

Settings opt into deferred removal: button, backdrop and Escape requests mark
the dialog as exiting; its fade/scale completion removes it. Content cannot be
clicked during exit, and background fade is retained. Other modal types keep
their dismissal policy.

## Version-matched evidence

- App typecheck passed after the final source changes.
- App resource tests: 14 passed (7 image parsing/chunks, 6 host fallback,
  1 image-link preview); modal policy tests: 4 passed.
- Agent resource tests: 5 passed, including daemon absolute-only/download-only
  behavior; Agent build/typecheck passed. Existing pkgroll warnings remain.
- Actual exported Metro MarkdownView: Claude/Codex, chunked image, HTTP/file
  URLs, local paths with spaces, retry, capability gate, mobile/desktop and
  light/dark; disconnected session links preview through the original machine.
  Evidence: `/var/folders/3x/8gprgtc53csd80qbgch0syc40000gn/T/lmc-markdown-image-check-uGVl7s`.
- Actual exported settings: 12 button/Escape/backdrop × viewport/theme cases;
  animation-frame samples prove intermediate opacity before unmount.
  Evidence: `/tmp/lmc-settings-exit-v229.json`.
- The older full settings smoke script stopped at its pre-existing assumption
  that the first appearance switch mutates usageLimitShowRemaining. It does not
  validate the current settings order; no full settings regression pass is claimed.
- Real authenticated machine RPC on Mac mini returned all 230400 bytes of an
  owned switch-lab fixture, byte-for-byte equal, over two chunks. No business
  session received a test message and no credentials were copied.
- Mini/MacBook/Ubuntu daemon runtime status reports Agent 1.2.65 activated;
  busy Mini/MacBook sessions wait for natural safe refresh boundaries.
- Web assets were exported and published without replacing old hash assets.
  Both public entry points report v229; fetched main bundle equals local build.

Rollback: restore `web-gate/index.previous-1790761916182.html`; Agent previous
release `computer-use-20260930` and catalog backups remain available. Agent
bundle SHA256: `4bd1c2799e7a3fc7fee3bb462e6fb81fedac8a69b578b781063c95ef12167929`.
