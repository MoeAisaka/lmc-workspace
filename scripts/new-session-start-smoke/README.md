# New session creation regression smoke

Runs the real exported NewSessionScreen, draft store, spawn response handling and modal in an isolated Chromium page. The machine RPC and navigation are fixtures; all non-local network requests are blocked. This does not create real sessions or send model prompts.

```sh
LMC_PLAYWRIGHT_MODULE=/path/to/playwright-core node scripts/new-session-start-smoke/verify.cjs /path/to/production-export
```

Uses Chrome on macOS by default (`LMC_CHROME_PATH` may override). Checks that 100 machine/session updates do not repeat the Git query, both Codex and Claude show the daemon's error envelope, the draft survives, no navigation occurs, and Send becomes available after dismissing the error. Screenshots and JSON are written to the displayed temporary directory. Provider startup latency and real Windows machine connectivity are outside this fixture's scope.
