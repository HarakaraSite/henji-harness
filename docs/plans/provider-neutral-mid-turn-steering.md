# Provider-neutral bounded mid-turn steering implementation and verification plan

## Decision summary

Concept **GO, initial Human Gate pending**.

This increment adds one provider-neutral, single-use steering lane to each active parent turn:

- at most one nonblank, NUL-free steering message, bounded to 65,536 UTF-8 bytes, may be admitted
  during an active parent turn;
- admission does not mutate the in-flight provider request, partial assistant state, current tool
  call, counters, transcript, context metrics, or persistence;
- consumption occurs only after one completed assistant tool-call response and its complete selected
  tool batch/results have settled, and only when another parent model request can follow;
- consumption appends one ordinary `UserMessage` to the current parent draft immediately before the
  next context preparation and request;
- completed final responses, terminal tools, max-step exhaustion, cancellation, and failures close
  the lane and discard any unconsumed message;
- a consumed message is stored as an ordinary schema-v1 `UserMessage` only if the enclosing parent
  turn later succeeds;
- schema version, record keys, message shapes, file/display/session limits, and canonical encoding
  remain unchanged; schema-v1 causal validation is extended additively to recognize the one legal
  intra-turn steering position;
- `nextTurn` continues to identify the next parent turn and is validated from completed parent
  turns, not from the raw number of user-role messages;
- busy TUI input becomes a bounded steering editor, not an ordinary next-turn queue;
- `agent:run`, provider wire behavior, planner-child privacy, request limits, schema v1,
  cancellation, progress, streaming, and terminal-tool behavior remain compatible.

The exact bound is **one admitted steering message per accepted parent turn**, not a replenishing
queue slot. A consumed or discarded lane cannot be reused during that turn. Planning baseline is
commit `852542f`; the preceding streaming increment passed the full offline gate at 460/460 with
Blocker/P1/P2 zero. No requirement contradiction or unresolved user-visible decision was found. The
schema correction is How-only: successful consumed steering must persist, while current schema v1
already stores canonical `Message[]` and rejects NUL. The smallest compatible change is an additive
causal-validator rule plus completed-parent-turn derivation, without a version/key/limit change or
migration.

## Authority and prerequisites

Sources of truth are repository `AGENTS.md`, `.handoff/handoff.md` record
`POL-20260827-post-delegation-roadmap-order`, `README.md`, current `v0/`, `tests/v0/`,
`deno.v0.json`, and the completed cancellation, context-management, persistent-history,
tool-progress, and streaming plans.

The roadmap fixes bounded mid-turn steering after streaming and before any optional ordinary
next-turn queue. Product implementation requires a separate initial Human Gate after review of this
plan.

## Confirmed current boundary

- `AgentSession.submit()` admits one sequential parent turn and rejects another submission while
  active. Each accepted turn owns fresh cancellation and parent execution contexts.
- `runAgentTurn()` owns the draft, parent request claims, completed result interpretation,
  sequential tool dispatch, terminal handling, and successful commit callback.
- The safe continuation boundary is after all selected tool calls and completed `tool_result`
  events settle and the complete `ToolMessage` enters the draft, before the next request.
- OpenRouter streaming returns one completed authoritative `ModelResult`; assistant/tool progress is
  live-only.
- Planner delegation is synchronous inside a parent tool call, shares cancellation/request
  ownership, exposes no child event sink, and returns one bounded result.
- Only successful parent transcripts update in-memory state, committed context metrics, and
  schema-v1 persistence. Event or persistence failures restore the preceding committed state.
- Busy TUI input currently retains only Escape and Ctrl-C behavior. Other input is discarded.
- `agent:run` uses the one-shot wrapper, has no event sink, and is nonpersistent.

## Pinned comparison decisions

Pi is the MIT-licensed pinned commit
`a69bef789bc95abf0acee16f7b4660b70b650bb9`.

Adopt only these comparison ideas:

- `_refs/pi/packages/agent/src/agent-loop.ts`: poll steering after a completed assistant response
  and all selected tool results, then inject it before the next assistant request;
