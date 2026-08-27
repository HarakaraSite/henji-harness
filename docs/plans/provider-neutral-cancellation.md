# Provider-neutral cancellation implementation and verification plan

## Decision summary

Concept **GO, initial Human Gate pending**.

This increment adds one provider-neutral cancellation owner per accepted user turn. The same
`AbortSignal` reaches the parent loop, a delegated planner child, every model request, tool
dispatch, and a running tool. The TUI maps busy Escape and Ctrl-C to that core contract; it does not
own cancellation semantics.

The proposed product contract for the Human Gate is:

- busy Escape requests cancellation of the current turn, waits for cancellation settlement, and
  returns the same in-memory TUI session to `ready`;
- busy Ctrl-C or externally delivered busy SIGINT requests the same cancellation, waits for
  settlement, restores the terminal, and exits 0;
- busy SIGTERM and SIGHUP request cancellation, wait for settlement, restore the terminal, and exit
  143 and 129 respectively;
- idle Ctrl-C double-press, empty-editor Ctrl-D, idle Escape, input framing, and terminal restore
  behavior remain unchanged;
- cancellation is a distinct `cancelled` turn outcome, never a provider, tool, contract, or planner
  failure;
- a cancelled turn is not committed to the session transcript; prior committed turns remain and an
  Escape-cancelled session can accept another turn;
- effects completed before cancellation is observed are not rolled back;
- no global force-exit deadline abandons an unsettled model or tool operation. The TUI reaches
  `ready` or exits only after the active turn and owned resources settle. Cancellation is requested
  immediately, but a model, response body, filesystem operation, or process-status/capture promise
  that ignores or delays AbortSignal may delay settlement without a finite wall-clock guarantee.

No Why/What/Whether contradiction is known. The exact contract above, including busy Ctrl-C exit
behavior and the choice of cooperative settlement instead of unsafe finite-time force-abandon, is
part of the initial Human Gate. This deliberately refines the preliminary discussion's phrase
"bounded cancellation settlement": individual cleanup stages may be bounded, but safe whole-turn
settlement cannot be promised for an arbitrary asynchronous implementation that ignores abort.

Planning baseline is commit `962fa19ac5043791ec2c768c60e05fed231f2f19`, plus the existing
user-owned modified `.handoff/handoff.md` and untracked `_refs/` snapshots. The recorded baseline is
full v0 350 tests and bounded review GO with Blocker/P1/P2 zero.

## Authority and prerequisites

User-approved roadmap order:

1. provider-neutral cancellation;
2. context management;
3. persistent session/history;
4. tool progress events;
5. provider streaming;
6. bounded mid-turn steering;
7. optional next-turn queue.

The user also decided not to introduce `@std/cli`, Cliffy, or another CLI/TUI library at this
stage.

Canonical prerequisites:

- `docs/plans/zot-provider-neutral-multi-turn-events.md`, SHA-256
  `663a1bd6634e1503978d0af3f24aecc899dd3b3acd64819fbfcd416cd71bdf0e`;
- `docs/plans/zot-first-tui.md`, SHA-256
  `60ba3fef3b261c754a1b060fa76d2b62086fb4433e179bb285eee97c146f1fd8`;
- `docs/plans/bounded-planner-delegation-tool.md`, SHA-256
  `5f8da680dabc7223d6320c5129c0350ed64fe7b0f7d613a4a44a7a9f5d26570d`;
- `docs/plans/zot-local-work-tools.md`, SHA-256
  `be8fdd758ca3efe62bf1058a7a6d21c41a47cdc2ed436a87c58aaa3a38f3608e`.

## Pinned reference decisions

Pi reference is MIT-licensed commit
`a69bef789bc95abf0acee16f7b4660b70b650bb9`.

- `_refs/pi/packages/agent/src/agent.ts`: adopt active-run ownership of one AbortController and an
  idempotent abort entry point.
- `_refs/pi/packages/agent/src/agent-loop.ts` and `types.ts`: adopt propagation of the same signal
  through model and tool flow.
- `_refs/pi/packages/coding-agent/src/core/agent-session.ts`: adopt abort-and-wait-for-idle as the
  session boundary.
- `_refs/pi/packages/coding-agent/src/modes/interactive/interactive-mode.ts`: adopt Escape as UI
  wiring to core cancellation, not as UI-owned operation teardown.

