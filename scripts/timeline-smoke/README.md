# Per-reply timeline acceptance

Build from the repository root:

```sh
pnpm --filter lmc-app typecheck
pnpm --filter lmc-app exec vitest run sources/utils/turnTimeline.test.ts sources/hooks/useGroupedMessages.test.ts sources/utils/toolDisplay.test.ts
CI=1 pnpm --filter lmc-app exec expo export --platform web --output-dir /tmp/lmc-timeline-web
node scripts/timeline-smoke/verify.cjs /tmp/lmc-timeline-web
```

Requires an installed `playwright-core`; `LMC_PLAYWRIGHT_MODULE` can point to its module directory. `LMC_CHROME_PATH` overrides the macOS Chrome executable.

The browser runner uses the exported production components, theme system, fonts and icons with synthetic Claude/Codex tool messages. It intercepts Metro registration in a temporary localhost fixture and skips the app bootstrap. It never loads a saved browser profile, authenticates or contacts the production API. The exported build is not modified. Screenshots are saved in the printed artifact directory.

Checks cover serial/parallel timing, details, fold/unfold, final-answer visibility, live elapsed time, stale records, failure and permission states, mobile width and theme switching. Unit tests cover the message grouping and timestamp rules. Native iOS/Android and live provider transport are outside this browser check.

The current transcript stores tool start/end timestamps but does not preserve authoritative full-turn boundaries. The `Worked ≈ …` total is therefore an estimate from visible work through the final reply. Missing tool durations remain “Not recorded”; only explicit overlapping execution intervals establish parallel groups. No backend or Agent upgrade is needed.
