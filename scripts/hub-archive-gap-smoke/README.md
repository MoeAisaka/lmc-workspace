# Hub group gap after archiving workers

```sh
LMC_PLAYWRIGHT_MODULE=/path/to/playwright-core \
  node scripts/hub-archive-gap-smoke/verify.cjs /path/to/exported-web
```

Renders the real session drawer with a hub and four workers, expands the hub,
archives two workers and checks that the next group moves up by the same
amount. Before 2026-09-29 the expanded group kept its old height as a blank
gap until reload (Reanimated keeps the last height it wrote).
