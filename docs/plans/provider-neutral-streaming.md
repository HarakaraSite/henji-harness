# Provider-neutral assistant streaming implementation and verification plan

## Decision summary

Concept **GO, initial Human Gate pending**.

This increment adds bounded live assistant text to the normal runtime and TUI while retaining one
authoritative completed `ModelResult`:

- normal `agent:run` and `agent:tui` OpenRouter requests use Chat Completions SSE;
- only the TUI observes live assistant text, as replaceable execution-only state;
- `agent:run` remains final-only on stdout/stderr;
- current nonstreaming fake `Model` implementations remain valid;
- partial text never enters the transcript, outcome, counters, context view, persistence, planner
  result, or final CLI output;
- streamed tool calls are fully assembled and validated before the existing loop sees or dispatches
  them;
- cancellation, malformed streams, provider errors, limits, and event-sink failures commit no
  partial assistant message;
- planner-child live activity remains private;
- request admission remains parent 8 / child 8 / aggregate 16 with one external request per
  admitted model step and no application retry or fallback.

Planning baseline is commit `ea3b506ee8a58091e7605afdca4362d42a8edc99`. The tracked worktree is
clean; existing user-owned untracked `_refs/*` snapshots remain untouched. The prior full offline
gate passed 439 tests with final Blocker/P1/P2 zero.

No requirement contradiction or unresolved user-visible choice was found. The shared `PROFILE`,
provider/model selection, completion-token bound, credential contract, production permissions, and
legacy/basic/corpus/eval/sentinel response mode remain unchanged.

## Authority and prerequisites

The sources of truth are repository `AGENTS.md`, `.handoff/handoff.md`, `README.md`, active `v0/`
source/tests/tasks, and these completed plans:

- `docs/plans/zot-provider-neutral-multi-turn-events.md`;
- `docs/plans/zot-first-tui.md`;
- `docs/plans/provider-neutral-cancellation.md`;
- `docs/plans/provider-neutral-context-management.md`;
- `docs/plans/provider-neutral-persistent-session-history.md`;
- `docs/plans/provider-neutral-tool-progress-events.md`.

`.handoff/handoff.md` record `POL-20260827-post-delegation-roadmap-order` fixes provider streaming
after those prerequisites and before steering or queueing. Source/test implementation requires a
separate initial Human Gate after this plan is reviewed.

## Confirmed current boundary

- `Model.generate` returns one completed `ModelResult`; `ModelGenerateOptions` carries the turn
  signal.
- `runAgentTurn` claims and counts one request before each `generate`, then appends and emits only
  the completed result.
- `AgentEvent` contains completed lifecycle events plus execution-only accumulated
  `tool_progress`; synchronous sink failure becomes `EventDeliveryError`.
- `OpenRouterAgentModel` performs one Chat Completions POST with `stream:false`, reads at most 1 MiB,
  decodes one bounded JSON response, propagates the per-turn signal, and performs no retry.
- `AgentSession` commits only successful completed parent transcripts and rolls back event-delivery
  failures.
- the planner child reuses the parent signal/request owner, has no event sink, and returns one
  bounded sanitized result to the parent.
- `TuiRenderer` writes completed messages and tool records to main-screen scrollback and owns one
  replaceable live tool-progress line.
- busy Escape/Ctrl-C/signals cancel and await settlement before ready/exit/restore; cleanup failure
  poisons the session.
- schema-v1 persistence stores only full successful authoritative parent transcripts.
- `agent:run`, corpus/eval, acceptance, and sentinels have no event-output channel and retain final
  result contracts.

## Official OpenRouter contract

Implementation and tests follow:

