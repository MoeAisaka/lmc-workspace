# Claude native computer use: interactive transport investigation

Status: **isolated transport prototype implemented and verified; native desktop
replacement not delivered or deployed**. Production remains Agent 1.2.64 / web
v228. Codex's existing native computer tools are unchanged.

## Scope and artifact

Mac mini, macOS 26.5.1, official Claude 2.1.285 from managed SDK 0.3.285,
Sonnet 5.5 low, existing local Claude Max login. Every probe used its own
`~/.lmc/switch-lab` working directory and new provider session. No business
session was stopped, refreshed, resumed or messaged. No credential was copied.

`packages/lmc-cli/scripts/switch-lab/native-computer-bridge.mjs` starts a genuine
interactive CLI in node-pty, with screen-reader output and JSON-line input and
output. Native `computer-use` supplied 24 tools. `--strict-mcp-config` with an
empty server map and `--no-chrome` excluded Peekaboo and Chrome from this proof.
It preserves the provider binary, application approvals and desktop lock.
This is a lab entry point, not a production transport or a shipped UI.

## Observed results

| Check | Result |
| --- | --- |
| Official native MCP in a genuine interactive process | Connected, 24 tools |
| Message delivery through the bridge | Passed: bracketed paste plus separate CSI-u Enter |
| Native approval menu display | Passed: exact requested apps visible in terminal output |
| Native approval response through the bridge | Passed: explicit numeric choice plus CR granted only the fixture |
| Stale input rejection | Passed in live bridge and unit tests |
| Native screenshot and text input with BetterDisplay running | Passed in initial isolated interactive probe; pixels and entered text observed |
| Mouse click with only fixture allowed, original display settings | Blocked: native tool says click would land on BetterDisplay |
| Disable BetterDisplay software video adjustments | Overlay removed; virtual display stays connected; clicks now rejected as landing on Notification Center |
| Hide desktop widgets and explicitly open the fixture | Same Notification Center rejection; widget setting restored |
| Temporarily exit BetterDisplay, with user approval | Native screenshot returned `CU display unavailable`; BetterDisplay immediately reopened |
| Include BetterDisplay in native consent, separately approved by user | Blocked before consent: both exact bundle ID and display name returned `notInstalled` |
| Fresh fixture PASS | **Not achieved**; old `result.json` was explicitly rejected as evidence |
| Production LMC session integration / phone UI | Not implemented or verified |

The fixture originally used accessory activation policy and could not be
resolved by native `request_access`. Running it as a regular GUI application
with a proper APPL bundle made it resolvable. The checked-in Swift fixture now
supports `--regular` for that probe while retaining its previous default.

On this Mac, BetterDisplay owns a full-screen `BetterDisplay Overlay for
Display 9`, layer 2147483629, bounds 1920x1080. The native tool rejected clicks
at multiple fixture positions because of that window. BetterDisplay provides
the main virtual screen, so quitting it is not a usable workaround. Its
software brightness was 1.0; stream, PIP and videoFilterWindow reported off.
Those were the initial settings; the later software-control change is recorded below.

BetterDisplay was running with bundle ID `pro.betterdisplay.BetterDisplay` at
`/Applications/BetterDisplay.app`, accessory activation policy. Native
`request_access` rejected both that identifier and `BetterDisplay`. Spotlight
metadata lookup returned “could not find” for the existing bundle; a targeted
`mdimport -i` did not fix it. Root volume indexing reported enabled, while the
Data volume reported unknown state. **Do not claim indexing is globally
disabled**, and do not rebuild the whole disk or patch provider app resolution
to make this test pass.

## BetterDisplay workaround and remaining macOS blocker (17:16 CST follow-up)

BetterDisplay 4.3.5 offers a narrower workaround than quitting the application:
Settings → Displays → Parsec HiDPI Canary → Video control settings → disable
**Enable software-based video adjustments** (启用基于软件的视频调整).
The application UI was used, and read-back confirmed
`allowSoftwareAdjustments@Display:5 = false`. This key is installation-specific,
not a portable CLI recipe. Re-enabling the same switch restores the prior
software brightness/color controls.

The main virtual screen remained connected (display ID 9, 1920×1080). Read-only
CG window inspection then found no full-screen BetterDisplay overlay: only its
1×1, alpha-0, layer-0 window remained. The vendor's explanation of software
adjustments includes overlay dimming; turning this off therefore addresses the
measured BetterDisplay interference without removing the remote display.

Two fresh native-only bridge sessions tested the changed environment:

