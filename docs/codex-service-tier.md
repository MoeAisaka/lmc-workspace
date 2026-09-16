# Codex model speed

Settings → Agents → Codex exposes Backend default, Standard and Fast, with Simplified and Traditional Chinese translations. The setting is account-synced separately from model and reasoning effort. Null inherits the backend; explicit Standard sends `default`; Fast sends `fast` and enables `features.fast_mode` for the thread configuration.

The override applies when Happy starts/restarts/resumes a Codex process, including thread start/resume/fork and recovery. Existing live processes keep their launch configuration. Other agents do not receive the override. A machine must advertise `codexServiceTier: true`; otherwise the UI refuses explicit overrides with a localized update instruction.

RPC validates the enum before spawn; daemon forwards `--service-tier`; CLI rejects missing, duplicate and unknown values before authentication or daemon startup. Backend defaults and credentials are never rewritten. Rollback: restore the saved WebApp and CLI entry points; clear the speed override when using an older CLI.

Verified against local Codex 0.153.4: config/read accepts and returns `fast` and `default` without a model request. Offline tests cover choice/reset, spawn/resume forwarding, old-machine refusal, other-agent isolation, CLI fail-fast and thread start/resume/fork serialization. This does not certify that an account/model will receive Fast capacity.

Official source: https://learn.chatgpt.com/docs/agent-configuration/speed (2026-09-05). Astra Fast consumes 2.5× ChatGPT credits where available; API billing is separate. No arbitrary speed/billing multiplier is offered.

Chinese reasoning choices retain the official labels (for example 中（Medium）, 更高（xHigh）). Mobile Web session headers expose a 44×44 menu button wired to the same SessionActionsPopover and action provider as list right-click/long-press menus. The shared Web menu scrolls when taller than the viewport. Unit coverage verifies the shared component, current session ID, anchor and close callbacks.
