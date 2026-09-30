# Computer tools and image previews — 2026-09-30

Web v225 fixes assistant Markdown images and user image attachments that rendered
but had no click action. Both use the already resolved/decrypted URI in a shared
preview with pan, pinch, wheel, zoom/reset buttons, close button and web Escape.
It does not reread another session or navigate a local host path in the browser.

Evidence:

- The exported v224-era renderer failed the new actual-module browser check:
  clicking a loaded image never opened a preview.
- App typecheck and production export passed. The extended
  `scripts/markdown-image-smoke/verify.cjs` passed for both engine fixtures,
  assistant images and user attachments, local/HTTP paths, retry, legacy agent
  capability gating, zoom/reset/close/Escape, and touch opening at 390 pixels.
  Light/dark screenshots at 390 and 1200 pixels were produced; the mobile final
  modal was visually inspected. This is browser emulation, not a physical iPhone.
- Both production hostnames serve v225 and all three referenced JavaScript
  assets return 200. Publication retained the previous index and hashed assets.
- 19 focused CLI tests passed, including the originally failing Chrome
  pass-through cases, per-engine desktop configuration, macOS gating, explicit
  opt-out, missing/invalid configuration and existing remote turn behavior.
- Claude SDK 0.3.285 / native 2.1.285 connected `lmc-computer` and
  `claude-in-chrome`. In an isolated native LMCComputerLab app on Mac mini,
  `claudeRemote` using Sonnet 5.5 low called `see`, `type`, `click`, and `image`.
  The app wrote a fresh passing result for `LMC-COMPUTER-OK`; the SDK delivered
  the final screenshot as image content. No business session received a prompt.
- Peekaboo 4.6.0's official binary failed on the missing `_swift_initBorrow`
  runtime symbol. The exact release source was built with Swift 6.3.3 / SDK 26.5;
  dependency pins match the canonical release lock. The compatibility package
  bundles its required Span library, embeds the actual source stamp, and uses
  local ad-hoc signing. Both macOS 26.5.1 and 26.5.2 start the resulting binary.
- Final installed native binary SHA-256:
  `9e3f53aed8c3f0d7b882caa7164705a54fd895a1da00fd9958cda72acf266699`.
  Both devices select the local classic-capture launcher described in
  `docs/computer-use.md`. This avoids the observed default ScreenCaptureKit
  ownership conflict: two concurrent final MCP clients both connected as 4.6.0
  and received screenshots of the isolated fixture.
- The final 4.6.0 launcher passed the real `claudeRemote` SDK input/click/image
  test on Mac mini. MacBook passed a deterministic MCP test against its own
  freshly opened fixture, including input, click, fresh passing native result,
  updated accessibility text and inline screenshots. Its unconfirmed click
  receipt was verified by observation, never blindly replayed.
- MacBook's GUI Agent permission probe reports Screen Recording, Accessibility
  and Event Synthesizing granted. The earlier SSH-only negative result did not
  represent the GUI Agent context.
- A separate read-only Claude browser call reached the Chrome extension and
  returned that the new test session had no tab group; no tabs were created or
  changed. MacBook's SDK initialized both MCP servers through its GUI Agent
  context, avoiding SSH's lack of login-keychain access.
- The final Agent 1.2.64 typecheck and package build passed. Agent 1.2.64 is
  activated on Mac mini, MacBook and Ubuntu. Desktop tooling is configured on
  the two Macs only. Business sessions receive safe refresh requests and are
  allowed to finish active turns; no test prompt is sent to them.

Codex retains its existing native computer tools on these Macs. The optional
shared backend is tested for both engines; no Claude browser flags reach Codex.
No subscription-cost reduction is claimed. No full-repository suite was run.
