# Settings dialog browser fixture

Uses the candidate Metro export's real dialog, settings panes, modal provider,
account menu and browser navigation shortcuts. It does not bootstrap the app,
load credentials or contact a provider. All requests are restricted to localhost;
account/device data is synthetic.

```sh
bash packages/lmc-app/scripts/release/export-web.sh --out /tmp/lmc-settings-style-web
node scripts/settings-dialog-smoke/serve.cjs /tmp/lmc-settings-style-web
# In another shell, with playwright-core available (or LMC_PLAYWRIGHT_MODULE set):
node scripts/settings-dialog-smoke/verify.cjs
```

The fixture listens on `127.0.0.1:4187`. `/` offers viewport/theme/language controls;
`/app` renders the real app components in the current viewport. The verifier
checks 320/390/430px phones, landscape and desktop, in light and dark mode:

- Dialog/close-button bounds and pane overflow.
- Search by actual setting labels, no-match state and category navigation.
- Both Claude Code and Codex defaults remain present.
- Existing preference and appearance controls still update their stores.
- The phone account menu opens settings without leaving the conversation route.
- Close button and the app's Escape dismissal path.

Screenshots and `results.json` are written to a new `/tmp/lmc-settings-qa-*`
directory. This verifies rendering and local interactions; it does not verify
real account mutations, daemon upgrades, device pairing or physical iOS keyboards.