- `_refs/pi/packages/agent/src/agent.ts`: keep steering and follow-up as distinct lanes, and keep
  admitted steering outside transcript state until consumption;
- `_refs/pi/packages/agent/test/agent-loop.test.ts`: prove a selected tool batch finishes before
  steering injection;
- `_refs/pi/packages/coding-agent/src/modes/interactive/interactive-mode.ts`: busy interactive
  submission may be treated as steering rather than an ordinary prompt.

Do not adopt Pi's replenishing queues, follow-up lane, queue modes, RPC, extensions, images, async
listener architecture, transcript architecture, or dependencies.

Zot at pinned commit `9b7bb6a4f36bc8c8deb2cc5796a8f557f4fb7479` documents busy-input ordinary
next-turn queueing in `_refs/zot/README.md`. That behavior is explicitly deferred. No upstream code
is imported or copied, and `_refs/` remains unchanged.

## Scope

In scope:

- one single-use, one-message steering owner per active parent turn;
- exact admission, validation, result, ordering, consumption, and closure semantics;
- safe-boundary consumption in the provider-neutral loop;
- one completed steering lifecycle event at consumption;
- TUI busy steering editing, admission status, rendering, cancellation, and cleanup;
- consumed-only transcript/context/persistence inclusion on successful enclosing-turn commit;
- planner isolation, request-budget, terminal, streaming/progress, event-failure, persistence,
  cancellation, process, and topology evidence;
- one focused permission-free test task and README/results/lifecycle updates.

Out of scope:

- ordinary next-turn/follow-up queueing, multiple messages, replenishing capacity, multiple lanes,
  priorities, dequeue/edit after admission, or cross-turn carryover;
- steering an idle session or starting a new turn through the steering API;
- mutation, cancellation, or restart of an in-flight provider request;
- interruption of a running tool batch or injection between calls in one selected batch;
- planner-child steering or child event forwarding;
- persistence of pending/admission state or steering-origin metadata;
- RPC, extensions, server controls, provider-specific steering, retry, fallback, parallelism,
  dependencies, or lockfile changes;
- production commands, actual persistent state, credentials, network, `_refs/` changes, commit,
  push, tag, publish, or release.

## Steering owner and admission contract

Add `v0/agent/steering.ts` with:

```ts
export const MAX_STEERING_TEXT_BYTES = 65_536;

export type SteerRequestResult =
  | 'accepted'
  | 'idle'
  | 'already_accepted';
```

The owner is a single-use state machine:

```text
open-empty -> pending -> consumed -> closed
          \-----------------------> closed
```

It must distinguish a closed lane that never admitted a message from a lane that already admitted
one. A pending, consumed, or admitted-then-closed lane returns `already_accepted`; a turn with no
active/open lane and no earlier admission returns `idle`. `close()` is idempotent and drops pending
text. There is no list, replacement, mutable peek, reset, or second capacity.

Input is valid only when it is a string, nonblank after `trim()`, contains no U+0000 NUL, contains
no lone surrogate, and encodes to at most 65,536 UTF-8 bytes. Direct API failures are exact:

- blank or whitespace-only: `RangeError('steering text must not be blank')`;
- NUL: `RangeError('steering text must not contain NUL')`;
- malformed Unicode: `RangeError('steering text must be well-formed Unicode')`;
- over 65,536 UTF-8 bytes: `RangeError('steering text exceeds 65536 UTF-8 bytes')`.

A failed validation leaves the lane open-empty and consumes no admission. Trimming is used only for
blank detection; accepted text is otherwise preserved exactly.

`AgentSession.steerActiveTurn(text)` is synchronous and applies this precedence:

1. poisoned/unavailable session throws existing `AGENT_SESSION_UNAVAILABLE`;
2. validate text;
3. no active turn, no active owner, non-active cancellation owner, or never-admitted closed lane
   returns `idle`;
4. atomically install text in an open-empty lane and return `accepted`;
5. pending, consumed, or previously admitted lane returns `already_accepted`.

