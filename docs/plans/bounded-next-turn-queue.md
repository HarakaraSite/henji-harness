# Provider-neutral bounded ordinary next-turn queue implementation and verification plan

## Decision summary

Concept **GO, initial implementation Human Gate pending**.

At baseline commit `3aeb48e`, add one controller-owned ordinary follow-up slot to the real-TTY TUI.
It remains separate from the existing mid-turn steering lane:

- busy Enter continues to admit steering;
- busy Alt+Enter admits one ordinary follow-up;
- the follow-up remains outside the active turn;
- only after that turn has successfully committed and fully settled does the controller call ordinary
  `AgentSession.submit()` with the queued text;
- the resulting execution is a fresh parent turn with its own turn number, cancellation owner,
  steering owner, planner admission, and parent 8 / child 8 / aggregate 16 request budget;
- cancellation, failure, exit intent, EOF, or shutdown drops a pending follow-up;
- the slot cannot be replenished while the automatically started turn is running;
- pending text is memory-only and never enters transcript, context metrics, persistence, provider
  requests, events, or counters;
- the queued text becomes ordinary `user_message` / `user>` data only through successful execution of
  its own later turn.

Queue ownership remains entirely in `TuiController` and `TuiRenderer`. No session-level queue API,
loop port, event type, schema change, provider change, or migration is required.

No unresolved Why/What/Whether decision was found. The exact terminal mappings and idle Alt+Enter
behavior below are local, reversible How choices. Implementation must stop at the initial Human Gate
before changing product source or tests.

## Authority and baseline

Sources of truth:

- repository `AGENTS.md`;
- `.handoff/handoff.md`, especially `POL-20260827-post-delegation-roadmap-order` and
  `POL-20260829-provider-neutral-mid-turn-steering-plan`;
- `README.md`, `v0/`, `tests/v0/`, and `deno.v0.json`;
- the completed cancellation, persistence, progress, streaming, context-management, and steering
  plans;
- pinned Pi commit `a69bef789bc95abf0acee16f7b4660b70b650bb9`;
- pinned Zot commit `9b7bb6a4f36bc8c8deb2cc5796a8f557f4fb7479`.

Verified baseline:

- HEAD is `3aeb48e feat(v0): add bounded mid-turn steering`;
- tracked tree is clean;
- existing untracked `_refs/*` are user-owned and remain unchanged;
- focused steering/store/TUI direct/process/topology suites pass 7/15/48/20/4 and the full offline
  gate passes 475/475;
- final steering review is Blocker/P1/P2 zero.

## Confirmed current boundary

- `AgentSession.submit()` is sequential and rejects concurrent submissions.
- Every accepted submission creates fresh cancellation, steering, request-budget, planner-admission,
  and turn-number ownership.
- Successful final or terminal turns commit before synchronous `turn_end`; persistence and rollback
  complete before the `submit()` promise settles.
- Cancelled, model-failed, and max-step drafts do not commit. A successful result is persisted before
  `turn_end`; a later event failure attempts rollback, and rollback failure retains the existing
  poisoned-session/recovery-artifact contract rather than guaranteeing restoration.
- The TUI controller owns the single active submission promise, cancellation/exit intent, editor,
  input decoder, status transition, settlement, and terminal restoration.
- Busy Enter currently owns the steering gesture.
- The current decoder interprets ESC followed by CR or LF as separate `escape` and `enter` events,
  which would incorrectly request cancellation if used as Alt+Enter.
- The TUI does not enable or negotiate Kitty keyboard protocol.
- `agent:run` has no interactive queue and must remain unchanged.

## Pinned comparison decisions

Adopt only these ideas from Pi:

- `_refs/pi/packages/agent/src/agent-loop.ts` and `_refs/pi/packages/agent/src/agent.ts`: steering and
  follow-up are distinct lanes;
- `_refs/pi/packages/coding-agent/src/modes/interactive/interactive-mode.ts`: Alt+Enter is the
  follow-up gesture, and idle Alt+Enter behaves like ordinary Enter;
- `_refs/pi/packages/tui/src/keys.ts` and its tests: legacy ESC+Enter and xterm modifyOtherKeys are
  relevant terminal encodings.

Adopt only this behavior from Zot:

- `_refs/zot/packages/agent/modes/interactive.go`: an ordinary queued prompt begins only after the
  active work completes cleanly, and cancellation/error drops pending work.

