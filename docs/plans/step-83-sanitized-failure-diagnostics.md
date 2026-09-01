# Step 83 sanitized failure diagnostics

Status: **Human Gate 2 pending; implementation not authorized**

Planning source: `/tmp/planner-inputs/henji-step-83-sanitized-failure-diagnostics.md`, SHA-256
`d8e18cf34da80a3f65cb35ab0c5e5b5b0b1e25cd65d4a4bdae78811c72a70d58`, concept revision 41.
Target HEAD: `1de39df6329a6180489687de723dc07160f181f3`.

## 1. Outcome and boundaries

Before any provider retry, add one bounded, allowlist-only failure diagnostic that survives the
failed turn, empty-session cleanup, normal TUI exit, and process restart. The exact same immutable
record is rendered in the production retained UI, written atomically outside the repository, and
returned by a read-only production command.

Keep all existing Step 83R behavior: the three-band retained UI, presentation boundary, full default
registry, failed-turn noncommit, successful-turn transcript/session schema, empty-session cleanup,
cancellation settlement, terminal restoration, context, streaming, steering, follow-up, and
planner delegation. Do not infer the cause of the consumed Turn 1 and do not run a provider retry.

The only actual secret in this acceptance is the host-provided OpenRouter API credential value. The
runtime may read it for Authorization, but diagnostic code must never accept the value, header,
credential path, raw request/response, arbitrary error text, model/tool/session content, or stack.
Hypothetical future private data is a reason not to retain raw payloads; it is not a reason to hide
fixed safe fields.

## 2. Current loss path

```text
credential file / request encoding / fetch / HTTP / SSE parser
  │ OpenRouterAgentError(code, requestCount, status, fixed internal message)
  ▼
loop catch
  │ keeps only arbitrary `error` text under umbrella `contract_failure`
  ▼
LoopOutcome → presentation adapter → controller/state
  │ TUI renders only `agent failure`; turn_end has no diagnostic
  ▼
failed turn noncommit → empty session removed on clean exit
  └─ no safe cause, request count, status, parser reason, or post-exit readback
```

The runtime fetch wrapper already counts actual calls to `fetch`; the provider adapter already owns
safe code, per-call request count, and optional status. The increment must preserve and correlate
these facts instead of reconstructing them in the TUI or persistence layer.

## 3. Authoritative schema v1

Add `v0/agent/failure_diagnostic.ts`. It is a pure provider-neutral module with no filesystem,
terminal, environment, or provider imports.

```ts
interface FailureDiagnosticV1 {
  readonly schemaVersion: 1;
  readonly diagnosticId: string; // lowercase UUID v4
  readonly stage: FailureStage;
  readonly code: FailureCode;
  readonly lane: 'parent' | 'planner';
  readonly providerRequestCount: number;
  readonly httpStatus?: number;
  readonly parseReason?: ParseReason;
  readonly occurredAt: string; // canonical UTC YYYY-MM-DDTHH:mm:ss.sssZ
  readonly turnNumber: number;
  readonly modelStep: number;
  readonly retryCount: 0;
}
```

Bounds are exact: `providerRequestCount` 0..16, `turnNumber` 1..`Number.MAX_SAFE_INTEGER`,
`modelStep` 0..8,
`httpStatus` 100..599, one 36-byte UUID, and one 24-byte timestamp. The canonical compact JSON plus
LF must be at most 1,024 UTF-8 bytes. Objects are exact-key, deeply frozen, defensively copied, and
validated before use or persistence. No general metadata/details/message field exists.

`FailureStage` is:

- `credential_resolution`
- `request_build`
- `request_admission`
- `transport`
- `http`
- `response_parse`
- `model_result_validation`
- `session_commit`
- `cancellation_cleanup`
- `unknown_stage`

`FailureCode` is:

- `missing_credential`
- `invalid_input`
- `request_budget_exhausted`
- `transport_error`
- `http_error`
- `response_error`
- `limit_exceeded`
- `invalid_model_result`
- `commit_error`
- `cleanup_error`
- `unknown_code`

