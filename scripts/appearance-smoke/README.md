# Appearance and reading checks

These fixtures load the real modules and CSS from a production Web export with
synthetic sessions, empty credentials, and external requests blocked. They do not
bootstrap the production app or contact an Agent.

```sh
bash packages/lmc-app/scripts/release/export-web.sh --out /tmp/lmc-reading-web
node scripts/appearance-smoke/serve.cjs /tmp/lmc-reading-web
# Another shell; set LMC_PLAYWRIGHT_MODULE if playwright-core is elsewhere:
node scripts/appearance-smoke/verify-reading.cjs
```

The server defaults to `127.0.0.1:4201`; override with `LMC_STYLE_PORT`, and use
`LMC_STYLE_URL` for the verifier. Results and screenshots go to a new
`/tmp/lmc-reading-qa-*` directory.

`verify-reading.cjs` covers the default, magazine and academic layouts at three
widths in both themes. It checks real Claude/Codex messages, plain mail and
task/report/review cards, long-field stacking and wrapping, emphasis, quotes,
independent code fonts, evidence expansion, live updates of mounted text, larger
type, the actual settings menu and preference persistence. User bubbles retain
their compact presentation. Desktop prose has a bounded reading column; phone
mail fields use the full available width.

`verify.cjs` is the broader page/dialog typography check; `audit.cjs` scans the
source for direct native Text imports and fixed-font regressions. These checks
do not establish physical iPhone Safari behavior or business RPC correctness.

Additional font families and reading presets:

```sh
LMC_STYLE_PORT=4205 node scripts/appearance-smoke/serve.cjs /path/to/export
LMC_SETTINGS_FIXTURE_PORT=4206 node scripts/settings-dialog-smoke/serve.cjs /path/to/export
LMC_STYLE_URL=http://127.0.0.1:4205/app LMC_SETTINGS_FIXTURE_URL=http://127.0.0.1:4206/app node scripts/appearance-smoke/verify-additional-fonts.cjs
```

Checks all six added families at 320/390/1100px in both themes using actual
Claude/Codex replies and mail. CDP confirms Latin/CJK glyph sources and code
fallbacks; screenshots compare real regular/emphasized pixels with synthesis
disabled. It also verifies 14px mail vs 16px prose, Sarasa's CJK cell alignment,
same-origin lazy font requests, real menus, both reading presets, live code
inheritance and reload persistence. Font byte counts describe this synthetic
fixture's cold resource loads, not download time or every possible conversation.