Do not adopt Pi or Zot's multi-item/replenishing queues, session-level queue APIs, dequeue/edit
history, compaction queues, RPC, extensions, images, retry behavior, background execution, or
dependencies. No upstream code is copied and `_refs/` remains unchanged.

## Scope

In scope:

- one controller-local follow-up slot;
- a distinct `alt_enter` terminal input event;
- exact admission, validation, rendering, drain, and drop behavior;
- independence from the existing steering lane;
- automatic ordinary submission after successful durable settlement;
- direct decoder/editor/renderer/controller evidence;
- real PTY evidence;
- persistent-session and committed-context evidence;
- cancellation, failure, EOF, signal, restoration, and no-late-write evidence;
- README, results, lifecycle records, offline verification, and bounded review.

Out of scope:

- session-, loop-, provider-, or runtime-owned queue state;
- more than one pending follow-up or replenishing the slot during the automatically started turn;
- persistence, recovery, dequeue, editing, replacement, history, or priorities for pending text;
- queueing from `agent:run` or planner-child queueing/event forwarding;
- schema/version/message/event changes or changed request budgets/retry/fallback;
- background or concurrent submission;
- Kitty keyboard negotiation or provider-specific controls;
- dependencies, lockfiles, permissions, credentials, provider/network execution, actual persistent
  product state, `_refs/` changes, destructive operations, commit, push, tag, publish, or release.

## Exact terminal input grammar

Add `{ readonly kind: 'alt_enter' }` and decode exactly these byte sequences as one atomic event:

```text
ESC CR
ESC LF
ESC CR LF
ESC [ 27 ; 3 ; 13 ~
```

The first three forms are `1b 0d`, `1b 0a`, and `1b 0d 0a`; the last xterm modifyOtherKeys form is
`1b 5b 32 37 3b 33 3b 31 33 7e`.

Rules:

- ESC followed by CR or LF before the existing 50 ms escape deadline emits exactly one `alt_enter`.
- ESC+CRLF suppresses LF in the same way ordinary CRLF emits one Enter.
- The sequence may be split across input chunks.
- If the 50 ms deadline has expired, ESC remains `escape`; the later CR/LF remains `enter`. At the
  exact deadline, existing timeout-first behavior wins.
- The complete xterm modifyOtherKeys sequence must terminate before the same deadline. Test every
  split boundary before, at, and after 50 ms. At or after the deadline, existing timeout-first
  decoding emits `escape`, then processes the remaining `[27;3;13~` bytes as ordinary printable
  input; while busy this may request cancellation before transient editor mutation. It must not emit
  `alt_enter` or queue a follow-up.
- Lone ESC, ordinary CR/LF/CRLF, unknown CSI, malformed UTF-8, bracketed paste, and EOF validation
  retain current behavior.
- Do not recognize Kitty CSI-u encodings because this TUI does not negotiate Kitty keyboard mode.
- While idle, `alt_enter` invokes the same submission path as ordinary Enter.
- While busy, only `alt_enter` targets the ordinary slot; it must never first emit `escape`.

## Queue state machine and ownership

The controller owns one state machine for each manually initiated busy cycle:

```text
closed
  |
manual Enter starts turn
  v
open-empty --valid busy Alt+Enter--> pending
    |                                 |
    | active turn ends/drops          | successful commit + settlement
    v                                 v
  closed                         taken/closed
                                      |
                                      v
                          ordinary queued turn running
                          (slot cannot reopen)
                                      |
                                      v
                                   closed
```

A later manually entered idle task opens a new empty slot. Automatically submitting the queued turn
does not reopen it. Private controller state must represent whether admission is open, the pending
text, whether the active turn was automatic, and the renderer's text-free pending indicator. There is
no array, replacement, exposed peek API, or session API.

## Admission and validation

The shared busy editor retains its existing contract: text must be nonblank after `trim()`, otherwise
preserved exactly, NUL-free, strict Unicode, and at most 65,536 UTF-8 bytes. Backspace removes one
Unicode scalar and bracketed paste remains atomic.

Busy Alt+Enter behavior:

- blank editor: retain it and show `enter follow-up text`;
- open slot with valid text: copy exact text into the slot, clear the editor, mark pending, and show
  `busy · follow-up queued`;
- pending or closed slot: do not replace queued text or clear the draft; show `follow-up already
  queued` or `follow-up slot closed`;
- validation failure: admit nothing and preserve the prior valid editor state;
- raw NUL remains ignored; NUL-containing paste remains atomically rejected;
- exact multibyte boundary text is admitted and overflow cannot partially mutate editor or slot.