Zot reference is MIT-licensed commit
`9b7bb6a4f36bc8c8deb2cc5796a8f557f4fb7479`.

- `_refs/zot/packages/core/agent.go`: adopt cancellation checks after provider/tool awaits and before
  another effect.
- `_refs/zot/packages/agent/tools/bash.go`: use as evidence that shell cancellation must explicitly
  unblock process and capture settlement; do not adopt its process-group containment claim.
- `_refs/zot/packages/agent/modes/help.go`: use the busy Escape/Ctrl-C separation as comparison
  evidence only. Henji's proposed busy Ctrl-C additionally exits after settlement.

Pi/Zot code is not imported or copied. `_refs/` remains unchanged reference evidence and is not a
runtime dependency.

## Confirmed current boundary

- `AgentSession` accepts one active turn, commits only successful `final`/`tool_terminal` outcomes,
  and rolls failed drafts back, but has no active-turn cancellation API.
- `runAgentTurn` is provider-neutral, sequentially calls the model and tools, emits synchronous
  completed events, and stops before an effect when event delivery fails.
- `ParentTurnExecutionContext` and its child view share parent 8 / child 8 / aggregate 16 request
  admission and one-child-per-turn state, but no cancellation state.
- `OpenRouterAgentModel` already combines a construction-time optional parent signal with a local
  30-second request timeout. A composition-lifetime signal is wrong for a reusable multi-turn
  session and currently maps abort to generic transport failure.
- planner delegation catches child failures and converts them to a `planner_failed` result. Without
  an explicit cancellation passthrough, the parent could make another request after child abort.
- Registry dispatch passes the request-budget context to tools. Running work tools do not receive a
  turn signal.
- Bash timeout sends TERM to the direct child, waits 250 ms, sends KILL if needed, awaits/reaps
  status, and settles size-bounded capture. It does not react to turn cancellation and does not contain
  arbitrary descendants.
- TUI busy Escape reports cancellation unavailable. Busy Ctrl-C schedules exit after ordinary turn
  completion. SIGTERM/SIGHUP restore without first settling the active turn.

## Scope

In scope:

- one cancellation owner and AbortSignal per accepted turn;
- a provider-neutral session cancel API and cancellation outcome;
- exact cancellation arbitration and completed-event behavior;
- propagation through parent/child request admission, model calls, planner delegation, Registry,
  fixed work tools, skill/submission, and Bash;
- busy Escape, Ctrl-C/SIGINT, SIGTERM, and SIGHUP TUI integration;
- deterministic fake model/fetch/tool, temporary-workspace, subprocess, TUI direct, PTY, process,
  and topology evidence;
- full offline verification, results, lifecycle updates, acceptance package, and bounded review.

Out of scope:

- context pruning/compaction, persistence/history, tool progress events, provider streaming,
  steering, and turn queueing;
- cancellation of more than one active turn, multiple planner children, detached/background work,
  retries, fallback, or recovery;
- rollback of completed filesystem, shell, provider, or planner effects;
- process-group or complete descendant containment for arbitrary Bash commands;
- per-tool confirmation, permission expansion, sandbox changes, dynamic provider/model selection;
- CLI/TUI libraries, other dependencies, or lockfiles;
- provider profile/wire changes other than carrying an internal per-call signal to the existing
  fetch;
- credential/provider/network/production execution, `_refs/` changes, archive/sibling changes,
  commit, push, tag, publish, or release.

## Per-turn cancellation owner and arbitration

Add internal `v0/agent/cancellation.ts` with a small owner around one AbortController. Final names
may follow local naming, but the contract is:

```ts
type CancelRequestResult = 'requested' | 'already_requested' | 'idle';

interface TurnCancellation {
  readonly signal: AbortSignal;
  request(): 'requested' | 'already_requested';
  trySettleNormally(): boolean;
  settleCancelled(): void;
}
```

Allowed state transitions are exactly:

```text
active -> cancel_requested -> settled
active -> settled
active/cancel_requested -> cleanup_failed
```

- `request()` synchronously aborts exactly once. Repeated calls are idempotent.
- `trySettleNormally()` wins only while active and marks the owner settled. If cancellation was
  already requested, it returns false and normal final/error/tool-terminal commit cannot occur.
- `settleCancelled()` is idempotent and finalizes the requested state.
- An accepted turn gets a fresh owner; a later turn never reuses an aborted signal.
- JavaScript run-to-completion defines the race: whichever synchronous request/settlement action
  executes first wins. No timestamp comparison is used.
