# Session order synchronization

Runs the exported SidebarView and FloatingSessionDrawer in separate browser
contexts, with the production settings synchronization code and an isolated
localhost account-settings service. No real account, session, token or provider
request is used; external network requests are blocked.

```sh
LMC_PLAYWRIGHT_MODULE=/path/to/playwright-core \
  node scripts/session-order-smoke/verify.cjs /path/to/exported-web
```

Requires Chrome (or `LMC_CHROME_PATH`). Checks desktop drag → phone update,
missed updates after reconnect and foreground resume, phone → desktop changes,
version-conflict merging of different groups, stale updates, and page reloads.
Both Claude and Codex session rows and hub workers are included. Screenshots
are saved to the temporary artifact directory printed by the script.