Steering and follow-up capacities are independent. Either order must work. After both are used,
further ordinary input is consumed until settlement. During the automatically started turn its fresh
session steering lane remains available, while the follow-up slot remains closed. A fake session
without `steerActiveTurn` still supports Alt+Enter queueing; ordinary busy Enter reports steering
unavailable and never becomes a follow-up.

## Ordering and automatic submission

A pending follow-up is eligible only when the active submission resolved normally with `ok: true`
and stop reason `final` or `tool_terminal`; commit, `turn_end`, persistence/rollback bookkeeping,
cancellation settlement, and session cleanup have completed; exit intent remains `return`; and no
input, output, agent, cleanup, or terminal failure occurred.

Exact order:

```text
turn N final/terminal result
turn N commit and durable persistence
turn N turn_end(committed=true)
turn N session cleanup and submit() settlement
controller takes and closes pending slot
controller clears pending-only renderer state
controller calls AgentSession.submit(queuedText)
turn N+1 turn_start
turn N+1 user_message
turn N+1 ordinary model/tool execution
```

Never call `submit()` from the `turn_end` event sink. Before taking the text, move it to a local
single-use value and close the slot. If subsequent rendering/controller work fails, discard it.

The automatic turn is ordinary: no queue marker in messages/events/outcomes/persistence; next parent
ordinal; fresh cancellation, steering, planner admission, and parent 8 / child 8 / aggregate 16
budget; counters start at zero; committed transcript from N precedes its user message; success
commits normally; cancellation/failure rolls back only its own draft while retaining N. Do not add an
aggregate controller outcome.

## Drop and precedence rules

Synchronously detach and drop pending text before any path can return ready, exit, restore, or report
fatal failure. Drop on Escape; Ctrl-C/SIGINT; SIGTERM/SIGHUP; EOF or input failure; output/render or
event-sink failure; contract/model failure; max steps; cancellation/cleanup failure; persistence
commit/rollback failure; shutdown/crash/renderer close; non-return exit intent; and unexpected
synchronous rejection when starting the queued turn.

Cancellation remains authoritative over draining; cleanup failure remains fatal; controller failure
remains authoritative while active work is cancelled and awaited; a successful turn with exit intent
does not drain; completed provider/tool/Bash/filesystem effects are not rolled back; queue-indicator
clear failure prevents submission; dropped or partial text never becomes idle editor content.

## Rendering and status contract

Add renderer-owned boolean pending state without storing text:

- queued text is not written to scrollback at admission;
- pending status survives assistant/tool progress and steering status changes;
- nonempty editor retains display priority; live progress remains visible when empty;
- deterministic combined statuses include `busy · follow-up queued`, `busy · steer pending ·
  follow-up queued`, and `busy · steer applied · follow-up queued`;
- committed `turn_end` with pending work shows `busy · starting follow-up`, never intermediate
  `ready`;
- clearing pending state before submission retains busy status until the next `turn_start`;
- later `user_message` emits existing escaped `user> <text>` exactly once, with no queue-specific
  scrollback record;
- cancellation/failure clears the indicator before settlement; renderer close prevents late writes;
- pending text is absent from statuses, errors, and diagnostics.

## Transcript, context, persistence, and compatibility

Before drain, pending text appears in no active transcript/outcome, event, provider request,
tool/planner input, counter, context metric, session JSON/metadata, restored display, filesystem, or
log. After N+1 starts, persisted bytes retain only N until N+1 reaches its existing success-commit
boundary. From that commit through `turn_end` and final settlement, the durable record may already
contain N+1. Successful settlement retains the ordinary canonical two-turn record. A post-commit
failure attempts the existing rollback: successful rollback restores exact N bytes and committed
metrics, while rollback failure poisons the session and may retain a recovery artifact or ghost record
containing N+1. Neither case may start N+2 or preserve controller queue state.

Schema v1 already represents sequential successful parent turns. Do not change schema version,
record keys/order, message variants, causal parsing, `nextTurn`, bounds, canonical bytes,
list/resume/delete behavior, paths, locks, atomic replacement, or rollback. Baseline code can read
records containing successful automatic turns because they are ordinary turns.

Do not change `AgentSession`, `runAgentTurn`, `AgentEvent`, loop contracts, steering ownership,
planner-child isolation/nonrecursion, request limits, provider wire/SSE/usage/retry/credentials,
progress/streaming/context contracts, cancellation cleanup, definitions/tools/permissions/CLI,
launchers, corpus/eval, sentinels, or `agent:run` behavior.