`ParseReason` is the finite projection of every production response refusal:

- `unsupported_media_type`
- `response_body_missing`
- `response_body_too_large`
- `response_stream_failed`
- `invalid_utf8`
- `invalid_sse_framing`
- `invalid_sse_json`
- `provider_reported_error`
- `invalid_completion_identity`
- `unsupported_choice_shape`
- `unsupported_finish_reason`
- `unsupported_delta_shape`
- `mixed_text_and_tool_calls`
- `invalid_tool_arguments`
- `incomplete_tool_call`
- `invalid_usage_frame`
- `data_after_terminal`
- `empty_terminal_result`
- `stream_ended_before_done`
- `unsupported_response_shape`

No parser throw site may fall back to its message. Each site maps to exactly one enum and tests
snapshot the source-to-reason inventory. `unknown_stage`/`unknown_code` are permitted only for a
genuinely untyped third-party/test Model failure; their fixed reason is `not_instrumented` in the
human formatter. A production OpenRouter failure reaching either unknown value is a Product P1.

Conditional invariants:

| Stage | Allowed code | Requests | HTTP | Parse reason |
|---|---|---:|---|---|
| credential_resolution | missing_credential | 0 | absent | absent |
| request_build | invalid_input / limit_exceeded | 0 | absent | absent |
| request_admission | request_budget_exhausted | prior exact total | absent | absent |
| transport | transport_error | 1..16 | absent | absent |
| http | http_error | 1..16 | required | absent |
| response_parse | response_error / limit_exceeded | 1..16 | required | required |
| model_result_validation | invalid_model_result | exact observed total | absent | absent |
| session_commit | commit_error | exact turn total | absent | absent |
| cancellation_cleanup | cleanup_error | exact turn total | absent | absent |
| unknown_stage | unknown_code | exact observed total | absent | absent |

The response parser receives a successful HTTP response, so response-parse records retain its
bounded status, normally 200. The turn bound matches every positive safe integer accepted by the
current session contract; this increment introduces no lower turn limit. `modelStep` is the failing
lane's one-based generate step; it is 0 only for request build/admission, commit, cleanup, or a
genuinely uninstrumented pre-generate failure.

## 4. Creation and request accounting

Use one turn-local `FailureDiagnosticOwner`, created by `AgentSession` with injected clock and UUID
factory. It owns the accepted parent turn, the shared parent/planner request counter snapshot, and at
most one record per concrete failure. Parent and admitted planner child receive restricted views;
neither provider, TUI, nor store may mint or modify a final record.

`providerRequestCount` is the exact aggregate number of fetch calls from parent-turn admission
through the recorded failure, inclusive. It is not the later settlement total. If a planner child
fails after two earlier fetches and the parent subsequently makes another request, the immutable
child record retains 3. `lane` and `modelStep` identify the failing lane and its generate step. This
occurrence-bound definition allows the record to be created once and never rewritten.

`OpenRouterAgentError` gains only a typed `failureFact` containing stage, code, its actual fetch
delta, optional status, and optional parse reason. `openrouter_model.ts` increments the request fact
at the exact boundary immediately before calling the fetcher. Encoding, bounds, credential
resolution, and request admission remain count 0. Once fetch is invoked, transport, HTTP, body, and
parse failures count 1 for that generate call.

The existing runtime fetch wrapper remains the authoritative aggregate external-request counter.
The turn owner snapshots it before admission and at every failure occurrence; the final record uses
the exact delta, not request budget claims. Planner child uses the same owner and `lane=planner`, so
a child provider failure is captured even if the parent later returns a final. The first failure
remains the primary record for the turn; any second failure is rejected as a bounded diagnostic
collision and makes the turn non-evaluable rather than overwriting evidence.

Replace every existing `contractFailure(...)` construction with an explicit typed fact. Keep
`LoopOutcome.stopReason = contract_failure` for compatibility, but add optional
`diagnostic?: FailureDiagnosticV1`. The arbitrary `error?: string` remains internal compatibility
data and is never rendered or persisted by the diagnostic path. The owner finalizes ID/time/
turn/step/count once; runtime, `LoopOutcome`, presentation, TUI, store, and CLI pass the same frozen
value without rebuilding it.

