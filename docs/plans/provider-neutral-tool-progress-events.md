# Provider-neutral tool progress events implementation and verification plan

## Decision summary

Concept **GO, initial Human Gate pending**.

This increment adds one execution-only, provider-neutral tool-progress path:

- progress is an accumulated textual snapshot, never a delta;
- only production `bash` emits progress in this increment;
- each accepted snapshot is strict well-formed Unicode and at most 8,192 UTF-8 bytes;
- each tool call may deliver at most 64 progress events;
- invalid, oversized, over-count, post-abort, and post-settlement callbacks are observationally
  ignored;
- progress never changes the final tool result, transcript, provider request, counters,
  persistence, or provider wire;
- the TUI displays only the latest snapshot in replaceable live state and never appends progress to
  scrollback.

Planning baseline is commit `d9da4d4d957f7aab82a6fe3c38589a7c0d4cda9b`. The prior full
offline gate passed 417 tests with final Blocker/P1/P2 zero. The only other worktree entries are
user-owned untracked `_refs/*` snapshots, which remain unchanged.

No requirement contradiction or unresolved product decision was found.

## Authority and prerequisites

The sources of truth are repository `AGENTS.md`, `.handoff/handoff.md`, `README.md`, current
`v0/agent`, `v0/tui`, `tests/v0`, `deno.v0.json`, and these completed plans:

- `docs/plans/zot-provider-neutral-multi-turn-events.md`;
- `docs/plans/zot-first-tui.md`;
- `docs/plans/provider-neutral-cancellation.md`;
- `docs/plans/provider-neutral-context-management.md`;
- `docs/plans/provider-neutral-persistent-session-history.md`.

The approved roadmap order puts tool progress events after persistent session/history and before
provider streaming, bounded mid-turn steering, and any optional next-turn queue. No CLI/TUI library
or dependency is introduced.

## Confirmed current boundary

- `v0/agent/events.ts` owns one synchronous snapshotting event sink and the completed turn,
  user/assistant, tool-call/result, and turn-end events. Sink exceptions become stable
  `EventDeliveryError`.
- `v0/agent/loop.ts` emits `tool_call` immediately before sequential dispatch and `tool_result`
  after settlement. Cancellation can leave a delivered call without a result.
- `v0/agent/execution_context.ts` separates model-request admission from tool execution control;
  tool context currently carries model execution, signal, and cancellation.
- `v0/agent/work_tools.ts` captures Bash stdout/stderr separately to 4,096 bytes each and owns its
  timeout/cancellation TERM, 250 ms grace, SIGKILL, status reap, and capture settlement.
- `v0/tui/render.ts` writes completed call/result records to main-screen scrollback and redraws one
  live editor/status line through centralized terminal escaping.
- persistent schema v1 stores only canonical committed parent transcript and identity metadata;
  events and display state are not stored or replayed.
- `agent:run` has no event output sink. Corpus/eval and sentinel flows retain their existing
  transcript/result contracts.

## Pinned comparison decisions

Pi reference is MIT-licensed commit
`a69bef789bc95abf0acee16f7b4660b70b650bb9`.

- `_refs/pi/packages/agent/src/types.ts` and `agent-loop.ts`: adopt an execute-scoped update
  callback, ignore callbacks after tool settlement, and keep progress separate from final result
  and model context.

Zot reference is MIT-licensed commit
`9b7bb6a4f36bc8c8deb2cc5796a8f557f4fb7479`.

- `_refs/zot/packages/core/tool.go`, `events.go`, and `packages/agent/tools/bash.go`: adopt a textual
  provider-neutral `tool_progress` event that is not sent to the model.

Pi/Zot code is not imported or copied. `_refs/` remains unchanged reference evidence and is not a
runtime dependency.

## Scope

In scope:

- one bounded provider-neutral `tool_progress` event;
- one execution-scoped reporting callback with exact lifetime and failure precedence;
- bounded accumulated Bash stdout/stderr observation without changing its final result;
- replaceable live-only TUI rendering and cleanup;
- permission-free fake-tool/session tests, existing bounded work-tool tests, fake-terminal/PTY
  evidence, persistence exclusion, topology and compatibility evidence;
- README/results/lifecycle updates, full offline verification, and bounded review.

Out of scope:

- provider/token/reasoning/text streaming or streamed tool arguments;
- async/multicast event queues, parallel tool execution, steering, retry, fallback, or next-turn
  queueing;