- `cleanup_failed` is terminal and poisons the owning session. It cannot be converted to either
  normal or cancelled settlement.

`AgentSession` creates the owner only after blank/busy preflight passes and the turn number is
accepted. It exposes:

```ts
cancelActiveTurn(): CancelRequestResult
```

- no active or already normally settled turn returns `idle`;
- the first active request returns `requested`;
- another request for the same turn returns `already_requested`;
- the existing `submit()` promise remains the settlement handle. The TUI does not start a second
  cancellation promise or timer;
- `finally` clears the active owner only after the turn and cancellation cleanup settle.

If `CancellationCleanupError` reaches the session boundary, `AgentSession` marks itself permanently
unavailable before clearing the active owner. Every later `submit()` rejects without allocating a
turn number, emitting an event, calling a model/tool, or changing the committed transcript. The
stable internal rejection is `agent session unavailable`; the prior committed transcript remains
readable for diagnostics. This prevents reuse when an owned resource may still be unresolved. The
TUI always exits on this path, while direct session callers receive the same terminal-unavailable
contract.

The loop marks the shared owner `cleanup_failed` before attempting the terminal `turn_end` event.
In `AgentSession.finally`, poisoning is derived from that owner state, not only from the returned
outcome or thrown error. Therefore an `EventDeliveryError` that externally masks cleanup failure
cannot make the session reusable.

## Outcome, transcript, and event contract

Extend `LoopStopReason` with exact `cancelled`.

A cancelled outcome has:

- `ok: false`;
- `outcome` and `stopReason`: `cancelled`;
- no `finalText`, `terminalKind`, or generic `error`;
- accurate model-step and completed tool-call/result counters;
- a defensive draft transcript reflecting only content produced before cancellation observation.

`CancellationCleanupError` instead produces the existing `contract_failure` outcome with internal
fixed error text `cancellation cleanup failed`, accurate counters, and no commit. It emits exactly
one `turn_end` with `outcome: 'contract_failure'` when event delivery remains available. The normal
CLI sanitized error surface is unchanged; TUI maps it through existing `agent_failure` and exits 1
after restoration. Host exception text, command/path, provider data, and cleanup details are never
placed in the outcome or stderr.

The session never commits a cancelled draft. Previously committed turns remain unchanged. Tool or
filesystem effects are outside transcript rollback.

Do not add token, progress, or streaming events. Extend the existing completed event contract only
so `turn_end` accepts:

```text
{ turn, outcome: 'cancelled', committed: false }
```

- A normally delivered cancelled turn emits exactly one `turn_end`, last.
- Already delivered user/assistant/tool events remain visible.
- A `tool_call` event for an interrupted running tool may have no matching `tool_result`; no fake
  tool error/result is added to a transcript that will be rolled back. `turn_end: cancelled` is the
  terminal evidence.
- Counters retain the current completed-event definition: `toolCallCount` increments after a
  `tool_call` event is successfully delivered, and `toolResultCount` increments after its
  `tool_result` event is successfully delivered. A call cancelled after its call event but before
  dispatch therefore counts as one call and zero results.
- Preserve the current all-or-nothing batch transcript append. If cancellation is observed while a
  multi-call batch is executing, do not append a partial `ToolMessage`; the defensive draft may end
  with the assistant's complete tool-call batch. Results from earlier calls in that interrupted
  batch remain observable only through their already delivered events and counters. If the whole
  batch was appended before cancellation, its complete `ToolMessage` remains in the uncommitted
  draft. No cancelled draft is reused as provider input.
- If the event sink throws while delivering cancelled `turn_end`, the existing
  `EventDeliveryError` behavior wins and the draft remains uncommitted.
- Event snapshots and delivery-before-next-effect behavior remain unchanged.

The one-shot `runAgent` compatibility wrapper and normal `agent:run` have no new user-facing cancel
input. Optional internal cancellation plumbing must not change no-signal callers or CLI channels.

## Provider-neutral execution plumbing

Keep model request data separate from execution control:

```ts
interface ModelGenerateOptions {
  readonly signal?: AbortSignal;
}

interface Model {
  generate(request: ModelRequest, options?: ModelGenerateOptions):
    ModelResult | PromiseLike<ModelResult>;
}
```

Existing one-argument fake and production Model implementations remain compatible.

