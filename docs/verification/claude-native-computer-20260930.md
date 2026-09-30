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
| Mouse click with only fixture allowed | Blocked: native tool says click would land on BetterDisplay |
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
No brightness, display layout or filtering settings were changed.

BetterDisplay was running with bundle ID `pro.betterdisplay.BetterDisplay` at
`/Applications/BetterDisplay.app`, accessory activation policy. Native
`request_access` rejected both that identifier and `BetterDisplay`. Spotlight
metadata lookup returned “could not find” for the existing bundle; a targeted
`mdimport -i` did not fix it. Root volume indexing reported enabled, while the
Data volume reported unknown state. **Do not claim indexing is globally
disabled**, and do not rebuild the whole disk or patch provider app resolution
to make this test pass.

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

Issue reports are corroborating reports, not proof that the vendor has accepted
our exact root cause or supplied a fix. Local measurements above are the basis
for withholding a native desktop completion claim.
