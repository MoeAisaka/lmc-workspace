# Sidebar motion — 2026-09-07

Published frontend 5de5279 to the self-hosted centre.

Left sidebar uses a same-document View Transition, with 220 ms slide/fade snapshots and one synchronous layout update. It does not animate live drawer width. Unsupported browsers and reduced-motion preference retain immediate switching. Right resource window uses opacity/transform transitions and delayed visibility, preserving its mounted state during exit.

Validation: TypeScript and Expo export passed; 2 fallback/reduced-motion unit tests passed. Isolated Chrome check observed six transition animations, one update callback, interpolated resource opacity, delayed hiding, reduced-motion fallback and no runtime errors. External release marker and all linked JS/CSS SHA-256 hashes matched the build; external login page rendered without uncaught errors. Authenticated full-page and physical iPhone experience are not independently verified.

Rollback: atomically restore ~/.lmc/happy-candidate-20260906/web-gate/index.before-motion-5de5279.html over index.html. Existing hashed assets retained. No backend or Agent restart.

API reference: https://developer.chrome.com/docs/web-platform/view-transitions/same-document
