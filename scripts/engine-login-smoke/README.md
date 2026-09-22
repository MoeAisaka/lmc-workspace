# D21 remote engine sign-in acceptance

Design: [D21 in Figma](https://www.figma.com/design/nbfECsO6gldGLBIf726SPX?node-id=136-1891).

From the repository root:

```sh
pnpm --filter lmc-wire build
pnpm --filter link-my-cli exec vitest run --project unit src/daemon/engineLoginManager.test.ts src/daemon/registerEngineLogin.test.ts src/utils/engineLoginContext.test.ts src/utils/engineAuth.test.ts src/utils/safeSessionRefresh.test.ts
pnpm --filter lmc-app typecheck
pnpm --filter lmc-app exec vitest run sources/sync/engineLogin.test.ts
CI=1 pnpm --filter lmc-app exec expo export --platform web --output-dir /tmp/lmc-d21-web
node scripts/engine-login-smoke/verify.cjs /tmp/lmc-d21-web
```

The CLI test setup also builds and typechecks the CLI. The browser fixture renders the actual exported components with synthetic data, uses a fresh browser context, blocks external requests and never loads the app bootstrap or a real account. Set `LMC_PLAYWRIGHT_MODULE` / `LMC_CHROME_PATH` when necessary. It covers desktop QR, phone/code entry, 320px layout, dark/light, code clearing, engine-specific controls, recovery outcomes, offline/timeout/legacy errors and URL validation.

Optional native compatibility probe (requires installed engines and network):

```sh
cd packages/lmc-cli
pnpm exec tsx ../../scripts/engine-login-smoke/native.mts
```

This first confirms no configured authentication in an empty temporary HOME/config directory, then starts each native login command and checks that its official URL and (Codex only) device code can be parsed, then cancels only the spawned login child and removes the temporary directory. It does not sign in, copy credentials or read private session directories. Output contains only endpoint origin/path and booleans.

## Contract and release checks

- Deploy the web and the new Agent; refresh existing sessions safely so both machine `engineLogin` and session `authenticationRecovery` capabilities are present. Older sessions show the upgrade explanation and terminal fallback.
- Claude uses `auth login --claudeai` with optional one-time code submission. Codex uses `login --device-auth`; device authorization must be enabled for the account. Custom providers/API-key helpers retain their original login path. Exact config-directory overrides, including absence, are preserved so macOS Keychain identity is unchanged.
- The target daemon owns one in-memory attempt per engine. Closing a panel does not cancel it; another authenticated LMC client on the same account can continue. Explicit cancel/timeout stops only the native login child. Daemon restart expires transient login attempts; credentials stay with the native CLI.
- URLs and codes use encrypted machine RPC only, are never put in metadata or chat and are cleared on terminal states. The 10-minute countdown belongs to the LMC attempt, not the provider token. Automatic checks are limited across clients for five minutes; explicit recheck is always available.
- Successful native login is followed by local CLI auth-status checking. This checks configured authentication, not inference access or account entitlement. Recovery uses the existing safe `configure-session` handoff, keeps session/resume identity, and waits for turns, queues and permissions. Only failed sessions in the same credential scope are refreshed. Completion needs a live new process, fresh applied metadata and fresh ready auth status.
- Recovery never replays a failed task. The user inspects the original turn before deciding whether to resend. Failed/unsupported recoveries remain visible separately from waiting/restored sessions.
- Live Google/ChatGPT authorization, native mobile UI and real cross-device session recovery require release-time verification. Local mock/fixture checks do not claim that verification. No deployment is performed by these commands.

## Local evidence (2026-09-22)

- CLI build/typecheck and 42 relevant tests passed; app typecheck and 6 RPC/capability tests passed.
- Production web export and isolated browser matrix passed without browser errors.
- Both real native entry probes passed: Claude currently emits `https://claude.com/cai/oauth/authorize`; Codex emits `https://auth.openai.com/codex/device` and a device code. Claude's older `/oauth/authorize` remains supported. No account authorization was completed by the probes.
- Not deployed or pushed as part of implementation. Actual account authorization and live session handoff remain release verification, not results of the local fixtures.
