# Native app approval card

Runs the real exported `EngineDiagnosticBanner`, hook, controller and native dialog
with an isolated synthetic RPC. No account, identity, production server, desktop
application or user conversation is accessed. All external browser requests are blocked.

```sh
LMC_PLAYWRIGHT_MODULE=/path/to/playwright-core node scripts/native-approval-smoke/verify.cjs /path/to/export
```

Covers mobile portrait/landscape and desktop, light/dark, complete permission scope,
read-only discovery, explicit allow/deny, double click, changed request, offline
recovery, reload during an uncertain write, native-window fallback, and no Claude
RPC calls for Codex or Agents without the explicit native capability. Artifacts
and screenshots are written to the printed isolated temporary directory.
