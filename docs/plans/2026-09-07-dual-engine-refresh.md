# Claude / Codex capability and refresh implementation

Approved scope: authentication feedback, capability menus, safe Claude refresh; preserve Codex behavior and require both engines for future changes.

1. Add explicit runtime capabilities and sanitized engine authentication state; check the same executable/environment used by the runtime.
2. Add shared frontend authentication feedback and capability-based actions; never send Codex configuration to Claude.
3. Queue Claude refresh until a completed turn and empty input/permission queues. Pause ingress, drain async delivery, recheck, preflight authentication and durable identity, then ask the daemon to resume only after voluntary exit. Roll back ingress on failure.
4. Validate both engines in daemon preflight and preserve the same session identity. Refuse missing Claude transcript instead of silently creating a new conversation.
5. Verify regression tests, type checks and production builds. Existing processes continue with their loaded version; do not force restart live sessions for rollout.

Acceptance: unauthenticated/unknown auth, missing resume identity, permission wait, input arriving during preflight, failed daemon preparation and repeated clicks never stop or duplicate a session. Successful idle handoff preserves identity/cursor/settings. Both engines expose supported actions; old Agents do not advertise unsupported RPCs.
