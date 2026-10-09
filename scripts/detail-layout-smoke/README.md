# Detail layout and queue receipt recovery smoke

Use the production export's actual Metro modules with synthetic messages, isolated
Chrome and an empty browser context. HTTP is restricted to the loopback fixture;
no credentials or business sessions are loaded. Queue API/encryption are stubbed.

```sh
LMC_PLAYWRIGHT_MODULE=/tmp/lmc-personalization-tools/node_modules/playwright-core \
node scripts/detail-layout-smoke/verify.cjs /tmp/lmc-detail-v257
```

16 layout cases cover Claude/Codex, light/dark, 320/390/667/1280 widths,
content-sized short details, capped scrollable long details, time disclosure,
close, and unclipped long receipt/hash/command text. Two recovery cases exercise
the real hook, sync method, store/reducer and queue strip: offline retry, exact
receipt recovery without resending or moving history cursors, cessation after
confirmation, and suppression/resumption on navigation focus. Results/screenshots
are written to the reported temporary artifact directory. This is desktop Chrome
at mobile widths, not a physical iOS Safari test.