## Planned files and ownership

One implementer owns all writes.

| File/component | Planned change |
|---|---|
| `v0/tui/input.ts` | add exact `alt_enter` decoding and CRLF/timeout handling |
| `v0/tui/controller.ts` | controller-local slot, gestures, success-only drain, drop/cleanup |
| `v0/tui/render.ts` | generic pending indicator and no-ready-gap rendering |
| `tests/v0/tui_input_test.ts` | byte grammar, split, timeout, xterm, regressions |
| `tests/v0/tui_render_test.ts` | pending/status/progress/close/no-disclosure evidence |
| `tests/v0/tui_controller_test.ts` | state machine, independence, ordering, failure matrix |
| `tests/v0/fixtures/tui_process_fixture.ts` | deterministic two-turn/drop modes |
| `tests/v0/tui_process_test.ts` | real PTY ordering, cancellation, no refill, restoration |
| `tests/v0/agent_session_tui_test.ts` | durable boundary and rollback evidence |
| relevant existing compatibility tests | edit only for queue-specific regressions |
| `README.md` | gesture, bounds, ordering, drops, deferred features |
| `docs/plans/bounded-next-turn-queue-results.md` | acceptance evidence |
| `AGENTS.md`, `.handoff/handoff.md` | final lifecycle state |

No new source module or test task is expected. `deno.v0.json` remains unchanged unless a genuinely new
test file is required; that requires a plan delta and topology evidence.

## Ordered implementation increments

1. Add `alt_enter` decoding with byte regressions.
2. Add renderer pending state and prove generic composition/no disclosure/no ready gap.
3. Add controller slot transitions and admission without auto-drain.
4. Integrate independent steering and follow-up gestures.
5. Add success-only take-and-submit after active settlement.
6. Close replenishment during automatic turn and retain fresh steering.
7. Add cancellation/failure/exit/EOF/renderer/crash drop paths.
8. Add real session evidence for fresh ownership, context, budgets, and no concurrency.
9. Add persistence evidence for durable N before N+1 and rollback of N+1.
10. Add deterministic PTY flows and restore/no-late-write assertions.
11. Update README, results, AGENTS, and handoff.
12. Run focused/full offline verification and bounded review, with at most one plan-scoped closure pass.

## Deterministic test contract

Decoder/editor tests cover all exact sequences and split boundaries. Legacy forms prove
before/at/after 50 ms behavior. The complete xterm form must finish before 50 ms; every split proves
successful pre-deadline decoding and exact at/after-deadline `escape` plus printable remainder,
including controller cancellation/editor effects. Ordinary CR/LF/CRLF, lone Escape, unknown CSI,
malformed/incomplete input, paste, blank, NUL, malformed UTF-8, exact 65,536-byte ASCII/multibyte
limits, and atomic overflow remain covered.

Controller/renderer tests prove one admission per manual cycle; exact preservation; duplicate/closed
draft preservation; both steering/follow-up orders; no admission side effects; pending status without
text disclosure; no observable ready gap; no concurrent submit; no refill in automatic turn; fresh
steering; a new slot after later manual input; exactly one later `user>` record; escaping/bounds; and
no late writes.

Real-session/persistence tests prove `[manual, queued]` order; turn ordinals 1/2; distinct signals and
execution contexts; fresh 0/0/0 counters and unchanged 8/8/16 budgets; absence of queued text from N;
N commit/`nextTurn` before N+1 request; N-only bytes before N+1's success-commit boundary; the allowed
transient canonical N+1 record between commit and settlement; canonical two-turn success; exact N
preservation after cancellation, pre-commit failure, and successful rollback; rollback-failure
poisoning with the allowed recovery artifact/ghost N+1 record; no N+2 submission in either rollback
case; clean resume where the store contract permits it; and planner isolation.

The drop matrix covers Escape, Ctrl-C/SIGINT, SIGTERM/SIGHUP, EOF/input failure, model/contract/max
steps, event failure, persistence/rollback failure, cleanup poisoning, progress/stream output failure,
renderer failure, crash/close, and success with exit intent. Each case asserts settlement before one
restore, no late writes, and no N+2 submission. Pre-commit failures and successful rollback retain no
N+1 text in committed state; rollback failure instead proves poisoning and accepts the existing
recovery artifact/ghost-record contract.

