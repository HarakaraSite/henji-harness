# Bounded ordinary next-turn queue implementation results

Plan: `docs/plans/bounded-next-turn-queue.md`

Plan SHA-256: `9a9e5d42a8024a23c2a45a2a62b852f6c0012c378d05d8ec358b8539a6fc1831`
Baseline: `3aeb48e` (bounded mid-turn steering)

## Implemented contract

- The real-TTY controller owns one memory-only ordinary follow-up slot per manually submitted busy
  cycle. Busy Enter remains steering; busy Alt+Enter admits the follow-up, and idle Alt+Enter is
  ordinary Enter.
- The decoder recognizes only `ESC CR`, `ESC LF`, `ESC CR LF`, and xterm
  `ESC [ 27 ; 3 ; 13 ~` before the fixed 50 ms deadline. Expired sequences retain Escape-first
  behavior and never queue a follow-up.
- A valid nonblank, NUL-free editor value up to 65,536 UTF-8 bytes is copied once into the slot.
  Pending status contains no text, duplicate/closed admission preserves the draft, and no queue
  record is emitted at admission.
- The controller takes and closes the slot only after a successful final/tool-terminal turn has
  committed, emitted its committed `turn_end`, and settled. It then performs one ordinary
  sequential `submit()` with fresh session ownership. No concurrent submit, turn marker, event,
  schema, persistence, provider, or budget change was added.
- Cancellation, failure, exit, EOF, renderer/event failure, cleanup failure, and shutdown drop the
  pending text before ready/restore. The automatic turn cannot refill the slot; later manual input
  opens a new slot.

## Evidence

Focused offline evidence in this increment:

- decoder: 17 cases, including every xterm split boundary, legacy pre/at/post-deadline behavior,
  timed-out unknown/divergent CSI compatibility, poll/EOF handling, CRLF suppression,
  malformed/unsupported sequences, and exact editor limits;
- renderer: 10 cases, including pending composition with steering/progress, text non-disclosure,
  no-ready-gap rendering, and close behavior;
- controller: 41 cases, including success-only drain/order, both steering orders, fresh steering
  during a closed automatic slot, no-steering capability, duplicate/closed/no-refill behavior,
  queue-specific EOF/output/event/cleanup/exit-intent drops, settlement/restore/no-late-write,
  pending max-step and crash/close drops, and prior TUI lifecycle regressions;
- real session/persistence TUI: 4 cases, including durable N-only state before N+1 success,
  canonical two-turn persistence, request transcript exclusion before drain, turn ordinals,
  distinct signals/execution contexts, fresh 0/0/0 budgets and 8/8/16 admission, successful
  rollback to N, the allowed rollback-failure ghost N+1 with no N+2, and persistence-commit
  failure retaining only durable N;
- PTY/process: deterministic legacy/xterm drain, sub-50-ms split xterm admission, automatic N+1
  rejected refill with fresh steering, cancellation drop, ordering, and restoration/cleanup-poison
  cases are included in `tests/v0/tui_process_test.ts` and run through the repository process task
  with its `/usr/bin/script` capability.

Final focused counts are decoder/render/controller/session-TUI 17/10/41/4 and PTY/topology
25/4. The full offline suite and closure `v0:gate` pass 503/503; `v0:check`, `v0:fmt`,
`v0:lint`, and `git diff --check` pass.

Initial implementation review found P2 3: expired divergent CSI compatibility, incomplete
queue-specific failure/ownership evidence, and lifecycle-stage drift. The one planned closure fixed
those items. The narrow re-review closed decoder/lifecycle findings and left one evidence-only P2 for
split PTY, automatic-turn fresh steering, max-step, persistence-commit, and crash/close paths. The
separately approved residual evidence closure added those exact regressions. Owner final disposition
is Blocker/P1/P2 zero.

During independent owner verification, two earlier PTY cases each produced one non-reproducible
process-status failure on separate runs: the steering case exited unsuccessfully once, and the signal
case once returned 139 instead of 143. No queue assertion failed. The exact steering case then passed
three consecutive isolated runs, the signal case passed five, the complete PTY 25-case suite passed,
and the final full `v0:gate` passed 503/503. No source change was made for the transient harness
observations; they remain recorded as residual test-environment risk.

## Scope and safety

Changed product/test/docs files are limited to the controller, renderer, input decoder, TUI fixtures
and tests, README, this result record, and lifecycle documentation. `AgentSession`, loop contracts,
schema-v1 persistence format, request budgets, provider/network adapters, credentials, dependencies,
lockfiles, production commands, actual persistent product state, and `_refs/*` were not changed or
accessed. No push, tag, publish, or release was performed; the reviewed increment is committed only
after the owner final gate.

## Deferred and rollback

Multi-item/replenishing queues, pending-text persistence/dequeue/edit/history, `agent:run` queueing,
planner-child queueing, Kitty negotiation, provider-specific controls, and background execution remain
deferred. Code rollback restores the steering-only TUI behavior; successful automatic turns remain
ordinary schema-v1 turns and no session data is deleted or rewritten.