The owner finalizes, atomically persists, and publishes a planner-child failure before delegation
returns its failure envelope to the parent. A parent failure is persisted before its outcome is
returned. Owned persistence settlement is awaited on both `AgentSession.submit()` resolve and reject
paths and again before close releases lifecycle ownership. Thus `child failure → parent final`,
`child failure → later parent exception`, `child failure → cancellation`, and process close retain
the same record. A successful parent creates no record only when its turn owner observed no child or
parent failure; a later parent final never erases an actual child failure.

For session commit failure, the owner records `session_commit/commit_error` after a successful model
result and before returning the uncommitted failure. A model that returns a non-`ModelResult` value
records `model_result_validation/invalid_model_result`, not unknown. Cancellation-cleanup failure is
distinct from a normal `cancelled` outcome. Normal cancellation and a turn with no failure create no
failure record.

## 5. Durable store independent of sessions

Add `v0/agent/failure_diagnostic_store.ts`. Reuse only the proven workspace digest, directory
validation, exclusive lock, canonical JSON, and atomic temp/fsync/rename patterns from the session
store; do not put diagnostics in the session schema or transcript.

```text
<state-root>/<workspace-sha256>/
  diagnostics/
    <diagnostic-uuid>.json       # canonical v1, regular 0600
  locks/
    .diagnostics.lock            # regular 0600, nonblocking OS lock
```

The namespace and directories are regular non-symlink 0700 owned state. Diagnostics are regular
non-symlink 0600. Before write, acquire `.diagnostics.lock`, validate the entire bounded namespace,
write one `.tmp-<uuid>` in `diagnostics/`, sync, chmod, atomic rename, sync the directory where the
platform seam supports it, then release. A failed write never publishes a partial record and never
removes an older valid record.

Retention is a strict capacity of 16 records and 16 KiB canonical data per workspace. There is no
automatic eviction: a seventeenth record fails closed with fixed `diagnostic_capacity` so a failure
path cannot silently erase earlier evidence. At most one temp is accepted for crash recovery; any
unknown entry, symlink, wrong type/mode/owner, oversize file, invalid JSON, noncanonical bytes,
duplicate ID, or invalid record returns a fixed store error and no partial listing.

Persistence happens before `AgentSession.submit()` resolves and before the controller presents the
recoverable ready state. If persistence fails, the live UI retains the same in-memory record plus
fixed `durable=failed` and the store error code; the outcome is not Human-Gate-evaluable. It must not
fall back to generic `contract_failure` or claim durable evidence. Failed-turn noncommit and empty
session cleanup continue independently and never delete `diagnostics/`.

Persistent and `--no-session` production TUI both use the diagnostic state root. `--no-session`
continues to create no session/context/lock record; it gains only failure-triggered bounded
diagnostic state. Startup, F1, navigation, success, and cancellation perform diagnostic writes 0.

## 6. Production readback and cleanup

Add `v0/agent/failure_diagnostic_cli.ts` and
`v0/agent/failure_diagnostic_cli_launcher.sh`. Extend the installed machine launcher with the exact
subcommand prefix `henji diagnostics`; all existing TUI argv remain byte-for-byte forwarded to the
session launcher.

Read-only commands:

```text
henji diagnostics list
henji diagnostics show --id <UUID>
henji diagnostics latest
```

They resolve the caller's physical workspace, read only its diagnostic namespace, never initialize
runtime/session/provider/credential/tools, and emit canonical JSON. `latest` sorts validated
records by `occurredAt`, then UUID. `show` requires an exact listed UUID. The read launcher receives
only repo/workspace/state read plus the state-root environment permission; it has no net, run,
credential, workspace-write, or state-write permission.

Cleanup is deliberately separate and write-authorized:

```text
henji diagnostics delete --id <UUID> --yes
```