Add an internal tool execution wrapper rather than overloading request-budget ownership:

```ts
interface ToolExecutionContext {
  readonly modelExecution?: ModelExecutionContext;
  readonly signal?: AbortSignal;
}
```

`runAgentTurn` continues to use `ModelExecutionContext` for request claims and passes a
`ToolExecutionContext` to Registry dispatch. Planner delegation reads the parent budget/admission
context through `modelExecution`; all tools may observe `signal`. Existing direct Registry/Tool
callers may omit the context.

`AgentLoopOptions` accepts an optional turn cancellation owner/signal independently of request
budget state. The runtime session supplies both. The parent and planner child use distinct parent
and child budget views but the exact same AbortSignal identity.

Introduce internal `TurnCancelledError`, `CancellationCleanupError`, and
`throwIfCancelled(signal)`. `TurnCancelledError` is an acknowledgement that the interrupted
operation has settled all resources it owns. `CancellationCleanupError` means cancellation was
requested but owned cleanup failed; it is a fatal sanitized contract failure, never a successful
cancel. Cancellation checks occur:

1. after turn/user event delivery and before the first request claim;
2. before request claim and immediately before `model.generate`;
3. after generate settles and before its result is interpreted;
4. before each `tool_call` event and again after delivery but before dispatch;
5. after a running tool settles and before any tool result, next call, or next request;
6. before terminal-tool or ordinary final settlement and before session commit;
7. before max-step/ordinary failure settlement, allowing a previously requested cancellation to
   win.

After cancellation observation, do not start a new request claim, credential read, fetch, planner
admission, tool dispatch, or parent follow-up request. A request claim already made and a fetch
already started remain counted.

Registry, tools, runtime child handler, and planner delegation must not convert
`TurnCancelledError` into a normal tool error or `planner_failed` envelope. They must also preserve
`CancellationCleanupError` as fatal instead of hiding it as `cancelled`. An aborted signal alone is
not evidence that owned cleanup succeeded; each asynchronous boundary must return normally or use
the appropriate typed error after its awaited operation settles.

## OpenRouter contract

Remove composition-lifetime cancellation from model materialization. Each `generate` combines its
optional per-call turn signal with the existing local timeout controller.

- Check turn cancellation before credential resolution and fetch.
- Track timeout and turn cancellation as separate internal causes.
- If the turn signal wins, or is aborted when an abort-related fetch/body failure is classified,
  surface `TurnCancelledError` only after the fetch/body operation has actually settled. If an
  injected fetch/body implementation ignores abort, `generate` remains pending and the TUI must not
  return ready or exit early.
- If only the 30-second provider deadline fires, retain the existing sanitized
  `OpenRouterAgentError('transport_error', ...)` behavior.
- Remove the parent listener and timeout in `finally` on every path.
- A cancelled generate does not poison the model instance; the next turn uses a fresh signal.
- Endpoint, model, POST body, `stream:false`, request/response bounds, completion-token bound,
  credential source timing, status handling, and retry zero remain otherwise unchanged.

Race rule: if turn cancellation has synchronously won before adapter settlement is classified, the
turn is cancelled. If timeout/provider failure settles and normal turn settlement wins first, a
later cancel request returns idle and cannot rewrite that completed result.

## Planner delegation contract

- Validate arguments as today, then check cancellation immediately before planner admission.
- An admitted child receives the same AbortSignal object and the existing child request-budget view.
- Child materialization, model generation, read/skill/submission tools, and child loop all receive
  that signal.
- If cancellation is requested, child execution exits through cancellation; the runtime handler and
  delegation tool rethrow it instead of emitting `planner_failed`.
- A child cleanup failure remains `CancellationCleanupError` and is not rewritten as either
  `planner_failed` or clean cancellation.
- The parent loop emits cancelled `turn_end`, commits nothing, and issues no follow-up request.
- Existing invalid-input behavior, one-child admission, parent 8 / child 8 / aggregate 16 bounds,
  request/external counters, no recursion, and no retry/fallback remain unchanged.

## Fixed tool cancellation contract

Registry checks cancellation immediately before resolving/dispatching each tool. Each running tool
also receives the signal.

### Read and skill

- Check before path/content work and after awaited bounded read/snapshot retrieval.
- An OS read already in progress is allowed to settle; if cancellation won, its content is not
  returned as a model-visible tool result.
