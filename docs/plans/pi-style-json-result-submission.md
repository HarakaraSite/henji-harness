# Pi-style terminal JSON result submission — implementation and verification plan

## Recommendation and assumptions

Concept **GO**. Add one generic terminal-tool execution contract to the existing
provider-neutral registry/loop, then implement `submit_json_result` as the first
terminal tool. A successful submission ends the loop after its tool result is
recorded, exposes canonical JSON through the existing
`LoopOutcome.finalText`/normal CLI stdout surface, and starts no follow-up model
request. Plain-text answers retain the current assistant `final` path.

This is a targeted adoption from Pi, not a change to the Zot-first
general-runtime policy. Pi's `structured-output.ts` demonstrates a tool result
with `terminate: true`, and Pi's agent loop stops when a successfully finalized
terminal batch requests termination. The relevant read-only evidence is:

- `_refs/pi/packages/coding-agent/examples/extensions/structured-output.ts`
- `_refs/pi/packages/agent/src/agent-loop.ts`, especially terminal-batch
  handling
- `_refs/pi/packages/agent/src/types.ts`, especially `AgentToolResult.terminate`
- Pi pinned commit `a69bef789bc95abf0acee16f7b4660b70b650bb9` (MIT)

Henji independently implements only the terminal-control idea. Zot remains the
first general runtime reference at pinned commit
`9b7bb6a4f36bc8c8deb2cc5796a8f557f4fb7479`; no Pi source becomes a product
dependency and `_refs/` is neither changed nor executed.

The implementation assumptions are local and reversible:

- v0 JSON numbers use the existing ECMAScript `JSON.parse`/`JSON.stringify`
  number semantics; values outside exact binary64 representation are not
  preserved as arbitrary-precision numbers.
- A JSON submission is bounded to 64 KiB of UTF-8 both before parsing and after
  canonicalization, matching the normal runtime's present task-size scale and
  keeping terminal output bounded.
- Corpus JSON-output behavior is derived from the existing
  `oracle.kind === 'json_value'`; no task profile, selector, new corpus field,
  or prompt rewrite is introduced.

No unresolved Why/What/Whether decision remains. If implementation cannot
preserve the exact terminal/result/report contracts below without changing
corpus data, relaxing the scorer, or adding a provider-specific schema path,
stop and return a plan delta rather than inventing behavior.

## Confirmed current state and gap

- `Tool.execute` currently returns only text, `Registry.dispatch` always returns
  a non-terminal `ToolResultContent`, and `runAgent` can stop only on assistant
  `final`, `max_steps`, or `contract_failure`.
- The normal runtime advertises four tools in stable name order and calls
  `runAgent` with eight model requests maximum. The current CLI prints only
  `LoopOutcome.finalText` on success.