Admission emits no event, claims no request, and performs no model, tool, context, persistence,
filesystem, provider, or credential work. Every accepted `submit()` allocates one fresh owner before
`runAgentTurn()` and detaches/closes it in `finally`. `cancelActiveTurn()` closes/drops steering
before requesting cancellation, and admission also checks cancellation state.

## Safe-boundary consumption and ordering

Extend `AgentTurnOptions` with an internal optional steering-consumer port. Existing callers that
omit it remain unchanged.

The only consumption path is:

1. receive and validate a completed tool-call `ModelResult`;
2. append/deliver the completed assistant tool-call message;
3. execute every selected call under existing sequential, cancellation, terminal-batch, progress,
   and planner rules;
4. deliver every completed tool result and append the complete `ToolMessage`;
5. check cancellation;
6. if a successful terminal result exists, close/drop steering and finish `tool_terminal`;
7. if the parent max-step bound is reached, close/drop steering and finish `max_steps`;
8. atomically consume pending steering, if any;
9. append it as one ordinary `UserMessage` and deliver one `steering_message` event;
10. continue through existing cancellation, context preparation, parent request claim, and model
    generation.

Exact observable order:

```text
assistant_message(tool calls)
tool_call ...
tool_progress ...       optional
tool_result ...
complete ToolMessage enters draft
steering_message        only if another loop step is eligible
context preparation
parent request claim
next model request
```

The lane is never polled during SSE assembly, between assistant progress snapshots, between calls
in a selected batch, during planner-child execution or tool progress, before a completed result, or
after a final/terminal/max-step outcome. A completed final response, terminal result, max-step,
cancellation, contract failure, thrown event failure, commit/rollback failure, and cleanup failure
close it. An accepted but unconsumed message is discarded and never promoted to a later turn.

## Transcript, events, context, and outcomes

Add one execution-only event:

```ts
{
  readonly kind: 'steering_message';
  readonly turn: number;
  readonly message: UserMessage;
}
```

It is emitted only on consumption, uses existing snapshot isolation, and does not increment steps,
tool counts, request counts, or turn number. The consumed draft entry is an ordinary user message:

```ts
{ role: 'user', content: { kind: 'text', text: acceptedText } }
```

No origin field is added to `Message` or schema v1. Live TUI may render the event as `steer>`, while
restored history renders the committed entry as `user>`. `LoopOutcome.task` remains the initial
submitted task.

Context preparation observes steering only after consumption. Admission changes no metrics.
Successful enclosing-turn commit derives metrics from the complete transcript. Cancellation or
failure restores prior committed metrics. Pending/unconsumed text appears in no event, outcome,
transcript, context metric, persistent bytes, provider request, or restored history.

## Schema-v1 causal validation and parent-turn derivation

Current schema-v1 validation assumes every user-role message starts a new parent turn and validates
`nextTurn` as raw user count plus one. A consumed steering message instead has one legal intra-turn
position:

```text
initial user
assistant tool calls
matching nonterminal ToolMessage
steering user
assistant ...
```

Modify only causal validation and derived counting in `v0/agent/session_store.ts`. Keep
`SESSION_SCHEMA_VERSION === 1`, exact record keys/order, `Message` shapes, canonical JSON encoding,
the 8-MiB file limit, session/display limits, metadata shape, and error codes unchanged.

Replace the boolean-only causal walk with one parser that returns completed parent-turn count or
failure. Its grammar is:

```text
record           := parentTurn+
parentTurn       := initialUser parentStep+
parentStep       := finalAssistant
                  | assistantToolCalls matchingToolMessage terminal
                  | assistantToolCalls matchingToolMessage nonterminal optionalSteering
optionalSteering := empty | steeringUser
```

Operationally:

1. require one initial `UserMessage` to start each parent turn and an assistant next;
2. an assistant text message completes exactly one parent turn;
3. assistant tool calls require the immediately following matching `ToolMessage` under existing
   count, call-ID, and name checks;
4. a terminal `ToolMessage` completes exactly one parent turn and permits no steering afterward;
5. after a nonterminal `ToolMessage`, permit either the next assistant step or exactly one steering
   `UserMessage` followed by the next assistant step;
