# Session resource search

The resource panel combines filename/path matches with body matches and filters
by the extensions present in the selected scope. Search is literal and
case-insensitive. Results include up to three excerpts per file, with a text line,
PDF page, or DOCX paragraph number. Existing file actions remain available.

## Scope and coverage

- All resources: the Agent's persisted session resource journal plus explicit
  file links from loaded transcript messages (at most 2,000 supplemental links).
- Current turn / unreviewed: every resource in that journal scope, including
  rename destinations and records beyond the 20-change review page.
- Body search reads the current file, including for change-review scopes. It does
  not search old patch versions or recursively crawl the project.
- Text files support UTF-8 and BOM-marked UTF-16. PDF extraction uses `unpdf`
  1.7.0; DOCX extraction uses `mammoth` 1.12.3 raw text. There is no OCR.
- Skipped files retain filename/path matches. The panel shows incomplete coverage
  and per-file reasons for missing/unreadable files, binary content, size limits,
  no extractable document text, timeout, sensitive paths, and concurrent changes.

## Execution limits

The shared `resource-search` session RPC serves both Claude and Codex. It scans
four files per request, two concurrently, and permits at most two concurrent
requests per Agent process. A worker thread isolates each extraction from the
session event loop, with a five-second deadline and a 256 MB V8 old-generation
heap limit. This is not a security sandbox or a total process-memory limit.

Input limits are 2 MiB per text file and 16 MiB per PDF/DOCX. PDFs are limited to
200 pages; extracted text is limited to 2,097,152 characters. Each request accepts
at most 200 query characters. Known credential paths are excluded from body
search, including after resolving symlinks. Regular-file checks and bounded reads
prevent accidental device/FIFO reads and growing-file overreads. No extracted
text cache is persisted, and complete document contents are not sent to the Web.

Pagination binds the selected path list, scope, query and extension to a snapshot
hash; changes invalidate continuation. The Web debounces input by 350 ms, displays
filename results immediately, and merges body results progressively. Changing the
query, filter, scope or session, or closing the panel, discards old replies and
stops requesting more batches; an already running batch finishes within its limit.

## Packaging and compatibility

New Agents advertise `sessionCapabilities.resourceSearch`. Older sessions retain
filename/path filtering and explain that body search requires an Agent upgrade.
Both the Agent and Web must be updated to enable the complete feature.

The release must include `bin/resource-text-worker.mjs` **and** the pinned runtime
dependencies `unpdf` and `mammoth`. Copying only `dist`, or linking a new release
to an older dependency directory that lacks these packages, is insufficient.
Install the updated lockfile/dependencies before refreshing sessions through the
normal safe upgrade mechanism. npm's existing `files` list includes `bin`.

## Verification

Targeted tests cover actual PDF/DOCX extraction, UTF-8/UTF-16, literal code and
Chinese queries, skip reasons, parser timeout, extension pagination, full review
scope, both-engine capability flags, progressive responses, cancellation and
legacy/hidden-panel behavior. The production Web build can be exercised with
synthetic session data and mocked RPC responses without contacting production.
