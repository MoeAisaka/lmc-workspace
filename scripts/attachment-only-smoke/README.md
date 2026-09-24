# Attachment-only composer regression

Run against a completed web export:

```sh
LMC_PLAYWRIGHT_MODULE=/path/to/playwright-core node scripts/attachment-only-smoke/verify.cjs /path/to/web-export
```

The fixture mounts the real `AgentInput` and calls the real `sync.sendMessage`.
Only upload, encryption and outbound transport boundaries use in-memory fakes.
It uses synthetic PNG/PDF/DOCX attachments, no credentials or actual sessions,
and blocks every external network request.

Checks include:

- Attachment-only Enter (fails on v179), button activation and clicking Send.
- Codex/Claude, idle/queued, light/dark and phone/desktop widths.
- File event before the empty-text submission, matching queue keys, no caption added.
- Blocked/disabled/in-flight sends, dictation priority, whitespace, Shift+Enter.
- Touch browsers: Enter remains a newline; tapping Send submits the attachment.

Screenshots and `results.json` are saved in the printed temporary directory.
This checks the composer and submission envelope; it does not invoke providers
or test an actual upload service.