- `OpenRouterAgentModel` accepts a `JsonValue` tool schema and serializes it
  unchanged as OpenAI-style `function.parameters`. Current official OpenRouter
  guidance demonstrates object-root parameter schemas and provider translation,
  but does not establish portable support for an unconstrained arbitrary-JSON
  `value` schema (<https://openrouter.ai/docs/guides/features/tool-calling>).
  Therefore v0 uses a fixed object-root string transport.
- The corpus scorer strictly parses the whole final text for `json_value`; it
  does not strip Markdown fences. The consumed sentinel's
  `v1.multi-tool.fmt.explicit` case performed both domain tools correctly but
  fenced the final JSON and failed with `oracle_json_malformed`.
- Offline/live observation mapping currently requires a terminal assistant text
  message and treats all tool calls as corpus domain-tool events. It cannot
  represent a tool-terminal outcome separately.
- The active offline gate passes 144 tests. No implementation gate in this plan
  may read a real credential or run a provider command.

## Exact product contracts

### Tool input and canonical JSON

Advertise this fifth tool in the normal runtime:

```text
name: submit_json_result
description: Submit the final answer when it is a JSON value. Call it as the only tool call in the
             assistant batch. Pass the complete JSON text in `json`. Use the normal assistant final
             response for plain text.
inputSchema:
  type: object
  properties:
    json: { type: string }
  required: [json]
  additionalProperties: false
```

The input must be an object with exactly one string field, `json`. The host
applies a fatal UTF-8 byte bound of 65,536, calls `JSON.parse` on the whole
string, recursively accepts only the existing `JsonValue` domain with finite
numbers, then calls `JSON.stringify` exactly once. The canonical result must
also be at most 65,536 UTF-8 bytes. Top-level object, array, string, number,
boolean, and null are all valid. Empty input, Markdown fences,
prefixes/suffixes, invalid JSON, non-finite values, unknown fields, wrong field
types, and either byte-bound violation are invalid arguments. Insignificant
input whitespace and object key insertion order are normalized only by the
standard parse/stringify round trip; no sorting, schema-specific coercion,
Markdown removal, repair, or permissive extraction occurs.

### Generic terminal execution representation

Extend the tool boundary with exact discriminated results while preserving
current string-returning tools as the compatibility shorthand for a continuing
success:

```ts
type ToolExecutionResult =
  | { readonly kind: "continue"; readonly text: string }
  | {
    readonly kind: "terminate";
    readonly text: string;
    readonly finalText: string;
    readonly terminalKind: "json_result";
  };

interface Tool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonValue;
  readonly terminal?: boolean;
  execute(
    argumentsValue: JsonValue,
  ): string | ToolExecutionResult | PromiseLike<string | ToolExecutionResult>;
}
```

Existing tools omit `terminal` and return strings. `submit_json_result` sets
`terminal: true`; success returns `kind: 'terminate'`,
`terminalKind: 'json_result'`, a fixed non-secret acknowledgement in `text`, and
canonical JSON in `finalText`. `Registry.dispatch` returns a discriminated
dispatch value:

```ts
type RegistryDispatchResult =
  | { readonly content: ContinuingToolResultContent; readonly terminal: null }
  | {
    readonly content: TerminalToolResultContent;
    readonly terminal: {
      readonly kind: "json_result";
      readonly finalText: string;
    };
  };

interface TerminalToolResultContent {
  readonly kind: "tool_result";
  readonly callId: string;
  readonly name: string;
  readonly text: string;
  readonly outcome: "success";
  readonly terminal: "json_result";
}
```

`ContinuingToolResultContent` retains the existing exact fields and
`success | error` outcome. The terminal marker is present only on a successful
terminal result. Registry normalization rejects a non-terminal tool returning
`terminate`, or a terminal tool returning a continuing success, as a normal
sanitized execution-error result. Thrown `ToolInputError`, thrown/rejected
execution, unknown tool, or malformed execution result never carries terminal
control.

### Batch policy and loop outcome

Before dispatch, the loop resolves which registered calls are terminal. If a
batch contains a terminal tool, it is valid only when the batch contains exactly
one call and that call is terminal. For a mixed batch, duplicate/multiple
terminal calls, or terminal plus unknown/domain calls:

- execute none of the calls;
- append one correlated continuing error result for every call, in source order,
  using the fixed sanitized message
  `terminal tool must be the sole call in its batch`;
- do not produce `finalText` and do not terminate;
- permit the next request only if the existing request bound has capacity.

This fail-closed pre-dispatch rule prevents a domain side effect or multiple
competing final values. An invalid or failed sole `submit_json_result` call
likewise appends a continuing error result and may be repaired only by a later
model request inside the existing bound. No application retry, automatic
argument repair, fallback, or task rewrite is added.

Successful terminal completion appends the assistant tool-call message and its
one terminal tool message, increments the existing step/call/result counters,
and returns:

```ts
{
  ok: true,
  outcome: 'final',
  stopReason: 'tool_terminal',
  finalText: canonicalJson,
  terminalKind: 'json_result',
  // existing task, steps, counters, transcript
}
```

The existing assistant-text success remains byte-for-byte compatible with
`outcome: 'final'`, `stopReason: 'final'`, no `terminalKind`, and its terminal
assistant text message. Add `tool_terminal` only to `LoopStopReason`. The normal
CLI treats both success variants identically at the output surface: exit 0,
canonical/result text on stdout with exactly the current trailing-newline rule,
and empty stderr. Existing failure JSON is unchanged.

Terminal detection occurs before the post-dispatch `max_steps` check. Therefore
a valid submission on the eighth normal-runtime request, or on a corpus case's
last allowed request, succeeds with no ninth or other extra request. A
submission error or rejected mixed batch on the last request returns the
existing `max_steps` outcome after recording its error results.

### Runtime guidance and stable registry

`createRuntimeRegistry` adds `submit_json_result`; the advertised order remains
registry-sorted:

```text
character_count
count_json_array_items
list_json_object_keys
submit_json_result
uppercase_text
```

The tool description above is the only new runtime/model guidance. It is present
on every normal and evaluation request, explains JSON versus plain-text
completion and the sole-call rule, and requires no system-message contract, task
introspection, dynamic task profile, CLI option, or provider-specific prompt.
Existing user prompts and corpus JSON remain unchanged.

## Evaluation, scoring, and report contract

Keep corpus domain-tool expectations and `TOOL_NAMES` limited to the existing
four tools. Extend `CorpusObservation` with separate terminal evidence:

```ts
type SubmissionEvidence =
  | null
  | {
    readonly kind: "json_result";
    readonly requestOrdinal: number;
    readonly callId: string;
    readonly resultCallId: string;
    readonly outcome: "success";
  };

interface CorpusObservation {
  readonly finalText: string;
  readonly requestCount: number;
  readonly toolEvents: readonly DomainToolEvent[];
  readonly submission: SubmissionEvidence;
}
```

The transcript mapper accepts exactly two successful terminal shapes:

- assistant final text: `submission: null`, existing terminal assistant message;
- JSON tool terminal: terminal `submit_json_result` call/result as the final
  transcript pair, correlated IDs/names/marker, canonical `finalText`, and one
  `submission` record.

`toolEvents` receives only the four corpus domain tools. The mapper still
validates every transcript call/result and reconciles loop counters against
`toolEvents.length + (submission === null ? 0 : 1)`; submission request ordinal
is zero-based like domain events. Unknown or structurally damaged terminal
evidence remains `transcript_malformed`, not a quality score.

Add a distinct `submission` score dimension and stable failure codes
`submission_missing` and `submission_unexpected`. A `json_value` task passes
that dimension only with one successful `json_result` submission; an
`exact_text` task passes only with `submission: null`. Oracle scoring continues
to consume `finalText` exactly as today, and domain-tool
sequence/max-call/separate-round scoring consumes only `toolEvents`. Request
scoring continues to use total model requests, so existing one-, two-, and
three-request case ceilings remain valid: the successful submission replaces the
old assistant-final request rather than adding a request.

Because current report validators are exact-key versioned contracts, do not
mutate report v1 in place. Add offline/live report v2 contracts and IDs,
preserving the v1 types/validators as read-only legacy contracts:

```text
henji-offline-corpus-eval-v2 / schemaVersion 2
henji-live-corpus-eval-v2    / schemaVersion 2
```

Each v2 passed/failed case retains `finalText`, total `requestCount`, domain
`toolEvents`, and full score, and adds exact-key `submission`. Top-level live
suite/profile/request accounting and CLI stdout/exit rules remain otherwise
unchanged. Both v2 validators recompute the expanded score and reject
source/task mismatches, terminal evidence inside `toolEvents`, malformed
submission correlation/ordinal, and v1/v2 field mixing. Existing v1 report
values remain valid under their v1 validators; runners and CLIs emit only v2
after this increment. There is no persisted-report migration.

The deterministic scripted model changes behavior, not corpus data:

- all 17 `json_value` tasks use `submit_json_result` as their terminal request;
- all seven `exact_text` tasks retain the assistant `final` path;
- domain tool rounds and exact request counts stay 0/1/2 domain calls and 1/2/3
  model requests;
- every request verifies all five advertised tool definitions and the full
  preceding transcript, including canonical submission result and no request
  after it.

Live fake-fetch fixtures exercise both terminal paths through the real
OpenRouter adapter, loop, registry, mapper, scorer, and v2 report. This plan
does not authorize a new sentinel/canonical provider attempt. The historical 5/6
v1 sentinel report remains historical evidence and is not rewritten.

## File ownership after approval

Implementation ownership is limited to:

- `v0/agent/contracts.ts`: terminal result/outcome unions
- `v0/agent/tools.ts`: generic dispatch result, strict submission tool, terminal
  normalization
- `v0/agent/loop.ts`: sole-terminal batch policy, early successful stop,
  last-step ordering
- `v0/agent/runtime.ts`: fifth fixed tool
- `v0/agent/runtime_cli.ts`: accept both successful stop reasons through the
  same final-output surface
- `v0/corpus/task_corpus.ts`: separate submission observation/score dimension;
  domain tools unchanged
- `v0/eval/scripted_corpus_model.ts`: five definitions and JSON/text terminal
  scripts
- `v0/eval/offline_corpus_runner.ts`, `v0/eval/offline_corpus_cli.ts`: dual
  transcript mapping and v2 report
- `v0/eval/live_corpus_runner.ts`, `v0/eval/live_corpus_cli.ts`: v2 live
  mapping/report compatibility
- `tests/v0/agent_loop_test.ts`, `tests/v0/agent_openrouter_model_test.ts`,
  `tests/v0/agent_runtime_test.ts`, `tests/v0/agent_runtime_process_test.ts`,
  `tests/v0/task_corpus_test.ts`, `tests/v0/offline_corpus_runner_test.ts`, and
  `tests/v0/live_corpus_runner_test.ts`: focused and regression evidence
- `tests/v0/fixtures/runtime_process_fixture.ts` only if needed to produce the
  terminal process case
- `deno.v0.json`: check/gate file coverage only if a new owned file is
  introduced; existing task commands, permissions, profile, and live/credential
  launcher literals otherwise remain unchanged
- `README.md`: fifth-tool and JSON/plain-text terminal behavior
- new `docs/plans/pi-style-json-result-submission-results.md`: acceptance
  package
- repository owner only: phase/checkpoint updates in `AGENTS.md` and
  `.handoff/handoff.md`

Do not change `v0/corpus/task-corpus.v1.json`, provider
profile/endpoint/credential launcher, dependencies, lockfiles, operations
credential documentation, prior plans/results, archive, or `_refs/`. Do not add
environment/network/file/subprocess permissions.

## Ordered implementation increments

### 1. Add and prove the generic terminal boundary

Implement the discriminated execution/dispatch/result contracts, terminal-tool
marker, registry normalization, and loop sole-batch policy before adding the
product tool. Preserve existing tool string-return compatibility and
assistant-final transcript/outcome shape.

Direct loop/registry tests prove normal single/multiple calls remain ordered,
terminal success stops after the tool message, mixed/multiple terminal batches
execute zero calls, terminal/non-terminal contract mismatches become continuing
errors, and invalid/throwing terminal execution does not stop.

### 2. Add strict JSON submission and normal runtime composition

Implement `submit_json_result` with the exact schema, byte bounds, parse,
`JsonValue` validation, and canonicalization contract. Add it to the fixed
registry and update normal CLI success recognition.

Direct runtime tests cover all six top-level JSON kinds, nesting, insignificant
whitespace, canonicalization, wrong shapes/types/unknown fields,
blank/fenced/prefixed/trailing malformed input, exact 65,536/65,537-byte
boundaries, execution failure, stable five-tool order, no extra fetch after
submission, and success on step 8. Process E2E proves canonical
object/array/scalar stdout and unchanged assistant-text/failure channels without
network or credentials.

### 3. Prove provider-neutral wire transport

Extend adapter tests to assert the exact fifth OpenAI-style function definition
and object-root `parameters`, JSON string escaping in response tool arguments,
recursive JSON text carried only inside the `json` string, and unchanged
encoding of terminal transcript-compatible result content. Use fake fetch and
dummy credentials only. Do not add a provider-specific request field,
strict-schema option, response format, or live call.

### 4. Separate evaluation terminal evidence

Extend observation/scoring, transcript mapping, v2 report
types/validators/serializers, and both eval CLIs. Preserve four-domain-tool
scoring and v1 read validation. Negative tests cover assistant/tool source
mismatches, missing/unexpected/duplicate submission, malformed
marker/correlation/ordinal, submission leaked into domain `toolEvents`, total
counter mismatch, v1/v2 mixing, and report score recomputation.

### 5. Convert scripted JSON completions and live fake fixtures

Update all 17 JSON scripts to sole-call submission and leave all seven text
scripts on assistant final. Prove each category's domain sequence, terminal
source, request ceiling, canonical final text, fresh per-case state, and no
post-submission request. Live fake-fetch sentinel/canonical coverage must retain
12/48 maximum external requests and completed 6/6 and 24/24 mechanical success
under report v2.

### 6. Integrate documentation, evidence, and bounded review

Update README, retain existing Deno command permissions, run the local gates
below, and create the results package. Independent read-only review is bounded
to 30 minutes and stops after 10 minutes without new evidence. It traces generic
terminal separation, pre-dispatch sole-call enforcement, canonicalization,
last-step ordering, wire schema, transcript/report/scorer separation, CLI
output, request ceilings, old final path, and scope. One changed-lines-only
re-review is limited to 15 minutes. GO requires Blocker/P1/P2 zero; a
shared-contract deviation returns to the repository owner.

## Requirements-to-tests matrix

| Requirement / failure mode              | Required observable evidence                                                                   |
| --------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Object-root arbitrary-JSON transport    | exact `{json:string}` definition on all requests; object/array/scalar/nested round trips       |
| Strict whole input and canonical output | fenced/prefix/suffix malformed errors; whitespace/key-order parse/stringify result             |
| Generic terminal result                 | terminal marker in tool result and `tool_terminal` outcome with canonical `finalText`          |
| Invalid arguments/execution             | continuing correlated error; next bounded request can recover                                  |
| Mixed/multiple terminal calls           | zero executions, ordered error results, no output ambiguity or termination                     |
| Existing domain tools                   | string-return compatibility and unchanged single/multi-call behavior                           |
| Last allowed request                    | step 8 and per-case last request succeed; fetch/request count has no increment afterward       |
| Runtime guidance                        | exact fifth description on every request; no system/task-profile/CLI selector                  |
| Assistant plain text                    | unchanged `final` stop, transcript, stdout newline, and stderr behavior                        |
| Corpus domain scoring                   | only four-domain-tool events affect sequence/max-call/separate-round dimensions                |
| Submission scoring                      | JSON requires one submission; text forbids it; distinct failure codes/dimension                |
| Offline reports                         | v2 24/24/24/0, 17 tool-terminal and seven assistant-terminal cases; v1 read validator retained |
| Live fake reports                       | v2 sentinel 6/6 within 12 and canonical 24/24 within 48; no network/credential                 |
| OpenRouter serialization                | exact object-root parameters and escaped JSON string through fake fetch                        |
| CLI process surface                     | canonical JSON or plain text only on stdout; failures remain allowlisted stderr JSON           |
| Regression/safety                       | all focused/full gates green; production/live tasks absent from executed local command set     |

## Local verification and acceptance evidence

Use the repository-pinned Deno 2.9.4 commands derived from `deno.v0.json`:

```sh
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --config deno.v0.json agent:test
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --config deno.v0.json agent:transport:test
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --config deno.v0.json agent:runtime:test
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --config deno.v0.json agent:runtime:process:test
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --config deno.v0.json agent:corpus:test
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --config deno.v0.json agent:corpus:eval:test
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --config deno.v0.json agent:corpus:eval:offline
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --config deno.v0.json agent:corpus:eval:live:test
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --config deno.v0.json v0:check
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --config deno.v0.json v0:fmt
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --config deno.v0.json v0:lint
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --config deno.v0.json v0:test
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --config deno.v0.json v0:gate
git diff --check
```

Do not run `agent:run`, `agent:acceptance`, either live sentinel/canonical task,
the credential-file launcher, a credential probe, or any network/provider
command.

`docs/plans/pi-style-json-result-submission-results.md` records the approved
plan path/SHA and any reviewed local delta, changed files, requirement-to-test
evidence, exact command exits/pass counts, offline/live-fake report
IDs/counts/source partition/request maxima, five-tool order, no-extra-request
proof, provider/network/credential/persistent-write activity zero, review
findings/disposition, deviations, unperformed work, rollback status, and
residual risks. It must not record raw provider or credential material.

## Completion, compatibility, rollback, and deferred risks

Completion requires every matrix row to have direct evidence, all local commands
and diff check to pass, v2 offline/live-fake reports to validate with the exact
source partition and request ceilings, existing assistant-final/process failures
to remain compatible, no provider/credential operation, and independent review
GO with Blocker/P1/P2 zero.

This change is state-free and has no data migration. Normal assistant text and
CLI failure contracts remain compatible. Tool definition order changes
intentionally from four to five, loop consumers must accept the additive
`tool_terminal` success union, and eval writers move to explicitly versioned v2
while v1 read validation remains available. Rollback removes the submission
tool/result/report-v2 additions and their tests/docs, restores the four-tool
registry and prior mapper/scorer shapes, and does not reset the worktree,
rewrite historical reports, touch credentials, or modify `_refs/`.

Deferred risks/work are real-model adherence, another provider attempt, broader
structured-output schemas, schema-derived task profiles,
streaming/sessions/extensions, persistence, arbitrary-precision JSON numbers,
retry/fallback, scorer relaxation, aggregation/statistics, and milestone
hardening. A future provider run requires a new explicit Human Gate with fresh
official availability/pricing, fixed command/cases/request/cost ceilings, and
retry/rerun/follow-up all zero.

## Human Gate

**Approve only the local implementation, permission-free fake-provider/process
tests, full offline verification, v2 result evidence, and bounded read-only
review described above.**

Approval does not authorize credential inspection/read/change, `agent:run`,
`agent:acceptance`, live sentinel/canonical or credential-launcher execution,
network/provider requests, corpus-data or scorer relaxation, `_refs/`
changes/execution, dependencies/lockfiles, persistent state, destructive
operations, commit, push, tag, publish, or release.