PTY evidence covers delayed N, legacy and split Alt+Enter, successful commit and automatic N+1, exact
`user>` ordering/no intermediate ready, cancellation drop, rejected second Alt+Enter with fresh
steering, bounded output/deadline, and zero provider/credential access.

## Verification commands

Use repository-defined Deno 2.9.4 tasks:

```text
deno task --config deno.v0.json agent:tui:test
deno task --config deno.v0.json agent:tui:process:test
deno task --config deno.v0.json agent:tui:topology:test
deno task --config deno.v0.json agent:session:test
deno task --config deno.v0.json agent:session-store:test
deno task --config deno.v0.json agent:session:tui:test
deno task --config deno.v0.json agent:session:process:test
deno task --config deno.v0.json agent:sessions:topology:test
deno task --config deno.v0.json agent:cancellation:test
deno task --config deno.v0.json agent:steering:test
deno task --config deno.v0.json agent:context:test
deno task --config deno.v0.json agent:tool-progress:test
deno task --config deno.v0.json agent:streaming:test
deno task --config deno.v0.json agent:planner-delegation:test
deno task --config deno.v0.json agent:runtime:test
deno task --config deno.v0.json agent:runtime:process:test
deno task --config deno.v0.json agent:transport:test
deno task --config deno.v0.json v0:check
deno task --config deno.v0.json v0:fmt
deno task --config deno.v0.json v0:lint
deno task --config deno.v0.json v0:test
deno task --config deno.v0.json v0:gate
git diff --check
```

Do not run production `agent:tui`, `agent:run`, `agent:sessions`, acceptance/live corpus,
credential-launcher, or real-model sentinel commands. Do not access credentials, network, or actual
persistent product state.

## Acceptance package

The results document maps requirements to exact evidence, including slot/gesture/grammar, steering
independence, no active-turn mutation, success-only drain, no concurrency/ready gap, fresh ownership,
no refill, pending-state absence, persistence/rollback, complete drop matrix, compatibility,
restoration/no-late-write, and zero prohibited activity. Record plan hash and revisions, changed
files, constants/sequences, test counts, review/fixes, deviations, risks, and rollback.

README replaces “ordinary queued follow-up remains deferred” with this one-slot contract while
retaining broader queueing, persistence, dequeue/edit, RPC, background, and provider execution as
deferred.

## Completion conditions

Complete only when every rule is implemented, all focused/full offline checks pass, unrelated tracked
work and `_refs/*` remain untouched, evidence documents match observations, bounded review returns
Blocker/P1/P2 zero, and no prohibited operation occurred.

## Rollback

There is no schema/data migration. Code rollback restores steering-only controller/decoder behavior.
Successful automatic turns remain ordinary valid schema-v1 parent turns; pending memory-only state
disappears naturally. Do not delete or rewrite user session data.

## Residual risks

- Alt+Enter encodings vary; only the tested legacy and xterm forms are supported.
- A delayed legacy modifier sequence may cross the Escape timeout and act as cancellation plus Enter.
  A delayed xterm sequence emits Escape followed by printable remainder, which may cancel a busy turn
  and transiently mutate its editor; neither form queues a follow-up after the deadline.
- Pending text is lost on process/VM termination and has no dequeue window.
- An automatic turn incurs ordinary provider cost in production.
- Completed model/tool/Bash/filesystem effects are not rolled back.
- One slot/no refill prevents longer automatic chains.
- The one-line editor/status may temporarily hide live progress details.
- Offline tests do not cover real-provider adherence or unlisted terminal encodings.

## Stop conditions

Stop and return cause, evidence, impact, proposed delta, and verification if correctness requires a
schema/provider/budget/persistence/steering change; queue ownership below TUI; multiple items/refill;
pending persistence; concurrency/retry/RPC/extensions; dependencies/permissions/credentials/network;
Kitty negotiation or broader key contract; failure/restore precedence changes; unrelated changes; or
`_refs/` modification.

## Initial Human Gate

Implementation approval authorizes only repository implementation of this plan; disposable offline
fake, PTY, and temporary session-state tests; full offline verification; README/results/AGENTS/handoff
updates; bounded read-only review; and one plan-scoped finding-closure pass.

It does not authorize production commands, actual persistent product state, credentials,
provider/network requests, real-model attempts, dependencies, lockfile changes, `_refs/` changes,
sibling/shared-VM changes, commit, push, tag, publish, or release.