- Skill continues to use the immutable startup snapshot and does not reread the filesystem.

### Write and edit

- Check before mutation preparation, after each awaited read/write/sync boundary, and immediately
  before atomic rename.
- Cancellation observed before rename cleans the sibling temp and leaves the target unchanged.
- Failure to remove or settle an owned sibling temp during cancellation is
  `CancellationCleanupError`, not clean cancellation.
- Cancellation after rename begins may leave the completed visible change; it is not rolled back.
- Existing path, symlink, UTF-8, size, concurrency, mode, atomic-replace, and sanitized-error
  contracts remain unchanged.

### Terminal JSON submission

- Check before validation/result creation and immediately before terminal settlement.
- Cancellation that wins before terminal settlement produces a cancelled turn with no transcript
  commit, even if validation already succeeded.

### Unknown, invalid, and batched calls

- Check cancellation before constructing another error result or advancing to another call.
- Cancellation prevents undispatched calls in the same model batch from starting.
- Completed earlier side effects remain possible and are documented.

### Bash

Refactor the existing timeout cleanup into one idempotent direct-child teardown path shared by
timeout and user cancellation.

- Check before spawn. A pre-cancelled call spawns no child.
- Race child status, the existing tool timeout, and an AbortSignal notification.
- On user cancellation, send TERM to the direct child, wait the existing 250 ms grace, send KILL if
  it has not exited, always await/reap status, and settle/cancel stdout and stderr capture.
- Remove the abort listener and all timers in `finally`.
- Only after confirmed status reap and capture settlement, surface cancellation rather than a Bash
  JSON result or generic tool error.
- If kill, status reap, capture settlement, or required temp/resource cleanup fails, make a final
  best-effort cleanup attempt and surface `CancellationCleanupError`. The turn is not committed,
  the session is poisoned, the TUI does not return to `ready`, and the controller restores the
  terminal and exits 1 with the existing sanitized `agent_failure` surface. Do not claim the child
  was reaped when it was not.
- On tool timeout, retain the existing successful JSON result with `timedOut:true` and existing
  signal/status fields.
- If timeout cleanup started before turn cancellation, use the same teardown state and do not send
  duplicate TERM/KILL or await status twice; cancellation still wins the turn if requested before
  normal tool/turn settlement.
- Do not claim process-group or descendant containment. Background descendants may survive exactly
  as under the current trusted-local boundary.

The TUI never declares cancellation settled until Bash teardown, status reap, and capture
settlement have completed. There is no global UI timer that can abandon this cleanup.

## TUI behavior and terminal lifecycle

Extend the internal session port used by `TuiController` and the TUI factory result with
`cancelActiveTurn()`.

Busy Escape:

1. request cancellation once;
2. set status `cancelling`;
3. continue consuming/discarding non-control busy input;
4. await the existing active submit promise;
5. on `cancelled`, return to idle with an empty editor and `ready` status;
6. accept a later submit in the same session.

If the active promise instead reports `CancellationCleanupError`/fatal contract failure, Escape
does not make the session reusable: close rendering, restore the terminal, and exit 1 through the
existing sanitized failure path.

Busy Ctrl-C or SIGINT:

1. request or reuse the active cancellation;
2. promote state to cancel-and-exit and show `cancelling; exiting`;
3. await the same active submit promise and resource cleanup;
4. close rendering, restore terminal state, drain input, and exit 0.

Busy SIGTERM/SIGHUP use the same path but preserve exit 143/129. Idle SIGTERM/SIGHUP preserve the
existing immediate restore path.

Exit precedence is exact: a clean cancellation requested by busy SIGTERM/SIGHUP exits 143/129, but
a `CancellationCleanupError` is a fatal controller failure and exits 1 even when SIGTERM/SIGHUP
initiated cancellation. It still restores once and emits only the existing sanitized
`agent_failure` line; cleanup details are not exposed. Thus signal exit codes describe confirmed
clean settlement, not an unverified cleanup state.

Repeated Escape/Ctrl-C/signals create no additional controller, event, teardown, or restore.
Ctrl-C after Escape may promote cancel-and-return to cancel-and-exit. If ordinary turn settlement
already won, `cancelActiveTurn()` returns idle: the completed result is rendered normally, after
which Ctrl-C exits and Escape returns ready.

Pending exit intent is monotonic and has exact precedence:

```text
cancel-and-return < clean-exit-0 < first nonzero signal exit
```

Thus Escape followed by Ctrl-C promotes to exit 0; Escape or Ctrl-C followed by SIGTERM/SIGHUP
promotes to that signal's 143/129; and once the first nonzero signal is recorded, later SIGTERM,
SIGHUP, SIGINT, Ctrl-C, or Escape cannot replace it. Repetition still requests cancellation and
restores at most once. Fatal cleanup failure overrides every pending intent and exits 1 as specified
above.

Busy printable input, paste, Enter, Backspace, and Ctrl-D remain consumed/discarded; queueing is not
introduced. The input decoder and terminal adapter do not change unless a mechanical test seam is
required.

The renderer's existing closing gate and idempotent lifecycle restore remain authoritative. Normal
cancellation does not close the renderer until the active promise settles. Uncaught-error and
unhandled-rejection restoration remains last-resort best effort; SIGKILL, process death, and VM
failure remain unhandleable.

## Race and idempotence matrix

- cancel vs model final: normal settlement first commits; cancel request first discards the result
  and returns cancelled.
- cancel vs terminal tool: terminal settlement is not committed when cancellation already won.
- cancel vs tool call event: cancellation after the event but before dispatch starts no tool;
  cancellation during dispatch waits for tool cleanup and emits no fake result.
- cancel vs completed side effect: filesystem rename, command effect, provider request, or child
  request already completed is retained; only transcript commit is prevented.
- cancel vs planner failure: cancellation wins and is not converted into a planner envelope.
- cancel vs provider/Bash timeout: the resource cleanup path runs once; cancellation wins the turn
  only if requested before normal turn settlement.
- cancel vs event delivery failure: a thrown event sink remains an event-delivery failure; neither
  path commits the draft.
- cancel vs cleanup failure: the draft remains uncommitted, but fatal cleanup failure wins over a
  clean `cancelled` outcome, poisons the session, and the TUI exits 1 after restore, including when
  SIGTERM/SIGHUP initiated cancellation.
- repeated cancellation: one signal, one teardown, one cancelled turn end, and one terminal restore.
- late events during crash shutdown: the closing gate rejects further dynamic rendering; no second
  restore occurs.

## Compatibility requirements

- `agent:run` argv/stdin grammar, TTY rejection, stdout/stderr bytes, failure JSON, and exit codes
  remain unchanged for every existing no-cancel invocation.
- `agent:tui` and `--agent` grammar, production task literals, permission flags, Definition
  selection, system instruction, skills, registry contents, and request limits remain unchanged.
- Existing event order and payloads remain unchanged for non-cancelled turns.
- Parent/child request admission, one-child-per-turn, parent 8 / child 8 / aggregate 16, counted
  fetch behavior, retry/fallback zero, and terminal JSON semantics remain unchanged.
- Corpus/eval, fixed sentinels, acceptance tasks, legacy/basic paths, dependency/lockfile state, and
  `_refs/` remain unchanged.

## Planned file ownership

Add:

- `v0/agent/cancellation.ts`;
- `tests/v0/agent_cancellation_test.ts`;
- `docs/plans/provider-neutral-cancellation-results.md` after implementation.

Expected product changes:

- `v0/agent/contracts.ts`, `events.ts`, `execution_context.ts`, `loop.ts`, `session.ts`;
- `v0/agent/runtime.ts`, `openrouter_model.ts`;
- `v0/agent/tools.ts`, `planner_delegation.ts`, `work_tools.ts`;
- `v0/agent/tui_cli.ts`, `v0/tui/controller.ts`, `v0/tui/render.ts`;
- focused existing tests and required fake process/PTY fixtures;
- `deno.v0.json`, `README.md`;
- owner completion updates to `AGENTS.md` and `.handoff/handoff.md`.

`runtime_cli.ts` may receive only a mechanical exhaustiveness adjustment for the new outcome. The
terminal/input adapters, skill/registry modules, Definitions, corpus/eval, and sentinels change only
if an unavoidable local type seam is demonstrated; their behavior must not expand.

One implementer owns all repository writes. Existing modified handoff and untracked `_refs/` are
preserved. No other user-owned changes are reformatted or reverted.

## Ordered implementation

1. Add the cancellation owner, cancellation error/check helper, `cancelled` outcome, and optional
   per-call Model/Tool execution control while preserving no-signal callers.