- progress persistence, replay, resume, schema migration, transcript messages, or context metrics;
- progress from `read`, `write`, `edit`, `skill`, `submit_json_result`, planner delegation, corpus,
  eval, or sentinel tools;
- tool confirmation, authorization, Bash sandboxing, or descendant-containment redesign;
- provider/profile/OpenRouter wire or credential changes;
- dependencies/lockfile, production provider/credential/network/session commands, `_refs/`, archive,
  siblings, commit, push, tag, publish, or release.

## Exact event contract

Extend `AgentEvent` with:

```ts
{
  readonly kind: 'tool_progress';
  readonly turn: number;
  readonly callId: string;
  readonly name: string;
  readonly text: string;
}
```

`text` is the tool's complete current progress snapshot. The core does not concatenate snapshots.
Correlation fields always come from the active loop call; tools cannot supply or override turn,
call ID, or tool name. Normal event snapshot isolation applies.

A progress event:

- may occur zero or more times after its matching `tool_call` delivery and before dispatch
  settlement;
- never increments `toolCallCount` or `toolResultCount`;
- is not a transcript message, result, outcome, request, context metric, persistence value, or
  provider event;
- does not require a matching progress event and does not replace the eventual completed
  `tool_result`.

## Execution callback, validation, and bounds

Add an optional execution-only callback to `ToolExecutionContext`:

```ts
type ToolProgressReporter = (snapshot: string) => void;

interface ToolExecutionContext {
  readonly modelExecution?: ModelExecutionContext;
  readonly signal?: AbortSignal;
  readonly cancellation?: TurnCancellation;
  readonly reportProgress?: ToolProgressReporter;
}
```

Use exact internal constants:

```text
MAX_TOOL_PROGRESS_TEXT_BYTES = 8_192
MAX_TOOL_PROGRESS_UPDATES_PER_CALL = 64
```

For each active call, the loop creates one closure and passes it only through that dispatch
context. It accepts a snapshot only when all are true:

- it is a string and nonempty;
- it contains well-formed Unicode with no lone surrogate;
- its UTF-8 encoding is at most 8,192 bytes;
- fewer than 64 snapshots have already been accepted;
- dispatch settlement has not been observed;
- the turn signal is not aborted;
- no earlier progress delivery failure was latched.

A callback failing any condition returns without event, exception, counter/transcript change, or
effect on the final result. The 64-event limit is per call and resets for the next call.

The settlement gate closes in the first dispatch promise settlement/finally path before the loop
interprets its result. Retained callbacks invoked after that point are ignored permanently,
including during a later call or turn.

When no event sink exists, omit `reportProgress`. This preserves one-shot `runAgent`, corpus/eval,
and sentinel behavior without an unused reporting path.

## Progress delivery failure and cancellation precedence

Progress delivery uses the existing synchronous `deliverEvent`. If the sink throws:

1. latch the first `EventDeliveryError`;
2. stop accepting further progress immediately;
3. synchronously request the existing turn cancellation owner when available so a cooperative
   running tool begins cleanup;
4. rethrow the stable error to the callback caller;
5. still await dispatch and tool-owned resource settlement;
6. after settlement, surface the latched `EventDeliveryError`;
7. emit no `tool_result`, later call, later model request, commit, or `turn_end`.

A tool swallowing the callback exception cannot erase the latch. A subsequent normal result,
ordinary tool error, or clean cancellation cannot replace it.

If cancellation/resource cleanup fails after the latch, mark the cancellation owner
`cleanup_failed` before surfacing the latched event error. The outward error remains
`EventDeliveryError`, while the session becomes unavailable under the existing poisoning contract.

An already-running effect may complete before settlement. Progress failure does not claim rollback
of Bash, filesystem, provider, or other completed effects.

## Bash production progress

Only `createBashTool` reports production progress. Other production and corpus tools emit none;
test fakes may exercise the generic callback.

Bash maintains independent strict streaming UTF-8 decoders for observed stdout and stderr:

- progress uses the largest complete-code-point prefix whose UTF-8 encoding is at most 4,000 bytes
  from each stream;
- when the next otherwise-valid scalar would cross byte 4,000, progress freezes for that stream
  before that scalar without classifying it as malformed; raw capture continues unchanged;
- existing raw 4,096-byte final captures remain unchanged;
- malformed UTF-8 or an invalid/incomplete terminal sequence disables progress only for that
  stream;
- final decoder, JSON fields, truncation flags, timeout result, exit/signal mapping, and error text
  remain unchanged.