The machine wrapper sends only this exact form to a separate write-enabled delete launcher. Before
Deno startup the shell resolves the physical workspace, state root, workspace digest, selected
record path, and fixed diagnostic lock path. The child receives read access to repo source, the
workspace correlation inputs, the exact diagnostics directory, selected record, and lock. Its write
permission is limited to the selected `<UUID>.json` and `.diagnostics.lock`; it receives no write
permission for the workspace namespace root, `sessions/`, `contexts/`, a sibling diagnostic, or any
other workspace. To keep that tuple exact, delete leaves empty 0700 diagnostic/lock directories in
place. It acquires the same lock and removes exactly one validated record. Process and topology tests
snapshot the argv and prove writes to sessions, contexts, sibling records, and other namespaces are
denied. No cleanup is part of a failure path or implementation Human Gate.

## 7. Live retained-UI presentation

Add the exact diagnostic to `PresentationOutcome` and one `failure_diagnostic` presentation event;
the presentation contract remains data-only and accepts only the fixed enums/numbers/UUID/time.
The adapter validates and freezes it and never forwards `LoopOutcome.error`.

After durable settlement, append one non-live retained log entry:

```text
failure> id=<UUID> · stage=response_parse · code=response_error · lane=parent · requests=1 ·
http=200 · reason=invalid_sse_json · turn=1 · step=1 · retry=0 · durable=yes
```

Only applicable fields are printed. The formatter is pure, finite, single-line before existing
layout wrapping, and bounded by the schema. The entry remains in scrollback until ordinary bounded
log retention removes it; status/footer may still say recoverable but are not the sole evidence.
The next redraw, editor recovery, F1, resize, Ctrl-D confirmation, and terminal restore do not erase
the entry. The UI also prints the fixed readback command using the same UUID without a path.

The controller does not create, reinterpret, or persist diagnostics. The AgentSession/runtime owner
persists first, emits the diagnostic event, and then completes the outcome. Existing pending-input
recovery and no-automatic-retry behavior remain unchanged.

## 8. Files and dirty-tree ownership

| File/area | Plan |
|---|---|
| new `v0/agent/failure_diagnostic.ts` | schema, validator, builder, formatter-safe projection |
| `v0/agent/openrouter_model.ts` | typed stage/code/status/parse reason at every refusal; exact fetch boundary |
| `v0/agent/contracts.ts`, `loop.ts`, `execution_context.ts` | typed fact/record propagation and explicit contract-failure inventory |
| `v0/agent/runtime.ts`, `planner_delegation.ts`, `session.ts` | shared parent/planner owner, aggregate count, persistence-before-return |
| new `v0/agent/failure_diagnostic_store.ts` | workspace-partitioned bounded atomic store |
| new diagnostic CLI and launcher; machine/session launchers | readback/delete dispatch and least permissions, including no-session diagnostics |
| `v0/presentation/contract.ts`, adapter | exact data-only diagnostic/event projection |
| `v0/tui/state.ts`, `render.ts`, `controller.ts` | retained failure entry and durable status; no provider/store imports |
| `v0/tui/layout.ts` | keep current row-aware F1 change; change only if a proven diagnostic bound requires it |
| `deno.v0.json`, topology/inventory tests | focused tasks and exact permission/import graph |
| README, Step 83 gate/results, lifecycle | commands, non-evaluable prior run, readiness evidence |

Preserve all current dirty changes. In particular, do not overwrite the row-aware F1 work in
`v0/tui/layout.ts`/`render.ts`, its tests, the machine-launcher evidence, or the acceptance/
overprotection records. The diagnostics implementation may add non-overlapping render behavior and
extend the existing launcher test. Never read or change `_refs/*`.

Import constraints:

- provider may import the pure diagnostic type, never store/presentation/TUI;
- loop/runtime/session may import pure diagnostic and a narrow writer port;
- store/CLI may import pure diagnostic and workspace digest helpers, never provider/TUI;
- presentation adapter is the only core-to-presentation translator;
- `v0/tui/*` imports presentation values only, never provider/runtime/store/CLI;
- headless runtime remains TUI-free; diagnostic persistence is host-injected, not a global logger.

