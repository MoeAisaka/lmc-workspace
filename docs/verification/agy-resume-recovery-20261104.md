# Antigravity resume recovery — 2026-11-04

The Web resume eligibility check only accepted Claude/Codex identifiers, blocking an inactive Antigravity session even when `agyConversationId` existed. Resume commands and eligibility now use the same engine-aware helper; Antigravity requires its own identifier. Missing-identifier copy is engine-neutral.

Validation against this change:

- 13 focused resume/translation tests passed, including existing Claude/Codex/Rig behavior, Windows Antigravity resume, and refusal to use an earlier engine identifier.
- App TypeScript check passed; Expo Web production export completed with two workers.
- Local and NAS Web release `lmc-redesign-20260908-v389` published with no asset replacement conflicts. Previous index backups: `index.previous-1793762484111.html` and `index.previous-1793762497385.html`.
- Public HTTPS entry returned the new marker; all six referenced resources returned successfully and matched exported hashes where present in the build.
- Recovery used the existing machine resume RPC after confirming no target process remained. The original LMC session and native conversation identifiers were retained; the daemon listed one child, its launch arguments included the original native resume identifier and model, and the session returned to the live session list. No business message was submitted for testing.
- Full model response execution was not tested because that would send a new business turn. Agent/CLI versions were unchanged.