6. permit at most one steering `UserMessage` within that parent turn, even after later nonterminal
   tool steps;
7. reject steering before a tool result, consecutive users, a second intra-turn user, steering after
   final/terminal, a transcript ending at steering, or any unfinished parent turn;
8. after a completed parent turn, the next `UserMessage` begins the next parent turn.

The parser increments only for a text final or terminal tool result. Validate
`record.nextTurn === completedParentTurnCount + 1`; an intra-turn steering user never advances the
parent-turn ordinal.

Existing schema-v1 transcripts remain valid byte-for-byte. New steering transcripts use the same
record shape and encoder. List, resume, metadata `turnCount = nextTurn - 1`, allocation, locks,
atomic replacement, rollback, and replay require no migration or rewrite. The runtime still supplies
`turn + 1`; the codec independently proves that value from completed parent turns.

## Cancellation, failure, and persistence precedence

- Cancellation before consumption closes and drops pending steering.
- Cancellation after consumption rolls back the whole current draft, including steering.
- Successful settlement still loses to re-entrant cancellation under current arbitration.
- Cleanup failure poisons the session and retains precedence over cancelled/signal exit behavior.
- `steering_message` sink failure surfaces the stable `EventDeliveryError`, starts no next request,
  emits no later event, rolls back state, and retains existing TUI restoration precedence.
- Because consumption follows model/tool resource settlement, steering adds no cleanup resource.
- Admission performs no write. Successful enclosing-turn commit writes the canonical transcript
  once. Commit, `turn_end`, or durable rollback failures retain current sanitization/poisoning.
- Completed provider, Bash, or filesystem effects are not rolled back.
- NUL is rejected before lane admission, so accepted steering cannot become a late persistence
  failure under existing schema-v1 `validString`; non-steering string validation is not broadened.

## Planner, budget, streaming, progress, and terminal compatibility

Steering is available only to the parent `runAgentTurn()` owned by `AgentSession`. Planner children
receive no steering port or sink. Steering admitted during delegation remains pending until the
child and the complete parent tool batch settle.

Parent 8 / child 8 / aggregate 16 remain exact. Admission/consumption claims no request; any
continuation uses the ordinary next parent claim within the eight-step bound. In-flight SSE and
partial progress remain immutable and live-only. A successful sole terminal tool always ends the
turn, discarding pending steering without a follow-up request.

## TUI contract

Expose `steerActiveTurn` through the production TUI session port. It may remain optional for narrow
existing fake-session seams; absence preserves old busy-discard behavior.

While busy and before admission:

- printable strict UTF-8 and bounded bracketed paste append to a dedicated steering editor;
- Backspace removes one Unicode scalar;
- Enter validates and attempts admission;
- Escape and Ctrl-C/signals retain current cancellation/exit precedence;
- Ctrl-D and unknown control/CSI input are consumed;
- a raw NUL byte remains an `unknown` input event and is consumed without editor mutation;
- bracketed paste containing NUL is rejected atomically, leaves the steering editor unchanged, and
  reports `invalid steering input`;
- invalid UTF-8 reports `invalid UTF-8` without mutation;
- malformed/oversized paste retains `paste exceeds 64 KiB` without mutation;
- blank Enter reports `enter steering text`.

The controller must reject paste NUL before `TuiEditor.append`; the editor never contains a value
that direct admission or schema v1 rejects. If a direct-test seam nevertheless throws a fixed
steering `RangeError`, the controller preserves any existing valid draft, admits nothing, and shows
`invalid steering input`.

On `accepted`, clear the draft, permanently mark the lane used for that turn, show
`busy · steer pending`, and continue without cancellation. On `already_accepted`, show
`steering already accepted`. On an `idle` settlement race, discard the draft and show
`steering window closed`; normal settlement then controls ready/exit status. After admission,
further ordinary input is consumed for the remainder of the turn.

The steering editor has display priority over the one-line live assistant/tool state while nonempty.
Underlying latest progress may update but does not become scrollback; clearing the draft reveals it.
Consumption writes exactly one escaped `steer> <text>` scrollback record and shows
`busy · steer applied`. Restored schema-v1 history retains ordinary `user>` display.