## 9. Verification matrix

Add focused direct tests for schema/codec/store/CLI and extend existing transport, loop, runtime,
session, planner, presentation, TUI, process, launcher, and topology suites. All provider behavior is
deterministic injected fetch/model behavior; no live credential, provider, network, production
command, or actual user state is used.

| Known answer | Live record | Durable/readback | Core assertions |
|---|---|---|---|
| credential missing | credential_resolution/missing_credential/0 | exact same ID/record | fetch 0, commit 0 |
| request encoding/limit | request_build/invalid_input or limit_exceeded/0 | same | credential/fetch 0 |
| request budget | request_admission/request_budget_exhausted/exact prior | same | no extra credential/fetch |
| transport throw/timeout | transport/transport_error/1 | same | body settled, commit 0 |
| HTTP 401/429/500 | http/http_error/1 + status | same | body settled, no raw body |
| every ParseReason | response_parse/response_error/1 + 200 + exact reason | same | no tool dispatch/commit |
| response oversize | response_parse/limit_exceeded/1 + reason | same | bounded settlement |
| planner child failure | lane planner + aggregate exact | same | parent correlation, no overwrite |
| session commit failure | session_commit/commit_error/exact total | same | transcript rollback unchanged |
| cleanup failure | cancellation_cleanup/cleanup_error | same where writable | fatal precedence unchanged |
| ordinary cancellation | no failure record | none | settlement/restore unchanged |
| child failure, then parent final | planner record at occurrence count | same despite parent success | final commit cannot erase it |
| child failure, then parent exception/cancel | planner record at occurrence count | same before reject/close | settlement awaited on all paths |
| no-failure final/tool-terminal | no failure record | none | canonical commit unchanged |
| diagnostic write failure/capacity | live same record + durable=failed | no false durable claim | no generic concealment |

Multi-request known answers additionally fix occurrence-bound accounting: parent step 1 succeeds and
step 2 fails separately at transport, HTTP, and parser stages; one parent request precedes a planner
child failure; and a parent request follows a persisted child failure. Each case asserts the exact
count through failure, failing lane/model step/time, and byte-identical ID/canonical record across
outcome, event, retained UI projection, file, and CLI. Later fetches do not mutate the record.

Real PTY process evidence must show the diagnostic line, recoverable input, Ctrl-D discard/exit,
terminal restoration, empty-session cleanup, and post-exit `henji diagnostics show --id` byte-equal
readback. A second process proves restart readback. Corruption, mode/owner/symlink, capacity,
concurrent lock, atomic failure positions, stale temp, exact delete, and workspace partitioning are
covered with disposable roots.

Inject three distinct markers: credential value, Authorization-shaped header, and arbitrary private
payload. Assert all are absent from record, UI, diagnostic files, stdout/stderr, session/context,
and readback. Separately assert every required safe field is present and identical across outcome,
event, UI, file, and CLI. Negative secrecy tests without these positive assertions are incomplete.

Topology snapshots:

- every parser refusal site maps to a finite ParseReason;
- arbitrary error/message/body/header/tool/session text has no edge into the diagnostic codec/store;
- diagnostic read command has no provider/credential/tool/session-write reachability;
- TUI retains no reverse import;
- exact new leaf permissions/tasks are owned once by the offline gate.

## 10. Non-concealment table

| Field/data | Concrete secret/threat | Live | Durable | Decision |
|---|---|---|---|---|
| credential value / Authorization header | actual API credential | never | never | type cannot accept it |
| raw request/response/model/tool/session/error/stack/path | arbitrary payload/private data | never | never | fixed enums/counts replace it |
| diagnostic ID, stage, code, lane | none | required | required | exact correlation |
| provider request count | none | required | required | actual fetch delta |
| bounded HTTP status | none | when applicable | when applicable | no status text/body |
| fixed parser reason | none | when applicable | when applicable | enum only |
| timestamp, turn, model step, retry=0 | none | required | required | strict grammar/bounds |
| durability result | none | required | command result | never claim success on write failure |