After each meaningful decoded observation, Bash reports this accumulated snapshot:

```text
stdout:
<observed stdout prefix>
stderr:
<observed stderr prefix>
```

The two 4,000-byte prefixes plus fixed labels remain below 8,192 bytes. Snapshot order reflects
stdout/stderr observations already made; no deterministic cross-stream scheduling claim is added.
After 64 accepted updates, Bash continues capture and execution normally without more visible
progress.

On progress delivery failure, the requested turn abort enters Bash's existing unified teardown:

- TERM the direct child;
- wait the existing 250 ms grace;
- SIGKILL if still running;
- await and reap status;
- settle or cancel stdout/stderr readers;
- remove listener/timer ownership;
- only then return control to the loop.

There is no early `EventDeliveryError` return while a direct child or capture remains unsettled.
Cleanup failure poisons the session as defined above. Timeout-only and ordinary cancellation remain
unchanged. No process-group or complete descendant-containment claim is added.

## TUI live-state contract

`TuiRenderer` owns a separate nullable live progress snapshot. It never writes progress through a
newline-terminated record.

Logical live presentation is:

```text
tool~ <escaped tool name> <escaped accumulated snapshot>  [<existing status>]
```

It replaces the prompt/editor portion of the existing live line. Newlines render as `↵`; controls,
ESC, bidi controls, tabs, names, and progress text use the existing centralized terminal escaping.
Width clipping affects display only.

Lifecycle:

- `tool_call`: clear stale prior-call progress before rendering the completed `tool>` record;
- `tool_progress`: replace the live snapshot and redraw synchronously;
- `tool_result`: clear progress before rendering the completed `tool<` record;
- busy cancellation: clear progress immediately, then show the existing cancelling status;
- `turn_end`: clear progress for every outcome;
- renderer/controller failure, normal or signal shutdown, closing, and terminal restore: clear
  progress and forbid later redraw.

Completed call/result rendering remains byte-compatible apart from ordinary live-line erase/redraw
control traffic. Progress is not restored, replayed, retained in renderer-owned history, or exposed
through context status.

## Persistence, provider, and compatibility boundary

Do not change `PersistentSessionV1`, session codec, record order, size accounting, `nextTurn`,
metadata projection, management CLI, or migration policy.

Progress is absent from:

- session JSON, restored history, replay, and omission counts;
- `Message`, `LoopOutcome`, model request, context preparation/metrics, and OpenRouter body;
- request/tool counters, planner envelope, corpus reports, and sentinel evidence.

Resume after process death starts with no live progress. `agent:run` remains nonpersistent and has
no progress output. No schema migration is needed.

Must remain unchanged:

| Contract | Required result |
|---|---|
| Final tool result/transcript | Unchanged |
| Model/provider request and wire | Unchanged |
| Steps/call/result/request counters | Unchanged |
| Cancellation and cleanup poisoning | Preserved |
| Event ordering | Extended only by correlated progress between call/result |
| Event failure | Stable error; no next effect; active resource settlement first |
| Context preparation/metrics | Unchanged |
| Persistent schema/history/replay | Unchanged; progress absent |
| `agent:run` channels/permissions | Unchanged |
| TUI completed scrollback | Unchanged; progress live-only |
| Corpus/eval/sentinels | Unchanged |
| Dependencies/lockfile/`_refs/` | Unchanged |

## Planned file ownership

Product changes:

- `v0/agent/events.ts` — event variant;
- `v0/agent/execution_context.ts` — reporter type/field and bounds;
- `v0/agent/loop.ts` — per-call reporter, validation, settlement gate, failure latch/precedence;
- `v0/agent/work_tools.ts` — bounded Bash observation and teardown integration;
- `v0/tui/render.ts` — replaceable live progress state;
- `v0/tui/controller.ts` — cancellation/shutdown clearing.

Tests/config/docs:

- new `tests/v0/agent_tool_progress_test.ts`;
- focused additions to `agent_session_test.ts`, `agent_work_tools_test.ts`, `tui_render_test.ts`,
  `tui_controller_test.ts`, `tui_process_test.ts`, its existing fake fixture, and
  `tui_topology_test.ts`;
- persistence exclusion regression in `agent_session_store_test.ts`;
- `deno.v0.json`, `README.md`;
- new `docs/plans/provider-neutral-tool-progress-events-results.md` after implementation;
- owner completion updates to `AGENTS.md` and `.handoff/handoff.md`.

