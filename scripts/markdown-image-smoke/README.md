# Markdown image smoke check

Run after exporting the app:

```sh
LMC_PLAYWRIGHT_MODULE=/path/to/playwright-core \
node scripts/markdown-image-smoke/verify.cjs /path/to/web-export
```

The script mounts the actual exported `MarkdownView` in a fresh Chromium context.
The app bootstrap is removed, sessions and file RPC responses are fixtures, and
non-local network requests are blocked. It does not access credentials or send
messages to any real session. Screenshots and results go to the printed temporary
directory. Override `LMC_CHROME_PATH` when Chrome is installed elsewhere.

Optional `LMC_PREVIEW_SAMPLE=/path/to/image.png` supplies a local PNG for visual
inspection and exercises multiple chunks when larger than 32,769 bytes. The
sample is only served locally and is never copied into the repository.

Checks cover Claude and Codex session routing, bracketed paths with spaces,
chunked image decoding, unchanged HTTP delivery, encoded file URLs, retry after
failure, capability fallback, and light/dark layouts at 390 and 1200 pixels.
Loaded Markdown images and user attachments must open the shared preview;
zoom/reset, close, Escape, touch opening, viewport bounds and the opaque viewer
surface are checked. Screenshots wait for the modal's entrance animation.

Also verifies image links with spaces after session RPC disconnect, using only
the original machine ID and the session project directory.
