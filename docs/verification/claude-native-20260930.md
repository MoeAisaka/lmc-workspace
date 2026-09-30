# Claude native interactive mode · 2026-09-30

Later delivery: [native default and session migration](claude-native-default-20260930.md) supersedes the optional-mode and worker/configuration limitations below.

## Delivery

Optional macOS Claude mode, entered from the session menu **Claude 原生电脑**.
Keeps the LMC session and Claude provider UUID. Normal chat remains queued;
the official interactive CLI's native prompts appear in a separate terminal
panel. Closing the panel releases its input lease, not the Claude process.
No injected Peekaboo server in this mode; explicit Chrome choice is retained.
Codex behavior is unchanged. Unsupported platforms, sandbox sessions, worker
approval routing and custom CLI arguments do not silently enter native mode.

Native controls carry a process epoch, observed screen revision and short
single-writer lease. Duplicate request receipts prevent retrying the same key.
Ordinary chat is bracketed paste, followed separately by Enter, and acknowledged
only on UserPromptSubmit. Unknown delivery is never automatically resent.
Stop hooks can leave an empty composer visible while still running: the native
interrupt footer keeps queue delivery and automatic exit blocked until idle.
A new transcript watcher starts on first submission, avoiding the existing
60-second missing-file timeout before a fresh session's first message.

Model/effort/permission pickers are held at entry settings; leave native mode
before changing them. Ordinary chat slash commands are rejected with a native
panel hint. A detected background job disables automatic /exit for that run;
the user can inspect /tasks and explicitly exit through the native terminal.
Native application consent is still explicit. The adapter does not fix the
provider's known macOS Notification Center window misidentification.

## Verification

- Final CLI contract tests: 8 native lifecycle tests (safe queue, Stop hooks,
  failed turn status, missing transcript delay, uncertain delivery, spawn
  failure, background exit guard, changed settings); 6 relay tests; 9 scanner
  tests; 14 existing permission tests. 37 tests total across relevant runs.
  The permission test fixture now supplies the SDK-required requestId; no
  permission handler production behavior changed.
- Explicit Agent 1.2.66 build exited 0. App TypeScript check exited 0.
- Official CLI 2.1.285 / SDK 0.3.285 on Mac mini: standalone owned lab retained
  NATIVE-RELAY-ONE after writer disconnect/reconnect, then /exit returned 0.
- LMC lab cmunykd2u0mxl9aq86e2ipsii: SDK -> native -> SDK retained provider
  b55024cc-6479-449d-abc2-106c2c83a238 and LMC-NATIVE-042. Native startup's real
  Chrome informational confirmation was rendered, not auto-confirmed; normal
  chat waited until that prompt was explicitly answered. No website was driven.
- Queue lab cmunyt4kb0n059aq83vxxxs3k: two sequential prompts waited through
  native Stop hooks. It exposed the fresh idle transcript timeout; this run is
  not claimed as a transcript-sync pass. Fixed and verified in the next lab.
- Final lab cmunyx6pe0n0h9aq8rc9wi0n9: first message after >60s idle produced
  exactly one assistant envelope and turn-end. Leaving native then sending a
  regular SDK message produced NATIVE-IDLE-946 RETURN-OK with provider UUID
  302a58c4-e639-47da-9f96-d614a74bbcfb unchanged. No internal /exit XML cards.
- Real exported UI: 320px phone, 667px landscape, 1280px desktop × light/dark;
  no autoapproval, double click sends one input, stale response rejected,
  closing/reopening preserves the native process, offline disables controls.
  Browser requests were restricted to the local fixture origin.
- Staged PTY + headless terminal actually run on both Mac mini and MacBook.
  No business session test prompts, Finder actions or copied credentials.

## Deployment and rollback

Agent **1.2.66**, release `native-claude-20260930`, activated on Mac mini,
MacBook and Ubuntu. macOS exposes the optional native mode; Linux does not.
Busy business sessions wait for natural refresh boundaries.
Agent SHA256: `b0a5d9082dab41496cc5853d138ce85edf61f58bac6e27a58f18bc4b437f0d30`.
Previous Agent release `image-resource-20260930` and per-host catalog backups
remain available. Web v230 was initially published; final web marker and
reconnect UI verification are recorded below after publication.

Final web **lmc-redesign-20260908-v231** is verified on both public entry
points (preview and primary, port 11455). Downloaded main bundles equal the
local export, SHA256 `ed55ac8ec68638aab4e5a7fec9740e27215289d59c4d9b35b39c5a4dd29354cd`.
Final UI evidence: `/var/folders/3x/8gprgtc53csd80qbgch0syc40000gn/T/lmc-native-ui-check-PT12Z8`;
all six cases also confirm that recovery clears the obsolete disconnected
notice and re-enables controls. TypeScript check for this UI revision passed.
Web rollback to pre-feature v229: `index.previous-1790764827409.html`;
the intermediate v230 backup is `index.previous-1790765024606.html`.

Post-rollout read-only RPC on the final owned lab reports native capability
true, the exact deployed Agent hash above, `active:false` after clean native
exit, and unchanged provider UUID. At deployment verification, Mini had 11
sessions refreshed / 2 waiting; MacBook 9 refreshed / 3 waiting; Ubuntu rollout
completed. Waiting work was not interrupted.