`session.ts`, schema/store/CLI/launchers, runtime composition, contracts, context, provider adapter,
planner delegation, registries, profile, corpus/eval, and sentinels require no product change. A
demonstrated mechanical test-only import/seam adjustment is allowed; behavioral change returns to
the stop conditions.

One implementer owns all writes. Existing user-owned `_refs/` state is preserved.

## Ordered implementation

1. Add event/callback types, exact bounds, strict validation, and direct boundary tests.
2. Add loop correlation, accepted-update count, settlement gate, failure latch, cancellation
   request, and precedence.
3. Prove fake-tool order/isolation, invalid/over-bound ignore, late suppression, cancellation, and
   sink-failure stop-before-next-effect.
4. Add Bash accumulated observation without changing final capture; prove normal, timeout,
   cancellation, sink-failure TERM/KILL/reap, and malformed-output behavior.
5. Add renderer live state and controller cleanup across result, cancellation, failure, turn end,
   closing, signals, and restore.
6. Add fake-session PTY/process and persistence/provider/runtime compatibility regressions.
7. Add the focused task once to check/gate, update README/results/lifecycle evidence, and run
   offline gates.
8. Run bounded read-only review and one bounded finding-closure pass if required.

## Required deterministic tests

### Core and fake tools

- Exact order: `tool_call`, snapshots `a`, `ab`, `abc`, `tool_result`.
- Exact correlation for two calls in one batch and two turns; a retained callback cannot leak into
  a later call or turn.
- Event snapshot mutation cannot alter later events, dispatch, result, transcript, or request.
- Empty, lone-surrogate, 8,193-byte, 65th, post-abort, and post-settlement updates emit nothing and
  do not affect the final result.
- Exact 8,192-byte and 64-update boundaries are accepted.
- Progress does not change step/call/result/request counters.
- Cancellation after one snapshot produces no later progress/result and retains cancelled
  noncommit semantics.
- A sink throwing on progress is observed synchronously, latched even if the tool catches it,
  requests cancellation once, awaits tool settlement, emits no result/later call/request/end,
  rolls back the turn, and surfaces stable `EventDeliveryError`.
- Sink failure plus cleanup failure outwardly remains `EventDeliveryError`, poisons the session,
  and makes the next submit reject with zero activity.
- Ordinary tool error/final/terminal/max-step/event behavior without progress remains unchanged.

### Bash

- Gated stdout observations produce increasing accumulated snapshots while final JSON remains exact.
- Gated stderr and combined observations retain both prefixes already observed.
- UTF-8 split across reads is decoded correctly; malformed bytes stop only that stream's progress
  and preserve final-output behavior.
- A multibyte scalar crossing the 4,000-byte cap within one read or across reads is excluded as one
  complete scalar, freezes that stream's progress without a malformed classification, and remains
  available to the unchanged raw final capture; genuinely incomplete EOF is tested separately.
- Observation caps and generic update limit are exact; excess output changes neither bound nor
  final 4,096-byte capture.
- Timeout-only final JSON is unchanged.
- User cancellation still TERM/KILLs, reaps, and settles capture.
- A TERM-ignoring child that triggers progress delivery failure is SIGKILLed and proven reaped
  before `EventDeliveryError` settles.
- Delayed status/capture gates prove no early failure settlement.
- Cleanup failure marks the session unavailable while retaining event-failure outward precedence.
- No descendant-containment assertion is added.

### TUI/direct/process

- Repeated snapshots replace one live line and add no progress newline/scrollback record.
- ANSI/OSC/C0/C1/CR/LF/tab/bidi content is escaped; 8,192-byte content is display-width bounded
  without source mutation.
- Completed `tool>`/`tool<` records remain once each and unchanged.
- Progress clears on result, cancellation, fatal cleanup, model/event/output failure, turn end,
  shutdown, SIGINT/SIGTERM/SIGHUP, renderer close, and restore.
- Cancelling/exit status is not overwritten by a late callback.
- Managed PTY fake session shows live replacement during a gated tool, then completed result and
  natural exit; cancellation/failure restores once and writes nothing after close.
- Process output and harness time are bounded; no credential, provider, network, or production task.

### Persistence/runtime/topology

- Canonical persistent bytes for otherwise identical progress/no-progress successful turns contain
  only the same canonical transcript.
- Resume/replay contains completed call/result history only and starts without progress.
- Existing `agent:run` direct/process stdout, stderr, outcome, request count, and failure wire remain
  unchanged.