2. Add loop effect-boundary checks, cancelled finish, event emission, counters, and settlement
   arbitration without changing ordinary loop behavior.
3. Add the session's fresh per-turn owner and idempotent `cancelActiveTurn()`, then prove noncommit
   and same-session reuse.
4. Convert OpenRouter from construction-time parent signal to per-generate signal and separate
   timeout from cancellation classification.
5. Thread the exact signal through runtime composition, parent and child request contexts, and
   planner delegation; prevent abort-to-envelope conversion and parent continuation.
6. Add cancellation checks to fixed tools and atomic mutation boundaries. Refactor and prove Bash
   TERM/KILL/reap/capture cleanup before broader TUI wiring.
7. Wire TUI Escape, Ctrl-C/SIGINT, SIGTERM, and SIGHUP to the session contract while preserving
   terminal lifecycle and busy input discard.
8. Add permission-free focused tests, fake fetch/model/tool coverage, temporary Bash coverage,
   TUI direct/PTY/process regressions, and topology assertions.
9. Add the focused task to check/gate exactly once and update README/results/lifecycle evidence.
10. Run repository-defined verification and bounded review.

## Required deterministic tests

Core/session:

- cancel while a model promise is pending: exact cancelled turn end, commit false, next request 0;
- prior success, cancelled turn, later success: only prior committed transcript enters the later
  request and session is reusable;
- cancel before first claim, after claim, after model settlement, before tool dispatch, during tool,
  between calls, and before terminal settlement;
- normal-wins and cancel-wins sides of final, terminal, max-step, and failure races;
- repeated cancellation and idle cancellation do not change counters, turns, events, or transcript;
- cancellation after a delivered call event but before dispatch yields calls/results `1/0`; during
  a later call in a multi-call batch, completed event counters include earlier calls/results but no
  partial batch `ToolMessage` is appended to the defensive draft; cancellation after full batch
  append retains that complete batch only in the uncommitted draft;
- cleanup failure poisons the session; a later submit rejects with `agent session unavailable` and
  causes no new turn/event/model/tool/transcript activity;
- event-sink failure during cancellation remains noncommit and stops further effects;
- cleanup failure followed by a throwing `turn_end` sink surfaces the event-delivery failure but
  still poisons the session from owner state; every later submit is rejected with zero activity;
- no-cancel event ordering and one-shot outcomes remain byte/structure compatible.

OpenRouter:

- cancellation before credential source gives request/fetch 0;
- cancellation during fetch and size-bounded body read aborts once and exposes no provider details;
- abort-ignoring gated fetch and body-reader seams prove that the model/turn and TUI do not settle
  before the gate is released; release then yields exactly one cancelled settlement;
- timeout-only remains transport failure, plus both orderings of timeout/cancel race;
- listeners/timers are removed and the same model succeeds on a later fresh-signal generate;
- request wire body, headers, endpoint, model, stream flag, and limits remain unchanged.

Planner:

- exact AbortSignal identity across parent and child;
- cancellation before admission constructs no child;
- cancellation in child model and child tool is not `planner_failed`;
- parent follow-up request 0 after child cancellation;
- request counts, external counts, one-child admission, and 8/8/16 limits remain exact.

Tools:

- a multi-call batch starts no call after cancellation;
- read/skill suppress content after cancellation;
- write/edit pre-rename cancellation removes temp and leaves target unchanged;
- injected temp-cleanup failure produces fatal fixed cleanup failure and never `ready`;
- the post-rename race documents a retained side effect with transcript rollback;
- terminal submission loses to prior cancellation;
- Bash TERM-responsive and TERM-ignoring/KILL cases both await/reap the direct child and settle
  capture; delayed status/capture gates prove no early cancelled/ready/restore; cleanup failure is
  fatal; timeout behavior remains unchanged; descendants are not asserted.

TUI/process:

- busy Escape shows cancelling, receives cancelled, returns ready, then completes another submit;
- busy Ctrl-C and external SIGINT cancel, restore once, and exit 0;
- busy SIGTERM/SIGHUP cancel, restore once, and exit 143/129;
- cleanup failure after Escape/Ctrl-C/SIGINT/SIGTERM/SIGHUP restores once, emits the sanitized
  failure surface, exits 1, and never exposes a reusable session;
- abort-ignoring gated model/tool/session cases prove Escape, Ctrl-C, SIGTERM, and SIGHUP do not
  return ready, restore, or exit before active settlement;