Every settlement, cancellation request, fatal failure, crash, signal shutdown, renderer close, and
terminal restore clears the steering editor and UI state. Partial or unconsumed input never becomes
the next idle editor value, and no late steering redraw is permitted after closing.

## Compatibility requirements

Do not change:

- `agent:run` invocation, stdout/stderr, exits, final-only behavior, or nonpersistence;
- TUI flags, launcher permissions, state-root behavior, or session selection;
- provider profile/wire/SSE/credential timing/timeouts/retry/request counting;
- agent definitions, registries, tool permissions, planner nonrecursion, or child envelopes;
- cancellation propagation, Bash cleanup, event-failure latch, or poisoning;
- assistant/tool progress limits and live-only authority;
- context thresholds, marker, or eligibility;
- terminal JSON submission semantics;
- schema version 1, exact keys/order, `Message` shapes, canonical bytes, error codes, file/session/
  display bounds, locks, atomic persistence, rollback, list/delete, and replay behavior; causal
  validation is only additively extended for the single legal intra-turn user position, and
  `nextTurn` remains the completed-parent-turn ordinal plus one;
- corpus/eval/acceptance/sentinel behavior, legacy/basic paths, dependencies, or lockfile.

## Planned files and ownership

One implementer owns all writes.

| File/component | Planned change |
|---|---|
| `v0/agent/steering.ts` | single-use owner, validation, bound, result types |
| `v0/agent/events.ts` | additive consumed `steering_message` event |
| `v0/agent/loop.ts` | internal port and safe-boundary consumption/closure |
| `v0/agent/session.ts` | per-turn owner and synchronous session API |
| `v0/agent/session_store.ts` | additive schema-v1 causal parser and completed-parent-turn derivation; no version/key/limit change |
| `v0/agent/tui_cli.ts` | TUI session capability exposure |
| `v0/tui/controller.ts` | busy editor, admission state, cleanup |
| `v0/tui/render.ts` | editor priority and consumed-event rendering |
| `tests/v0/agent_steering_test.ts` | focused owner/loop/session/failure evidence |
| `tests/v0/agent_session_store_test.ts` | old/new v1 codec, malformed-position, nextTurn, canonical persistence, list/resume evidence |
| relevant existing session/loop/context/planner/cancellation/streaming/persistence/TUI tests | compatibility evidence |
| `tests/v0/fixtures/tui_process_fixture.ts`, `tests/v0/tui_process_test.ts` | PTY flow and settlement evidence |
| `deno.v0.json` | focused task and check/gate inclusion |
| `README.md` | public boundary and deferred queue distinction |
| `docs/plans/provider-neutral-mid-turn-steering-results.md` | acceptance evidence |
| `AGENTS.md`, `.handoff/handoff.md` | final lifecycle state |

No product change is planned for record version/keys/message shapes, store paths/locks/atomic I/O,
session management CLI/launchers, execution budgets, cancellation states, context transform,
provider adapter, runtime CLI, definitions/catalog/registries/tools, corpus/eval, acceptance,
sentinels, dependencies, or `_refs/`.

## Ordered implementation

1. Add the pure owner, validation, state transitions, and boundary tests.
2. Add the event and optional loop port without enabling existing callers.
3. Integrate safe-boundary consumption and all terminal/failure closure paths.
4. Allocate/expose one owner per `AgentSession.submit()` and integrate cancellation/detachment.
5. Extend the schema-v1 causal parser to accept one intra-turn steering user only after a complete
   nonterminal tool result, return completed parent-turn count, and validate `nextTurn` from it.
6. Prove old-v1 compatibility, new canonical steering encoding, malformed-position rejection,
   list/resume behavior, and unchanged version/keys/bounds.
7. Add transcript/context/persistence rollback and planner-isolation evidence.
8. Add TUI busy editing, admission, display priority, rendering, and cleanup.
9. Add direct terminal and bounded PTY evidence.
10. Add the focused task and exact check/gate topology.
11. Update README, results, AGENTS, and handoff evidence.
12. Run focused/full offline verification, then bounded read-only review and at most one
    plan-scoped finding-closure pass.

