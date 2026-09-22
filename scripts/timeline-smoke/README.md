# Per-reply timeline acceptance

Build from the repository root:

```sh
pnpm --filter lmc-app typecheck
pnpm --filter lmc-app exec vitest run sources/utils/turnElapsed.test.ts sources/utils/turnTimeline.test.ts sources/hooks/useGroupedMessages.test.ts sources/sync/sessionLifecycle.spec.ts sources/sync/sessionThinking.spec.ts
CI=1 pnpm --filter lmc-app exec expo export --platform web --output-dir /tmp/lmc-timeline-web
node scripts/timeline-smoke/verify.cjs /tmp/lmc-timeline-web
```

Requires an installed `playwright-core`; `LMC_PLAYWRIGHT_MODULE` can point to its module directory. `LMC_CHROME_PATH` overrides the macOS Chrome executable.

The browser runner uses the exported production components, theme system, fonts and icons with synthetic Claude/Codex tool messages. It intercepts Metro registration in a temporary localhost fixture and skips the app bootstrap. It never loads a saved browser profile, authenticates or contacts the production API. The exported build is not modified. Screenshots are saved in the printed artifact directory.

Checks cover serial/parallel timing, details, fold/unfold, final-answer visibility, live elapsed time, stale records, failure and permission states, mobile width and theme switching. Unit tests cover the message grouping and timestamp rules. Native iOS/Android and live provider transport are outside this browser check.

D22 checks cover 22.5px desktop / 24.75px mobile rows (25% shorter than D20), status before the operation icon, no per-step timestamps or elapsed labels, and a 320px viewport. Titles remain 12px; exception explanations and permission actions remain accessible. Tool details retain individual timing.

The single turn total sits below the composer, beside usage figures on desktop and above them on mobile. The exported fixture uses the real `AgentInputUsageRow` and `TurnElapsedLabel`; its composer outline is synthetic. It checks live updates, frozen completion and the footer's position. It does not exercise the entire SessionView or live provider transport.

The app now retains timing from existing main-turn lifecycle envelopes through realtime and newest-history sync. Queue/steer messages and subagent events do not reset that clock; completion/cancellation freezes it. Legacy receive-time boundaries and bounded transcript estimates are marked approximate. Missing boundaries and replayed mixed clocks show time not recorded; session creation and heartbeat timestamps are never used as turn start. Existing ownership/order guards and thinking behavior remain unchanged. No Agent/server protocol upgrade is required.
