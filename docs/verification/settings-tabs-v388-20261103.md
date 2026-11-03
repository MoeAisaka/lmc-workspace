# Settings categories — v388 (2026-11-03)

The settings dialog and settings index now share seven categories: General, Appearance, Conversation, Devices, Agent defaults, Account, About.

- General: language and command palette.
- Appearance: theme, personalization presets, preview, fonts, motion, colors, layout, reset.
- Conversation: input/context display, Enter to send, session grouping, tool/diff display, interactive answers.
- The other four categories and embedded subpage navigation retain their existing behavior.

All 12 mutable preference keys from the former General pane are preserved. No settings migration, provider changes or backend changes are needed. Search terms now target the correct category, including interactive answers, fonts, terminal appearance and bubble color. Category labels resolve at read time so restored account language reaches the tabs. Legacy language routes now target General; Appearance keeps its existing route.

## Validation

- App TypeScript check: passed.
- `LmcSettingsDialog.test.ts` and `lmcTranslations.test.ts`: 7 tests passed; mirror tested as well.
- Production Metro export: passed.
- `scripts/settings-dialog-smoke/verify.cjs`: 10 viewport/theme cases passed (320, 390, 430, 667, 1100px; light/dark), including actual theme assertions, bounds, search, setting mutation, Claude/Codex defaults, account entry, close and Escape; zero page errors.
- Additional English mobile Chromium check: seven tabs and line-number search routing to Conversation passed, with zero page errors.
- Manual screenshot inspection of desktop General and phone Appearance/Conversation: passed.
- Browser fixture theme initialization now uses the corresponding preference, ensuring dark-mode cases render the intended theme.

## Release

`lmc-redesign-20260908-v388` was atomically published to the existing local web gate and NAS web root. Existing hashed assets were preserved; no same-name asset replacements or service restarts were required. Public HTTPS homepage marker and all six directly referenced resources returned successfully and matched expected SHA-256 hashes.

Rollback homepage backups:

- Local gate: `index.previous-1793701864820.html`
- NAS: `index.previous-1793701877636.html`

Browser QA uses the real exported components with synthetic data and local-only traffic. It does not verify native apps, physical mobile devices, real account mutations or provider operations.
