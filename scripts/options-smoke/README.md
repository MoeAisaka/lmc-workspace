# Reply options regression

Run against a completed web export:

```sh
LMC_PLAYWRIGHT_MODULE=/path/to/playwright-core node scripts/options-smoke/verify.cjs /path/to/web-export
```

The fixture uses the export's real Codex/Claude message normalization, reducer,
MessageView and MarkdownView. Authentication and app bootstrap are disabled,
all external requests are blocked, and `sync.sendMessage` is replaced with an
in-memory recorder. It never sends a message to an actual session.

Checks cover light/dark themes at 320/390/1100 px, the three recovered answer
buttons, one send per click, keyboard activation, ordinary document/result
lists, incremental updates and explicit XML options. Screenshots and
`results.json` are written to the printed temporary directory.

The fallback is deliberately limited to 2–4 short trailing answers following a
direct choice prompt, or a yes/no question with corresponding answers. It only
runs for assistant prose. Explicit `<options>` is still the primary protocol;
arbitrary lists, code, links, nested lists and examples are not converted.