- Corpus/eval/sentinel registries and reports are unchanged.
- Production task literals and permissions are unchanged.
- The focused task occurs exactly once in the gate; local gates exclude production/provider/
  credential commands.

## Task and verification topology

Add one permission-free focused task:

```text
agent:tool-progress:test =
deno test --no-prompt tests/v0/agent_tool_progress_test.ts
```

Bash coverage stays in permission-bounded `agent:work-tools:test`; PTY coverage stays in existing
TUI tasks. Add the new source/test to `v0:check` and its task exactly once to `v0:gate`.

Run at least:

```text
agent:tool-progress:test
agent:session:test
agent:session-store:test
agent:work-tools:test
agent:cancellation:test
agent:context:test
agent:planner-delegation:test
agent:runtime:test
agent:runtime:process:test
agent:tui:test
agent:tui:process:test
agent:tui:topology:test
agent:sessions:topology:test
agent:transport:test
agent:test
v0:check
v0:fmt
v0:lint
v0:test
v0:gate
git diff --check
```

Disposable process/workspace tests leave no `/tmp` fixture remnants. Do not run production
`agent:run`, `agent:tui`, `agent:sessions`, provider, credential, acceptance, corpus-live, or
sentinel commands.

## Documentation, results, and review

README documents that progress is Bash-only, accumulated, bounded, live-only, and neither
model-visible nor persistent. It also records that malformed command output can be absent from live
progress while final bounded output remains authoritative; event-output failure cancels and settles
the active tool before failure; and existing trusted-local Bash/descendant limitations remain.

The results document maps requirements to files/tests and records exact focused/full counts,
Bash/event/TUI race evidence, persistence/provider exclusions, review findings/fixes/deviations,
rollback, and prohibited activity zero.

After implementation and tests:

- one read-only review, at most 30 minutes;
- stop after 10 minutes without new evidence;
- inspect failure latching, callback lifetime, cancellation poisoning, Bash kill/reap/capture,
  TUI non-scrollback cleanup, persistence exclusion, and topology compatibility;
- if fixes are needed, one changed-lines/finding-closure re-review, at most 15 minutes;
- GO requires Blocker/P1/P2 zero; a narrow evidence-only residue may close with exact owner
  regressions and the full gate under repository lifecycle rules.

## Completion criteria

Complete only when:

- bounds, correlation, accumulated semantics, late/invalid ignore, and isolation are proven;
- progress delivery failure cannot become a tool result or escape before owned Bash cleanup;
- Bash final output, timeout, cancellation, workspace, and unsandboxed contract are unchanged;
- TUI progress is replaceable live state and clears on every settlement/exit path;
- persistence bytes and provider/runtime wires exclude progress;
- focused/full offline gates, format, lint, check, and diff check pass;
- bounded review closes at Blocker/P1/P2 zero;
- provider/network/credential/production/dependency/lockfile/`_refs` activity remains zero.

## Rollback and residual risks

There is no migration. Code rollback removes the event/callback/Bash observation/TUI live-state
slice, focused tests/task, and documentation/results updates. It does not delete or rewrite v1
session data or reset prior cancellation, context, persistence, TUI, or `_refs/` work.

Residual risks:

- high-volume Bash can reach 64 visible updates before completion;
- cross-stream observation order follows runtime scheduling;
- progress delivery failure can wait through bounded Bash teardown or another cooperative tool's
  settlement;
- completed effects and arbitrary Bash descendants are not rolled back or fully contained;
- PTY captures include redraw control bytes even though progress is not durable scrollback;
- SIGKILL/process/VM/terminal failure remains unhandleable.

## Stop conditions

Stop and return cause, evidence, impact, proposed plan delta, and verification if implementation
requires:

- provider streaming, async/multicast queues, or parallel dispatch;
- persistence/schema, provider/profile/wire, dependency, permission, or production changes;
- progress from non-Bash tools to meet acceptance;
- unsafe abandonment of Bash status/capture or changed final result/counters;
- confirmation, sandbox/descendant containment, steering, queueing, retry, or fallback;
- credential/network/provider/production execution, `_refs` changes, or unrelated dirty-state edits.

## Human Gate

Approval authorizes only:

- repository implementation of this plan;
- disposable fake/Bash/PTY tests and full offline verification;
- README/results/AGENTS/handoff updates;
- bounded read-only review and plan-scoped fixes.

It does not authorize:

- production CLI/TUI/session execution or actual session-state mutation;
- provider/network/credential access;
- dependency/lockfile/`_refs` changes;
- commit, push, tag, publish, or release.