## Deterministic test contract

### Owner and session admission

- exact empty/pending/consumed/closed transitions and one admission per turn;
- blank, whitespace, NUL, lone-surrogate, and 65,537-byte rejection with exact errors;
- exact 65,536-byte ASCII and largest valid multibyte boundary acceptance;
- exact text preservation, mutation isolation, idle/cancelled/unavailable behavior, and fresh lane on
  a later turn.
- failed NUL admission leaves the lane open so one later valid message can be admitted;
- raw TUI NUL is ignored and NUL-containing paste is atomically rejected before it reaches a
  request, event, transcript, or persistence.

### Loop ordering and stop paths

- gated first request proves admission cannot mutate its snapshot;
- a two-call batch fully settles before one steering event and exact next-request transcript;
- steering event precedes context preparation/request claim and later progress;
- exact steps/tool/request counts, task field, and turn number;
- final, terminal, max-step, invalid model/context/budget/tool/event failure produce no unsafe extra
  request or later-turn promotion;
- event failure, cancellation before/after consumption, progress failure, cleanup poisoning, and
  retained-owner races preserve current rollback and failure precedence.

### Planner, context, and persistence

- steering during a gated child never enters child requests/events/result;
- child and complete parent batch settle before parent consumption;
- parent/child/aggregate budgets remain 8/8/16 and nonrecursion remains exact;
- admission changes no committed metrics or bytes;
- old one-turn and multi-turn schema-v1 records without steering decode/re-encode to identical
  canonical bytes;
- successful steering after a nonterminal `ToolMessage` validates with unchanged schema version/
  keys and `nextTurn === completed parent turns + 1`;
- multi-parent records with steering derive metadata count from completed parent turns, not raw user
  count;
- codec rejects steering before assistant/matching tool result, after final/terminal, consecutively,
  twice in a parent turn, or at transcript EOF;
- codec rejects raw-user-count `nextTurn` and accepts only completed-turn count plus one;
- store commit/read/list/open/resume round-trip canonical steering, and resumed submission uses the
  stored parent-turn ordinal;
- malformed positions are `session_invalid`; list skips them, exact resume fails before runtime
  materialization, and no file is rewritten;
- NUL remains rejected by direct record encoding/decoding;
- cancelled, failed, final/terminal discard, event failure, replay, and durable rollback retain exact
  canonical state and begin with no pending lane.

### TUI and process

- busy printable/multibyte/Backspace/paste/blank/boundary/overflow grammar;
- editor priority over assistant/tool progress without false scrollback;
- exact pending/applied/already/closed statuses and one escaped `steer>` record;
- hostile terminal text remains behind existing escape/display bounds;
- second input, final/terminal/max-step races, Escape/Ctrl-C/signals, failures, close/restore, no-late
  writes, committed-only context reads, and fake-session compatibility;
- PTY proves initial input, gated progress/tool completion, one steering consumption, exact
  scrollback order, next response, cancellation-before-consumption, one restore, and finite output;
- topology proves unchanged production tasks/permissions and exact focused-gate inclusion.

## Task and verification topology

Add one permission-free task:

```text
agent:steering:test =
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno test --no-prompt tests/v0/agent_steering_test.ts
```

Add the new source/test to `v0:check` and the focused task exactly once to `v0:gate`. Retain existing
PTY and disposable `/tmp` permission envelopes. Use `deno task --config deno.v0.json <task>` for
named tasks and run at least:

```text
agent:steering:test
agent:test
agent:session:test
agent:session-store:test
agent:session:process:test
agent:session:tui:test
agent:cancellation:test
agent:context:test
agent:tool-progress:test
agent:streaming:test
agent:planner-delegation:test
agent:runtime:test
agent:runtime:process:test
agent:tui:test
agent:tui:process:test
agent:tui:topology:test
agent:sessions:topology:test
agent:transport:test
agent:work-tools:test
agent:work-tools:sentinel:test
agent:planner-delegation:sentinel:test
v0:check
v0:fmt
v0:lint
v0:test
v0:gate
git diff --check
```