| Provider session | Difference | Evidence |
| --- | --- | --- |
| `c8f557a7-5e06-4a02-9b49-fb02b4fbf1a3` | BetterDisplay software control off | Fixture-only consent granted; two actual screenshot image blocks; batch and standalone click rejected as landing on 通知中心 |
| `ce4f579b-58ea-402c-add5-db79f267baf5` | Also hide desktop widgets; call native `open_application` | Same two image blocks and same click rejection |

Both sessions exited normally with `/exit`, code 0. The fixture result file's
mtime remained `1790753513496205914`, identical to the pre-test baseline:
**no fresh PASS**. The fixture window was closed and desktop widgets restored
to on after the unsuccessful isolation step. BetterDisplay software control
remains off; its virtual screen remains available.

The remaining on-screen window metadata was:

| Owner | Layer | Bounds | Alpha / sharing state |
| --- | --- | --- | --- |
| Notification Center (通知中心) | 21 | 0,0,1920,1080 | 1 / 1 |
| Dock (程序坞) | 20 | 0,0,1920,1080 | 1 / 1 |
| LMCComputerLab | 0 | 750,206,420,258 | 1 / 1 |

The native screenshot visibly showed the unobstructed fixture, yet clicks
inside its input were attributed to Notification Center. This is consistent
with the upstream full-screen system-window hit-test report #50719, although
our top owner and sharing state differ from that report. It is evidence of an
additional native click-detection compatibility problem, not proof that
Notification Center or Dock can safely be ignored by an application allowlist.
No provider binary or consent gate was patched, and no system process was killed.

The official npm registry still reported Claude Code **2.1.285** and Agent SDK
**0.3.285** as latest during this follow-up. Replacing BetterDisplay would not
remove these independent system-owned windows, so no replacement was installed.
Production stays on the existing Peekaboo adapter; native transport integration
remains blocked on a supported click path.

## Why SDK hooks alone do not solve the relay

With configured hooks, `SessionStart`, `UserPromptSubmit`, `PreToolUse`,
`PostToolUse`, `Notification`, `Stop` and `SessionEnd` were observed. During the
native per-app prompt, neither `PermissionRequest` nor `Elicitation` fired.
Ordinary MCP elicitation documentation therefore does not establish that native
application approval can use the existing SDK approval cards.

Screen-reader menus also differ from the message composer: pasted `2` and
CSI-u Enter did not submit the menu. Literal `2\r` did. The prototype separates
message paste, composer Enter and explicit menu choice; no automatic approval
or interpretation of a model's prose is used. EOF does not stop the process,
so the prototype requires an attended client and explicit native `/exit`.

## Verification and boundaries

- `pnpm exec vitest run --project unit scripts/switch-lab/native-terminal-protocol.test.ts`:
  5 passed, including stale choice rejection, terminal escape injection,
  multiline non-submitting paste and native menu encoding. The repository's
  global setup also completed its normal build/typecheck.
- `node --check scripts/switch-lab/native-computer-bridge.mjs`: passed.
- Swift fixture compiled with `xcrun swiftc -parse-as-library`.
- Real bridge sessions exercised paste, native permission display/response,
  hook receipt and graceful `/exit`, with exit code 0 for completed probes.
- No Agent version bump, production dependency change or release was performed.

Next integration gate: achieve fresh native screenshot/input/click proof on a
supported display/app-resolution setup. Then connect the persistent interactive
process and its native prompts to LMC, preserving provider resume identity,
queue and settings behavior, cancel, reconnection and safe refresh boundaries.
Do not silently launch a second model agent for every desktop operation or
replace all existing SDK sessions before those checks pass.

## Primary references

- [Official native computer use](https://code.claude.com/docs/en/computer-use):
  interactive-only requirement, per-app consent and session-lifetime desktop lock.
- [Official hooks reference](https://code.claude.com/docs/en/hooks): documented
  PermissionRequest and Elicitation semantics; native behavior above is measured.
- [Remote native approvals report #87340](https://github.com/anthropics/claude-code/issues/87340).
- [Third-party app discovery report #43759](https://github.com/anthropics/claude-code/issues/43759).
- [Spotlight/LaunchServices report #64318](https://github.com/anthropics/claude-code/issues/64318).
- [BetterDisplay maintainer explanation of software video adjustments](https://github.com/waydabber/BetterDisplay/discussions/615).
- [BetterDisplay per-display software control guidance](https://github.com/waydabber/BetterDisplay/discussions/3456).
- [Native system-window hit-test report #50719](https://github.com/anthropics/claude-code/issues/50719).

Issue reports are corroborating reports, not proof that the vendor has accepted
our exact root cause or supplied a fix. Local measurements above are the basis
for withholding a native desktop completion claim.
