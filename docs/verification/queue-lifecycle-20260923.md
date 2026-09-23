# Queue visibility and hub collapse verification

Agent 1.2.54 / Web v174.

Queued messages carry a capability-gated `queueKey`. The composer strip derives its pending row immediately from that identity. The transcript waits for a durable `queue-released` receipt; snapshot removal alone cannot release a prompt because steering may temporarily take and restore it. `queue-withdrawn` takes precedence. Attachment records share the prompt identity. Older Agents retain their existing snapshot-based behavior until refreshed.

Hub worker groups start collapsed with zero reserved body height. Explicit expansion/collapse survives list remounts.

## Evidence

- App: 16 targeted queue tests passed, including real normalization/reducer preservation of attachment identities and receipts.
- Agent: 51 targeted tests passed across MessageQueue2, sessionQueueControl, serialAsyncHandler and Codex clear command. CLI build/typecheck passed.
- App typecheck and production Expo export passed.
- `scripts/queue-lifecycle-smoke/verify.cjs` exercised the actual exported ChatList, QueueStrip and DeviceEngineSessionList: optimistic send before snapshot, temporary take/restore, receipt before snapshot removal, withdrawal, default collapse and remembered toggles. Claude/Codex, light/dark, widths 320/390/1100. No browser errors.
- Isolated candidate-source sessions exercised real Claude promote and Codex steer, queued keys, durable release and withdrawal. Each runner used an allowlisted environment without inherited session/reconnect/fork/worker identifiers; PID, unique lab directory and engine were verified before sending. Both passed and were stopped only after becoming idle.
- Production and preview v174 entry points and all seven referenced assets matched the exported hashes.

No full-repository test run was needed for this bounded change. Existing active sessions adopt the new capability only after their safe refresh boundary.