- repeated Escape/Ctrl-C promotes at most once and produces one restore;
- direct state-machine cases cover Ctrl-C then SIGTERM, SIGTERM then SIGHUP, SIGHUP then SIGTERM,
  and Escape then SIGTERM, proving monotonic exit intent, one cancellation, and one restore;
- busy non-control input remains discarded; idle key behavior remains exact;
- no late dynamic writes after closing; raw mode, paste mode, cursor, SGR, stdin drain, and process
  natural exit remain verified;
- managed PTY fixtures use only fake sessions/providers and no credential/network;
- topology proves production task literals/permissions unchanged and all provider/credential tasks
  excluded from local gates.

## Verification commands

Use the exact repository-pinned Deno 2.9.4 command paths recorded in `deno.v0.json`. Add one focused
permission-free task named `agent:cancellation:test`, then run at least:

```text
agent:cancellation:test
agent:session:test
agent:test
agent:transport:test
agent:planner-delegation:test
agent:runtime:test
agent:runtime:process:test
agent:work-tools:test
agent:tui:test
agent:tui:process:test
agent:tui:topology:test
v0:check
v0:fmt
v0:lint
v0:test
v0:gate
git diff --check
```

The focused task appears exactly once in the full gate. Do not execute production `agent:run`,
`agent:tui`, acceptance/sentinel/canonical/credential launcher tasks, a credential probe/read, a
provider/network operation, or anything under `_refs/`.

## Results, review, and completion

The results document maps every contract to evidence and records:

- canonical plan path/hash and baseline/implementation revision;
- exact changed files and outcome/event/API contracts;
- signal identity and model/planner/tool/Bash/TUI race matrices;
- focused/full commands and pass counts;
- review findings, fixes, deviation, rollback, and remaining risks;
- provider, credential, network, production, dependency/lockfile, and `_refs/` activity zero.

After implementation and tests, run one read-only review, at most 30 minutes and stopping after 10
minutes without new evidence. Review cancellation arbitration, parent/child propagation, timeout
separation, pre-dispatch checks, Bash reap, transcript noncommit, TUI settlement/restore, and
permission/CLI compatibility. If fixes are required, use at most one changed-lines/finding-closure
re-review of 15 minutes. GO requires Blocker/P1/P2 zero.

Completion requires:

- Escape cancellation followed by a successful next turn in the same session;
- busy Ctrl-C/SIGINT and SIGTERM/SIGHUP settlement and restore contracts;
- identical per-turn signal observation by parent, child, model, and running tools;
- no conversion of cancellation to generic failure or planner envelope;
- cancelled transcript noncommit with accurate retained counters;
- Bash direct-child TERM/KILL/reap and capture settlement evidence;
- full offline gate and diff check green;
- no provider/network/credential/production command.

## Migration, rollback, and remaining risks

There is no persistent data or schema migration. Rollback removes only this increment's
cancellation owner, signal threading, outcome/event/TUI deltas, focused tests/tasks, and
documentation/results/lifecycle updates. It must not reset prior multi-turn, TUI, Definition,
delegation, work-tool work, modified handoff, or untracked references.

Remaining risks:

- completed filesystem, Bash, provider, and planner effects cannot be undone;
- arbitrary Bash background descendants may survive direct-child cleanup;
- Deno filesystem operations are not AbortSignal-aware and may delay cancellation settlement;
- SIGKILL, process/VM failure, and terminal-emulator failure cannot be handled;
- cancellation provides completed status only; progress, streaming, and steering remain later
  increments.

## Stop conditions

Stop implementation and return cause, evidence, impact, proposed plan delta, and verification if:

- a cancelled turn would require partial transcript commit, another parent request, or conversion
  to a planner/tool/provider failure;
- Bash direct-child teardown/reap/capture settlement cannot be demonstrated without abandoning an
  active resource;
- timeout and turn cancellation cannot remain distinguishable internally;
- safe Escape reuse or terminal restore cannot be demonstrated;
- request admission, one-child, 8/8/16 bounds, retry/fallback, CLI channels, production permissions,
  provider profile, or corpus/eval behavior must change;
- a dependency/library, credential/provider execution, descendant containment, streaming, queueing,
  persistence, or context management becomes necessary;
- user-owned dirty state cannot be preserved.

This plan authorizes no implementation until the user approves this initial Human Gate.
