# Automatic native goals

Agent 1.2.57 recognizes explicit sustained or multi-phase execution requests in Chinese and English. Recognition is conservative and deterministic: short requests, questions, plan-only input, slash commands, quoted blocks and agent mail do not create goals. Requests longer than 2,000 characters remain ordinary turns. No token budget is inferred.

Recognition runs when a message is consumed, never when a queued preview or steer is delivered. Existing native goals (including paused, blocked and limited Codex goals) remain authoritative. A per-session hash ledger prevents the same automatically handled request from creating another goal after a clear or Agent restart. Ledger read/write failures leave the request on the normal execution path.

- Codex: `turn/start` accepts the original text, images, model and permissions first. Under the same lock as manual goal actions, `thread/goal/get` checks the current goal before `thread/goal/set`. A completed/interrupted turn cannot initiate a new goal. Goal-side failures do not lose the user turn.
- Claude: SDK initialization advertises `/goal`; supported consumed requests use that native command with the original content blocks and inbox notes. The goal card comes from native `goal_status` records. Native command markup is deduplicated, and resume hydrates only the latest goal state without replaying conversation history. Oversized command arguments remain ordinary input.
- The Agent advertises `automaticGoals`; older Agents keep their existing explicit-only behavior. Existing edit/clear controls and the engine's native completion behavior are reused.

## Verification

100 targeted tests passed across recognition, persistence, both adapters, Codex protocol, Claude remote delivery, scanner hydration and capability handling. After the last scanner/argument-length changes, the affected 12 tests passed again. The unchanged goal status adapters also retain their earlier 24-test evidence. CLI typecheck/build, App typecheck and production web export passed.

Independent native tests used temporary working directories and dedicated provider threads, without LMC business sessions:

- Codex 0.156.1: the production client and automatic-goal helper started a user turn, observed no existing goal, created an active native goal, and received successful normal turn completion. The test goal was then cleared. This verifies creation/delivery, not automatic goal completion.
- Claude SDK 0.3.280 / Code 2.1.280: the remote runner and preparation helper received native active and completed goal records. A separate image-bearing request retained the picture and identified its orange starburst correctly. A 2,000-character goal was accepted and completed.

These tests do not establish perfect natural-language recognition. The existing mobile/desktop goal-card alignment proof from Web v186 remains applicable because this change does not alter layout.

## Release / rollback

Agent payloads are staged beside 1.2.56, then selected through the normal runtime upgrade coordinator. Active sessions wait for a safe boundary; no active process is force-stopped. The previous catalog and release remain available for rollback. The web publisher retains the prior index and static assets. Public synchronization uses the repository's filtered export, without private Git history or runtime state.