- [OpenRouter streaming documentation](https://openrouter.ai/docs/api_reference/streaming);
- [OpenRouter tool-calling documentation](https://openrouter.ai/docs/guides/features/tool-calling).

The confirmed external facts are:

- `stream:true` returns SSE, whose network chunks need not align with lines or events;
- comment frames such as `: OPENROUTER PROCESSING` may occur and are ignored;
- an SSE event may contain multiple `data:` lines joined with `\n`;
- `[DONE]` is the logical stream terminator;
- pre-stream failures remain ordinary non-2xx JSON responses;
- a top-level `error` in an HTTP-200 data event is a mid-stream failure;
- streamed tool calls arrive through `choices[0].delta.tool_calls` and require assembly;
- a final usage frame has a content-free choice and may repeat the terminal finish reason before
  `[DONE]`; it is accounting metadata, not a second completion;
- connection abort is the cancellation mechanism, but provider-side compute/billing cancellation
  is not universally guaranteed, including for the current Google provider route.

No provider body, raw error, credential, tool arguments, or partial response enters an outward
error.

## Pinned reference decisions

Zot is the MIT-licensed pinned commit
`9b7bb6a4f36bc8c8deb2cc5796a8f557f4fb7479`:

- `_refs/zot/packages/core/events.go` and `agent.go`: adopt separation of text deltas from the
  completed assistant message and execute tools only from the completed result;
- `_refs/zot/packages/agent/modes/stream.go` and `stream_test.go`: adopt live-delta/final fallback
  as comparison evidence, but do not adopt CLI stdout streaming or partial-text retention after
  abort.

Pi is the MIT-licensed pinned commit
`a69bef789bc95abf0acee16f7b4660b70b650bb9`:

- `_refs/pi/packages/agent/src/types.ts` and `agent-loop.ts`: adopt a provider-neutral live-message
  callback separated from the final result;
- `_refs/pi/packages/ai/src/api/openai-completions.ts` and `utils/event-stream.ts`: adopt tool-call
  accumulation by stream index, final parsing after completion, abort checks, and a distinct final
  result boundary.

Do not adopt partial transcript mutation, SDK dependencies, reasoning/usage UI, partial tool-call
UI, retry, queueing, parallelism, or compatibility matrices. Pi/Zot code is not imported or copied;
`_refs/` remains unchanged reference evidence.

## Scope

In scope:

- one bounded provider-neutral assistant-progress callback and event;
- one fixed SSE response mode for models materialized by the normal runtime;
- a dependency-free bounded SSE parser in the existing OpenRouter adapter;
- accumulated assistant text and completed streamed tool-call assembly;
- cancellation, timeout, event failure, malformed-data, and reader-cleanup precedence;
- replaceable live-only TUI assistant rendering;
- offline fake-stream/model/terminal/PTY, persistence-exclusion, runtime, and topology evidence;
- README, results, lifecycle updates, full offline verification, and bounded review.

Out of scope:

- CLI stdout/stderr streaming or a new flag;
- live tool-call names/arguments or execution of partial calls;
- reasoning, usage, token, price, latency, or provider-status UI;
- persistence, replay, resume, or schema changes for deltas;
- planner-child event forwarding;
- steering, next-turn queueing, parallel requests/tools, retry, fallback, resumable streams,
  reconnect, or cursor IDs;
- server tools, alternate providers/models/profiles, request-budget changes, dependencies/lockfile;
- production CLI/TUI/provider/session commands, credential reads/probes, network requests, `_refs/`
  changes, commit, push, tag, publish, or release.

## Alternatives and decisions

| Alternative | Decision | Reason |
|---|---|---|
| Replace `Model.generate` with an async iterator | Reject | Breaks fake models and broadens the core API beyond one optional execution callback. |
| Stream directly from adapter to renderer | Reject | Couples provider and TUI and bypasses event/cancellation ownership. |
| Persist partial text | Reject | Conflicts with completed-result authority and schema-v1 history. |
| Stream `agent:run` stdout | Reject | Changes the automation contract and exposes failed/cancelled partial output. |
| Enable SSE for all adapter consumers | Reject | Changes corpus/eval/acceptance/sentinel wires outside this increment. |
| Change shared `PROFILE.stream` | Reject | The profile also serves unchanged consumers. |
| Add an SSE/SDK dependency | Reject | The documented subset is bounded and deterministically testable with platform streams. |

Use an internal construction option such as `responseMode: 'json' | 'sse'`. Omitted mode remains
`'json'`. Only `v0/agent/runtime.ts` selects `'sse'` for normal default/planner models. The shared
`PROFILE` object and other products keep their current request bodies.

## Provider-neutral progress contract

Extend `ModelGenerateOptions` additively:

```ts
export type AssistantProgressReporter = (snapshot: string) => void;

export interface ModelGenerateOptions {
  readonly signal?: AbortSignal;
  readonly reportAssistantProgress?: AssistantProgressReporter;
}
```

Existing models may ignore the optional field. The callback carries the complete accumulated
visible text prefix for one active model request, not a delta. It is synchronous and execution-only.
The loop supplies it only when the turn has an event sink; sinkless CLI, child, corpus/eval, and
sentinel paths receive no reporter.

Extend `AgentEvent` with:

```ts
{
  readonly kind: 'assistant_progress';
  readonly turn: number;
  readonly text: string;
}
```

The later `assistant_message` remains the only completed assistant event. Progress is not a
`Message`, `ModelResult`, `LoopOutcome`, counter, request claim, context metric, persistence value,
or planner envelope.

Use exact bounds:

```text
MAX_ASSISTANT_PROGRESS_TEXT_BYTES = 65_536
MAX_ASSISTANT_PROGRESS_UPDATES_PER_REQUEST = 256
```

The loop accepts a snapshot only when it is nonempty, well-formed Unicode, within 65,536 UTF-8
bytes, below 256 accepted updates, pre-settlement, pre-abort, and before any latched delivery
failure. Invalid, oversized, over-count, post-abort, post-settlement, and post-failure callbacks are
ignored. Bounds reset for every admitted model request.

If delivery throws:

1. latch the first `EventDeliveryError` and reject later progress;
2. synchronously request the existing turn cancellation owner and rethrow to the callback caller;
3. await model-owned response-body cancellation and reader settlement;
4. prevent a model that catches the callback error from erasing the latch;
5. after settlement, surface the latched `EventDeliveryError` with no completed assistant/tool
   event, later request, commit, or `turn_end`.

If model cleanup also fails, mark the cancellation owner `cleanup_failed` before surfacing the
latched outward event error. The session becomes unavailable. No provider-side compute/billing
rollback is claimed.

## OpenRouter SSE mode

### Request and response selection

For `responseMode:'sse'`:

- request method, endpoint, model, messages, tools, max completion tokens, credential timing,
  redirect policy, headers, request limits, timeout, and request counting remain unchanged;
- request JSON uses `stream:true`;
- no retry, fallback, `stream_options`, usage request, or extra HTTP request is added;
- a successful response requires a body and `text/event-stream` media type, allowing parameters;
- non-2xx responses retain current sanitized HTTP error and body-settlement behavior.

### Framing and bounds

Use:

```text
MAX_RESPONSE_BYTES = 1_048_576
MAX_SSE_DATA_EVENTS = 4_096
```

Raw-byte count includes comments, fields, separators, and ignored metadata. Event count includes
every dispatched nonempty `data:` payload, including `[DONE]`. Crossing either bound cancels and
settles the reader, then returns sanitized `limit_exceeded`.

The dependency-free framer:

- uses one fatal incremental UTF-8 decoder;
- accepts arbitrary byte splitting, including multibyte scalars, CRLF, LF, CR, and separator
  boundaries;
- ignores one optional initial UTF-8 BOM;
- recognizes blank-line event boundaries and ignores comment lines beginning with `:`;
- collects only `data` fields, removes one optional leading space after `:`, and joins multiple
  values with `\n`;
- ignores standard non-data and unknown fields;
- rejects malformed UTF-8, invalid JSON data, empty dispatched data, incomplete terminal framing,
  EOF before `[DONE]`, oversized raw input, or too many data events;
- stops accepting input at `[DONE]`, settles/cancels the reader as required, and always releases its
  lock;
- maps reader acquisition/read/cancel/release failures through current transport/cleanup
  classification.

No raw SSE frame or provider error object is retained in an outward error.

Before accumulating any text or tool fragment, bind the stream to one completion and one choice:

- the first non-error JSON chunk must carry a nonblank completion `id`, and every later semantic or
  usage chunk must carry that identical `id`;
- every semantic and usage chunk must contain exactly one choice whose `index` is the safe integer
  `0`;
- reject a missing/changed completion ID, missing/multiple choices, or nonzero/invalid choice index
  before it can affect text, tool-call scratch state, terminal state, or progress.

This completion/choice ownership is distinct from tool-call `index` and prevents fragments from
different choices or completions from cross-binding into one executable call.

### Text assembly

- accept only string `choices[0].delta.content` fragments; absent, `null`, and empty string are
  no-ops;
- append fragments in order to the internal completed text and reject an explicitly non-assistant
  role;
- invoke the reporter only after a nonempty fragment changes the accumulated snapshot, so
  content-free metadata/usage frames cannot consume the live-update bound;
- report accumulated progress while its largest complete-code-point prefix remains within 65,536
  bytes;
- if the next scalar crosses the bound, report the exact bounded prefix at most once and freeze
  live reporting while continuing authoritative assembly;
- require nonempty completed text and terminal `finish_reason:'stop'`;
- return `{kind:'final', text}` only after terminal validation and `[DONE]`.

The completed text is bounded by the 1-MiB raw stream, not the live display limit.

### Tool-call assembly

- each fragment has a nonnegative safe-integer `index`; repeated fragments for the same index are
  expected and assembled together;
- assembly is keyed by index and returned in ascending contiguous index order;
- `id`, `type:'function'`, and function `name` may appear on any fragment but must be nonblank at
  completion; repeated metadata must agree;
- argument fragments are strings concatenated exactly in arrival order and parsed only at
  completion;
- conflicting ownership/metadata, missing fields, noncontiguous indices, malformed JSON, or a
  non-`JsonValue` argument fails the whole response;
- completed calls pass through the same provider-neutral final validation as the JSON path;
- require terminal `finish_reason:'tool_calls'` and return only after validation and `[DONE]`.

Tool fragments emit no live event and are not exposed to tools or transcripts before completion.
Text and tool calls are mutually exclusive across the response; a mixed response fails even after
visible text.

### Terminal, usage, error, cancellation, and cleanup

Exactly one semantic terminal result is required. A terminal frame may carry the last content/tool
delta. After it, accept at most the documented content-free usage frame whose sole choice repeats
the same finish reason. Ignore its usage and repeated finish reason. It creates no event, result,
counter, or second completion.

Reject a second semantic completion, content/tool deltas after terminal, unsupported finish reasons
including `length`, `content_filter`, or `error`, kind mismatch, or `[DONE]` before a valid result.
A top-level `error` event is sanitized `response_error`, including after visible text. No partial
result commits.

The existing timeout remains armed through fetch, SSE reads, `[DONE]`, cancellation, and reader
cleanup. Turn cancellation aborts fetch/stream, blocks later progress, cancels/releases the reader,
and returns the existing cancelled outcome only after cleanup. If the stream ignores abort, the
runtime waits for owned settlement rather than force-abandoning it.

## Loop, planner, TUI, persistence, and CLI

The loop owns one progress closure per admitted request and closes its settlement gate before
interpreting `ModelResult`. Progress changes no step/tool/result/request/admission count, context,
transcript, tool ordering, terminal rule, or `turn_end` ordering. Completed final text or completed
tool calls alone enter the existing path.

Normal planner children also use SSE, but have no child sink. Their progress stays private and the
parent receives only the existing bounded sanitized result. Parent 8 / child 8 / aggregate 16 and
one-child/nonrecursive rules remain exact.

`TuiRenderer` adds a live assistant state mutually exclusive with live tool state:

```text
assistant~ <escaped accumulated text>  [busy]
```

It uses current terminal escaping, one-line newline/tab markers, display truncation, width clipping,
main-screen behavior, and synchronous write boundary. `assistant_progress` replaces the snapshot.
A completed assistant event clears it before writing exactly one `assistant>` record. Tool calls,
tool progress/results, cancellation request, every `turn_end`, output/model/event failure, close,
signal shutdown, and restore clear all live activity. Late callbacks cannot redraw after close or
overwrite cancelling/exiting status. Tool-terminal final rendering remains unchanged.

Partial assistant text never creates scrollback, history, a session field, context metrics, or
replay state. Successful streamed and equivalent nonstreamed turns persist identical canonical
transcripts. Failed/cancelled/event-failed turns preserve prior session bytes. `agent:run` remains
final-only and other adapter consumers remain default JSON `stream:false`.

## Planned file ownership

| File/component | Planned change |
|---|---|
| `v0/agent/contracts.ts` | optional reporter type and generate option |
| `v0/agent/events.ts` | `assistant_progress` event |
| `v0/agent/loop.ts` | validation/bounds/lifetime/failure latch and result authority |
| `v0/agent/openrouter_model.ts` | JSON/SSE mode, bounded framer, text/tool assembly, cleanup |
| `v0/agent/runtime.ts` | normal parent/planner materialization in SSE mode |
| `v0/tui/render.ts` | replaceable live assistant state and unified clearing |
| `v0/tui/controller.ts` | clear live activity across cancellation/failure/exit |
| `tests/v0/agent_streaming_test.ts` | focused provider-neutral/SSE contract suite |
| existing agent/transport/runtime/session/cancellation/store/TUI tests and fixtures | compatibility, cleanup, persistence, process, and PTY evidence |
| `deno.v0.json` | focused task and check/gate inclusion |
| `README.md` | runtime SSE and live-only TUI contract |
| `docs/plans/provider-neutral-streaming-results.md` | post-implementation evidence |
| `AGENTS.md`, `.handoff/handoff.md` | owner completion/lifecycle updates |

No product change is planned for `v0/model.ts`, definitions, session/store/schema/CLI/launchers,
planner envelopes, budgets, registries/tools, context preparation, corpus/eval, acceptance,
sentinels, dependencies, or `_refs/`. One implementer owns all writes.

## Ordered implementation

1. Add optional reporter/event, exact bounds, and direct fake-model lifetime tests.
2. Add loop delivery, per-request settlement gate, sink-failure latch, cancellation request, and
   cleanup poisoning.
3. Add internal adapter response mode while proving default JSON byte compatibility.
4. Implement and directly test the bounded incremental SSE framer.
5. Add text/tool assembly, finish/usage/error validation, and sanitized results.
6. Integrate cancellation, timeout, reader cancellation/release, failure precedence, and delayed
   settlement tests.
7. Materialize only normal parent/planner models in SSE mode and convert offline fixtures.
8. Add TUI live assistant rendering and cleanup across completion, tool transition, cancellation,
   failures, signals, close, and restore.
9. Add persistence, final-only CLI/process, PTY, topology, and unchanged-consumer regressions.
10. Update README/results/lifecycle evidence and run all offline gates.
11. Run bounded review and one finding-closure pass if required.

## Required deterministic tests

Provider-neutral core:

- nonstreaming models retain exact results/events/counters;
- accumulated snapshots precede one completed message and reset per request/turn;
- exact 65,536-byte/256-update bounds, invalid/overflow/late/aborted ignore, and mutation isolation;
- retained/caught reporters cannot emit late progress or erase a latched sink failure;
- sink failure cancels once, awaits model settlement, rolls back, omits end/completed events, and
  surfaces `EventDeliveryError`;
- cleanup failure also poisons the session without replacing that outward error.

SSE framing:

- one/many events per chunk and every byte-boundary split, including UTF-8 scalars;
- CRLF/LF/CR, split separators, optional BOM, comments, multi-data joins, and ignored fields;
- exact 1,048,576-byte/4,096-data-event boundaries and one-unit overflow cleanup;
- malformed/incomplete UTF-8, invalid/empty JSON data, EOF or `[DONE]` before terminal;
- missing/changed completion ID, missing/multiple choices, or nonzero/invalid choice index fail
  before any accumulation or dispatch;
- sanitized errors exclude provider/body/credential markers.

Text and terminal handling:

- multiple deltas yield exact full final plus accumulated live snapshots;
- more than 256 empty-string deltas after initial text emit/count nothing, and later nonempty text
  remains visible within the update bound;
- empty final, wrong role, non-string content, mixed text/tools, unsupported finish, second
  completion, post-terminal delta, and top-level error fail without commit;
- largest-complete-scalar live prefix freezes at 65,536 while final assembly continues;
- stop frame, one documented usage frame, and `[DONE]` yield exactly one completion.

Tool calls:

- split single call and interleaved repeated-index fragments assemble exact ordered calls;
- escaped/multibyte argument splits parse only at completion;
- identical repeated metadata succeeds; conflicting/missing metadata, invalid index, noncontiguous
  set, malformed/non-JSON-value arguments fail closed;
- no tool event/dispatch/transcript entry occurs before `[DONE]` and full validation.
- changed completion IDs, multiple choices, and interleaved choice indices reusing tool-call index
  zero fail with zero tool event/dispatch/transcript entry.

Cancellation/resources:

- pre-fetch cancellation starts zero requests;
- cancellation after visible text suppresses later progress, commits nothing, waits for cleanup,
  then permits a fresh turn;
- timeout remains active after headers; read/cancel/release failures have exact sanitized
  classification;
- abort-ignoring stream proves no early ready/exit;
- output failure cancels and settles before restoration; cleanup failure takes fatal session
  precedence.

Runtime/TUI/persistence compatibility:

- normal runtime request uses `stream:true` with every other field unchanged;
- omitted adapter mode stays byte-equivalent `stream:false` JSON; profile/definitions/registries and
  unchanged constructors remain exact;
- final/tool/terminal/max-step/context/multi-turn and 8/8/16 planner paths retain outcomes/counters;
- child progress remains absent from parent/TUI events;
- live snapshots replace one line, escape hostile terminal text, clear on every lifecycle path, and
  produce exactly one final record;
- PTY proves at least two gated snapshots, final/cancel/failure settlement, single restore, and no
  late writes;
- `agent:run` process bytes/exits remain final-only;
- streamed/nonstreamed success persists identical canonical bytes; failure/cancel leaves prior
  bytes and replay contains no live state;
- production task permissions and command literals remain unchanged.

## Task and verification topology

Add one permission-free focused task:

```text
agent:streaming:test = deno test --no-prompt tests/v0/agent_streaming_test.ts
```

Add source/test to `v0:check` and the task exactly once to `v0:gate`. Process/PTY tests stay in their
existing permission-bounded tasks. Run the repository-pinned Deno 2.9.4 forms of at least:

```text
agent:streaming:test
agent:transport:test
agent:test
agent:session:test
agent:session-store:test
agent:cancellation:test
agent:context:test
agent:planner-delegation:test
agent:runtime:test
agent:runtime:process:test
agent:tui:test
agent:tui:process:test
agent:tui:topology:test
agent:sessions:topology:test
agent:corpus:eval:live:test
agent:work-tools:sentinel:test
agent:planner-delegation:sentinel:test
v0:check
v0:fmt
v0:lint
v0:test
v0:gate
git diff --check
```

Disposable fixtures leave no `/tmp` remnants. Do not run production `agent:run`, `agent:tui`,
`agent:sessions`, acceptance, live/canonical corpus, credential-launcher, or real-model sentinel
commands. Do not read/probe credentials or access the network.

## Documentation, results, and review

README documents normal-runtime SSE, final-only CLI, bounded accumulated replaceable TUI text,
completed-result authority, disappearance of partial text on failure/cancel, no partial tool
execution, provider-side cancellation limitations, and deferred reasoning/usage/retry/steering/
queueing.

The results document maps every contract to plan hash/baseline/revision, files/constants, framing/
text/tool/error/cancellation matrices, event/TUI/persistence/CLI/planner evidence, focused/full pass
counts, review findings/fixes/deviations, rollback/risks, and prohibited activity zero.

After implementation/tests, run one read-only review for at most 30 minutes, stopping after 10
minutes without new evidence. Review the exact diff plus plan/results under a trusted-local
single-user VM with synchronous sink, sequential requests, platform fetch/streams, and no provider
sentinel. Inspect framing boundaries, bounds, result authority, tool-delta cross-binding,
finish/usage/error handling, cancellation/reader settlement, sink failure, planner privacy, TUI
restoration, persistence exclusion, and CLI compatibility. Report Blocker/P1/P2 only.

One changed-lines/finding-closure re-review may run for at most 15 minutes. GO requires
Blocker/P1/P2 zero. A narrow evidence-only residue may close with exact owner regressions plus the
full gate; new product behavior returns to a Human Gate.

## Completion criteria

Complete only when normal parent/planner requests use bounded SSE with one request per claim;
nonstreaming/default JSON consumers remain compatible; live TUI text is bounded, escaped,
replaceable, and nonauthoritative; only completed text/tools drive events, dispatch, transcript,
context, counters, and persistence; every malformed/error/cancel/sink-failure path commits and
dispatches nothing partial; resource settlement precedes ready/exit/failure; child privacy and
8/8/16 remain exact; CLI/profile/schema/tools/permissions/retry/corpus/eval/sentinel contracts are
unchanged; all offline gates and review close at Blocker/P1/P2 zero; and prohibited activity remains
zero.

## Migration, rollback, and residual risks

There is no schema migration. Rollback removes reporter/event, SSE mode/parser, runtime mode
selection, TUI live state, focused tests/task, and documentation/results/lifecycle updates. It
restores normal-runtime JSON without rewriting session-v1 data or prior increments.

Residual risks:

- high-frequency deltas may reach 256 live updates before completion;
- a final answer may exceed the 65,536-byte live prefix within the 1-MiB raw limit;
- manual parsing intentionally implements only documented Chat Completions SSE;
- event-output failure or cancellation may wait for an abort-ignoring body to settle;
- connection abort does not guarantee provider-side compute/billing cancellation;
- PTY captures redraw control traffic although partial text is not history;
- process/VM/terminal loss remains outside graceful cleanup;
- the local gate makes no real-provider compatibility claim.

## Stop conditions

Stop and return cause, evidence, impact, proposed plan delta, and verification if implementation
requires changing shared profile/model/token/endpoint/credential/permissions/budgets; successful
2xx behavior contradicts official SSE/tool docs; correctness needs a dependency or undocumented
compatibility layer; partial text/tool arguments must become transcript/history/CLI output or
execute before completion; child progress must become public; persistence migration, retry,
fallback/reconnect, steering/queueing, parallelism, reasoning/usage UI, or server tools become
necessary; cancellation requires force-abandoning a reader; or credential/provider/network/
production execution, `_refs/` changes, or unrelated dirty-state edits are required.

## Human Gate

Approval authorizes only repository implementation of this plan, disposable offline fake-stream/
model/terminal/PTY tests, full offline verification, README/results/AGENTS/handoff updates, bounded
read-only review, and plan-scoped finding closure.

It does not authorize production `agent:run`, `agent:tui`, or `agent:sessions`; actual persistent
session mutation; credential read/probe or provider/network request; a real-provider sentinel,
retry, rerun, or diagnostic attempt; dependencies/lockfile or `_refs/` changes; commit, push, tag,
publish, or release. Any real-provider streaming sentinel requires a separate bounded plan and
explicit one-shot approval.