Review must reject these Product findings, not relabel them as evidence gaps:

- genericizing a known safe field;
- converting a known value to unexplained `unknown`;
- rendering only status/footer text that redraw erases;
- reconstructing separate UI/store records or IDs;
- counting budget admission instead of actual fetch;
- persisting arbitrary messages as a fallback;
- deleting diagnostics with failed-turn/session cleanup;
- secrecy-only tests without positive live/durable/readback correlation;
- fake/reduced-capability Human Gate substitution.

## 11. Implementation slices, checks, review, rollback

1. **Schema and provider facts:** pure codec/invariants, typed OpenRouter errors, complete parser
   inventory, loop/outcome propagation, request accounting.
2. **Turn owner and durability:** parent/planner correlation, store, session settlement ordering,
   no-session state boundary, atomic/capacity/corruption tests.
3. **Readback and UI:** CLI/launcher dispatch, least permissions, presentation event, retained log,
   PTY/post-exit evidence.
4. **Integration/docs:** topology/inventory, README, prior non-evaluable results, new readiness
   package and implementation results.

During implementation and finding closure run only affected focused tasks, relevant check/fmt/lint,
shell syntax, and `git diff --check`. Do not run `v0:test` or `v0:gate` as an intermediate check.
Send a focused-green candidate to one 30-minute read-only implementation review that reports
Product findings separately from Evidence gaps. Allow one plan-scoped closure, then one 15-minute
narrow re-review of changed lines and existing findings. After Product Blocker/P1/P2 zero and
Verification E1/E2 zero, the coordinating owner runs the authoritative `v0:gate` once.

Rollback removes only this increment's diagnostic modules, propagation fields, store/CLI/launcher
dispatch, tests/tasks/docs, and additive UI entries. It restores no prior Step 83R code, machine
backup, session/context state, acceptance workspace, or existing dirty change. Schema v1 has no
migration because implementation is not released; any disposable test diagnostics are removed by
their fixtures. Actual preserved acceptance state is untouched.

Stop and return to the concept owner if implementation requires raw data, credential inspection,
session transcript commit for failures, unbounded retention, dependency/lockfile change, broader
telemetry, a session schema migration, hard sandbox/capability changes, provider access, more than
one closure, or a change to the Human Gate's Why/What/Whether.

## 12. Human Gates

### Human Gate 2 — implementation approval

Approval covers only the bounded repository implementation above, disposable offline/fake-provider
and PTY tests, focused-first verification, bounded review/one closure/re-review, implementation
results/lifecycle updates, and one final owner offline gate. It does not cover credential access,
provider/network, production `henji`, actual diagnostic/session/workspace state, cleanup, machine
install/update, commit, push, tag, publish, release, or provider retry.

**Stop after presenting this plan. Do not implement before explicit approval.**

### Later provider Human Gate — separate approval

Eligibility requires all matrix rows green, review zero, one owner gate green, exact live/durable/
readback correlation through a production-shaped PTY, and a documented command that reads the same
record after exit. The later package must repeat the exact task, request/cost bounds, credential and
tool authority, diagnostic command/retention/cleanup, stop conditions, and no-retry rule. It must
verify current model/API/pricing immediately before approval. A real provider attempt remains
separately approved and is never part of this implementation plan.

## 13. Planning review

Initial read-only review was NO-GO with Blocker 0, P1 1, P2 3, E1 0, and E2 1. The plan was
corrected without changing Why/What/Whether:

- child provider failure is persisted and published before parent continuation and survives later
  parent final, exception, cancellation, submit resolution/rejection, and close;
- `model_result_validation/invalid_model_result` is an exact schema invariant;
- diagnostic delete write permission is limited to the selected record and fixed lock;
- turn number matches the existing positive safe-integer session range rather than adding 512;
- request count is occurrence-bound and multi-request evidence covers prior and later fetches.

The single narrow re-review is GO with Product Blocker/P1/P2 zero and Verification E1/E2 zero. It
reviewed those five corrections only; complete parser-inventory and implementation behavior remain
implementation/review obligations under this plan.