Do not run production, acceptance, live/canonical corpus, credential-launcher, or real-model
sentinel tasks. Do not inspect credentials or access the network.

## Acceptance package

The results document must map requirements to exact evidence for: the single bounded lane; no
in-flight mutation; complete post-tool ordering; no ordinary queue behavior; successful transcript
and persistence inclusion; cancellation/failure rollback; planner isolation; unchanged budgets;
TUI grammar/rendering; progress/stream compatibility; CLI/schema/permission compatibility; and zero
prohibited activity. It must additionally map old-v1 golden bytes plus new steering codec/store/
resume evidence; completed-parent-turn `nextTurn`/metadata identity; and direct/TUI NUL rejection
with unchanged codec rejection. Record plan hash, implementation revision, changed files/constants,
focused/full counts, review findings/fixes, deviations, residual risks, and rollback.

README must document the one-message/65,536-byte limit, busy Enter admission, safe boundary, lack of
current request/tool interruption, terminal/failure discard, consumed-only commit, absence of an
ordinary next-turn queue, unchanged cancellation controls, restored `user>` representation, and
unchanged final-only CLI/provider contracts.

After implementation, run one read-only changed-lines review for at most 30 minutes, stopping after
10 minutes without new evidence. One changed-lines re-review may run for at most 15 minutes. GO
requires Blocker/P1/P2 zero. Any behavior change outside this plan returns to a Human Gate.

## Completion, rollback, and residual risks

Completion requires every contract above, all focused/full offline gates, review GO, and zero
production/provider/credential/dependency/`_refs` activity. Schema v1 must accept exactly the new
legal intra-turn position while preserving existing v1 records, keys, limits, canonical encoding,
and errors; `nextTurn`/metadata must count completed parent turns; and NUL must not enter the lane or
TUI steering editor.

There is no schema version or data migration. Code rollback removes steering and restores the prior
narrow runtime behavior. Existing old-v1 records remain valid. A new v1 record containing committed
steering is valid canonical JSON/`Message[]` but pre-steering code would reject its causal order;
operational rollback after such records exist must retain the additive v1 causal parser as a
compatibility patch, or disable new steering writes before code rollback. It must not delete or
rewrite user session data.

Residual risks:

- steering submitted just before a final/terminal boundary may be discarded;
- the single-use bound prevents a second correction in the same turn;
- accepted text may wait for a long-running or abort-ignoring tool/planner child;
- steering cannot undo completed provider, Bash, or filesystem effects;
- the one-line editor temporarily hides live progress;
- `steer>` origin is not retained across replay;
- schema v1 has two backward-compatible causal forms, so malformed-position regressions must prevent
  arbitrary user-message placement;
- process/VM/terminal loss remains outside graceful settlement;
- offline evidence makes no real-provider steering claim.

## Stop conditions

Stop and return cause, evidence, impact, proposed plan delta, and verification if correctness requires
ordinary/cross-turn queueing, more than one message, replenishing capacity, in-flight mutation,
between-call injection, planner-child steering/events, changed request/terminal/cancellation/progress/
context contracts, pending-state persistence, provider-specific controls, RPC/extensions,
dependencies, permissions, retry/fallback/parallelism, credentials/network/production execution,
`_refs/` changes, destructive state actions, or unrelated worktree edits. Also stop if the intra-turn
position cannot be represented by an additive schema-v1 causal-parser change with unchanged version/
keys/message shapes/limits, if existing valid v1 bytes cease to decode, if `nextTurn` cannot be
derived unambiguously from completed parent turns, or if migration/rewrite is required.

## Initial Human Gate

Implementation approval authorizes only repository implementation of this plan, disposable
permission-free fake/PTY/session tests, full offline verification, README/results/AGENTS/handoff
updates, bounded read-only review, and plan-scoped finding closure.

It does not authorize production `agent:run`/`agent:tui`/`agent:sessions`, actual persistent-state
operations, credential read/probe, provider/network requests, real-provider attempts, dependencies,
lockfile, `_refs/`, sibling/shared-VM changes, commit, push, tag, publish, or release.
