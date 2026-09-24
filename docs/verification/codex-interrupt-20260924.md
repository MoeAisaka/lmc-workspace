# Codex interrupt recovery and image steering

Agent 1.2.55 / Web v183.

## Failure and fix

The interrupted turn completed normally, but the queued turn started before the
25 ms abort poll ran again. The poll observed the new turn and force-restarted it
after three seconds. The replacement process then tried to resume before the old
writer exited, received `already has an active writer`, and discarded the original
thread identity. The next input consequently started a new provider thread.

Abort polling now tracks the captured turn object. New turns wait for the complete
abort/recovery operation, and a replacement process waits for the old process to
close. Resume failure retains the original identity and settings. The runner retries
recovery before consuming queued input or publishing a release receipt.

Codex steering now accepts PNG, JPEG, GIF and WebP images, including image-only
replies. Attachment preparation is all-or-nothing; the turn identity and settings
are checked again before delivery. Unsupported or unreadable attachments stay
queued. Claude's existing unsupported steer response and queue are preserved.

## Evidence

- Three isolated regressions fail on the previous client: false timeout against
  the next turn, resume before writer shutdown, and erased identity on resume error.
  They pass on the fix without provider calls.
- 136 targeted Agent tests passed across the app-server client, interruption,
  image preparation/steering, queue control, message queue and safe refresh.
  The final steering/recovery subset also passed after the settings recheck.
- Six App queue tests passed; both package typechecks, CLI build and production
  web export passed.
- A fresh candidate-source lab session used an allowlisted environment and a
  unique directory. Its PID, path and engine were verified before any input.
  Real Codex 0.156.1 promotion interrupted the first turn; the inserted reply
  completed on the same thread without a forced restart. The probe's initial
  metadata polling timed out on stale state; runner completion events and a fresh
  metadata query confirmed completion and idle state.
- The same isolated session accepted an encrypted, queued synthetic PNG through
  the real `steer` RPC, acknowledged seeing it, retained its thread identity and
  returned to idle. An initial malformed test PNG was replaced with a validated
  PNG before this acceptance. The idle lab runner was then stopped.

No business session received test input. No full-repository test run was performed.
Active production runners adopt the new Agent at their safe refresh boundary.
