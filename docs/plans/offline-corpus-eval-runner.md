# Offline corpus eval runner implementation plan

## Recommendation and boundary

Concept **GO**. Add the smallest test/eval-only offline runner that connects the committed 24-case
corpus to the real provider-neutral agent loop and real four-tool registry. Keep the product runtime,
provider adapter, corpus data, and scorer unchanged.

This plan authorizes no implementation until its Human Gate is approved. It does not authorize a
live model/provider call, credential access, production command, aggregate quality claims, repeated
trials, token/cost collection, report persistence, dependencies, or lockfile changes.

Confirmed baseline:

- `v0/corpus/task-corpus.v1.json` is schema 1, corpus ID
  `henji-normal-cli-small-v1`, with 24 canonical-ID-ordered cases.
- `loadTaskCorpus` validates the corpus and literal `deno.v0.json` fixtures fail closed.
- `scoreCorpusObservation` returns case-local scores and stable failure codes.
- `runAgent` returns final text, steps, tool counters, and the complete transcript.
- `createRuntimeRegistry` constructs the current four real tools without constructing a provider.
- The current focused corpus suite passes 9 tests and the full v0 gate passes 110 tests.

## Zot-first reference decision

The first reference is Zot at pinned commit
`9b7bb6a4f36bc8c8deb2cc5796a8f557f4fb7479`:

- `_refs/zot/packages/agent/modes/print.go` separates final assistant text from event history after a
  non-interactive run completes.
- `_refs/zot/packages/agent/modes/json.go` represents turns, tool calls, and tool results as explicit
  events.
- `_refs/zot/packages/agent/cli.go`, `runPrintMode` and `writePrintStats`, separates execution from
  post-success statistics output.
- `_refs/zot/README.md`, Usage and Modes, defines completion-oriented print and JSON modes.

Henji adopts only the separation between execution, event extraction, and report presentation. It
does not copy Zot code or adopt NDJSON streaming, token/cost usage, sessions, or its broader runtime.

## Fixed runner API

Add `v0/eval/offline_corpus_runner.ts` with:

```ts
runOfflineCorpusEval(
  seam?: OfflineCorpusEvalTestSeam,
): Promise<OfflineCorpusEvalReportV1>

observationFromLoopOutcome(
  task: CorpusTask,
  outcome: LoopOutcome,
): CorpusObservation

validateOfflineCorpusEvalReport(
  value: unknown,
  corpus: ValidatedTaskCorpus,
): OfflineCorpusEvalReportV1

serializeOfflineCorpusEvalReport(
  report: OfflineCorpusEvalReportV1,
  corpus: ValidatedTaskCorpus,
): string
```

The runner exposes no product option for corpus path, step limit, provider, model, registry, or tool
path. It uses literal `CORPUS_PATH` and `MAX_STEPS` 8.

The test seam is limited to:

```ts
interface OfflineCorpusEvalTestSeam {
  fixtureReader?: FixtureReader;
  createCaseDependencies?: (
    task: CorpusTask,
  ) => { readonly model: Model; readonly registry: Registry };
  runLoop?: typeof runAgent;
}
```

Execution order is fixed:

1. Call `loadTaskCorpus(CORPUS_PATH, fixtureReader)` exactly once.
2. Construct no per-case dependency, model, registry, or loop until preflight succeeds.
3. Traverse the validated task array without reordering or rewriting it.
4. Call the dependency factory once per attempted task and obtain a fresh model and fresh
   `createRuntimeRegistry()`.
5. Call `runAgent(task.prompt, model, registry, { maxSteps: 8 })` once.
6. Map the outcome/transcript to a raw observation and call the existing scorer once.
7. Build and strictly validate the report before returning or serializing it.

## Transcript-to-observation contract

`requestCount` is `LoopOutcome.steps`. Request ordinals are zero-based model-request ordinals.

A valid successful transcript has only this shape:

```text
user(exact task prompt)
[ assistant(nonempty tool-call batch), tool(equal-length result batch) ]*
assistant(exact final text)
```

The mapper requires:

- `ok: true`, `outcome` and `stopReason` `final`, exact task prompt, and string `finalText`;
- exact initial user text and exact terminal assistant text, with nothing after it;
- assistant-message count equal to `steps`;
- tool-call/result totals equal to the outcome counters;
- every intermediate assistant message followed immediately by its tool result message;
- nonblank, run-unique call IDs;
- positional call/result cardinality, ID, and name equality; and
- only `success` or `error` result outcomes.

Each paired call/result becomes:

```ts
{
  requestOrdinal,
  callId,
  resultCallId,
  callName,
  resultName,
  outcome,
}
```

Calls in one assistant batch share an ordinal. Separate multi-tool rounds therefore receive
ordinals 0 and 1, while a same-round batch receives the same ordinal and fails the existing
`tool_same_round` score. Structural or correlation damage is a runner contract failure and is not
passed to the scorer as if it were model quality.

## Versioned report contract

The report is deterministic and contains no timestamp, duration, tokens, cost, rate, ranking, or
pair comparison.

```ts
interface OfflineCorpusEvalReportV1 {
  readonly schemaVersion: 1;
  readonly reportId: 'henji-offline-corpus-eval-v1';
  readonly mode: 'offline_scripted';
  readonly corpus: {
    readonly schemaVersion: 1;
    readonly corpusId: 'henji-normal-cli-small-v1';
  };
  readonly completion: {
    readonly status: 'completed' | 'aborted';
    readonly abortCode: OfflineRunnerFailureCode | null;
    readonly abortTaskId: string | null;
  };
  readonly counts: {
    readonly total: 24;
    readonly completed: number;
    readonly passed: number;
    readonly failed: number;
  };
  readonly results: readonly OfflineCorpusCaseResult[];
}
```

The exact-key case-result union is:

- `passed` or `failed`: task ID, status, raw final text, request count, copied tool events, and the
  complete existing `CorpusCaseScore`;
- `error`: task ID, status `error`, and one allowlisted failure code; or
- `not_run`: task ID, status `not_run`, and `run_aborted`.

`counts.completed` is `passed + failed`. An attempted `error` is not counted as completed.

The strict validator rejects unknown or missing fields, version/report/mode drift, non-finite or
non-integer counters, any result count other than 24, duplicate/missing/out-of-order task IDs,
task/score ID mismatch, count/status mismatch, invalid score/observation shapes, completed reports
with error/not-run entries or abort metadata, and aborted reports without exactly one error followed
only by canonical not-run entries.

Stable runner failure codes are:

```text
corpus_preflight_failed
dependency_construction_failed
case_execution_failed
loop_contract_failure
loop_max_steps
loop_outcome_invalid
transcript_malformed
score_contract_invalid
report_contract_invalid
run_aborted
```

Raw exceptions, stacks, prompts, tool arguments/result text, credential data, and provider metadata
must not enter an error result.

## Deterministic scripted model

Add `v0/eval/scripted_corpus_model.ts`. It holds an exact allowlisted executable script table; do
not add scripts to the corpus JSON or derive final answers from corpus oracles at runtime.

Each script fixes task IDs, exact prompt, ordered tool rounds with arguments and expected result
text, and exact final text. The factory verifies exact task lookup and prompt equality. On every
`generate`, it verifies the four advertised tool definitions, the entire expected transcript prefix,
and the preceding result's ID, name, text, and successful outcome before advancing. Exhaustion,
unexpected requests, or result mismatch produce `FixtureModelContractError` and a loop contract
failure.

The 24-task matrix is:

| Task pair or task | Ordered tool input/result | Final text |
| --- | --- | --- |
| `character-count.henji-chick` explicit/implicit | `character_count({text:"Henji 🐣"})` → `{"count":7}` | `{"count":7}` |
| `character-count.naive` explicit/implicit | `character_count({text:"naïve"})` → `{"count":5}` | `{"count":5}` |
| `count-json-array-items.complex` explicit/implicit | exact complex JSON array → `{"count":4}` | `{"count":4}` |
| `count-json-array-items.simple` explicit/implicit | `[1,2,3]` → `{"count":3}` | `{"count":3}` |
| `final-only.echo` | none | `MiXeD 123 !` |
| `final-only.json` | none | `{"status":"ready","version":1}` |
| `final-only.multiline` | none | `alpha\nbeta` |
| `final-only.token` | none | `HENJI CORPUS READY` |
| `list-json-object-keys.fmt` explicit/implicit | literal path and `fmt` → `["lineWidth","semiColons","singleQuote"]` | same JSON array |
| `list-json-object-keys.lint` explicit/implicit | literal path and `lint` → `["rules"]` | same JSON array |
| `multi-tool.fmt` explicit/implicit | fmt list call/result, then count of returned exact array → `{"count":3}` | `{"count":3}` |
| `multi-tool.lint` explicit/implicit | lint list call/result, then count of returned exact array → `{"count":1}` | `{"count":1}` |
| `uppercase-text.ascii` explicit/implicit | `uppercase_text({text:"Henji harness"})` → `HENJI HARNESS` | `HENJI HARNESS` |
| `uppercase-text.unicode` explicit/implicit | `uppercase_text({text:"Straße café"})` → `STRASSE CAFÉ` | `STRASSE CAFÉ` |

The implementation must spell out the exact JSON strings shown in the canonical corpus plan. The
table is self-checked so its exact ID set equals the validated corpus task-ID set. Each fresh model
resets call IDs to `call-1`, `call-2`.

## Abort and continue semantics

- Corpus or fixture preflight failure throws sanitized `corpus_preflight_failed`; zero case
  dependencies and loops are constructed, and no report is produced.
- An ordinary scorer failure is recorded as `failed`, and execution continues through all 24 cases.
- A dependency factory exception records `dependency_construction_failed`, aborts, and fills all
  later canonical tasks with `not_run`.
- A thrown loop records `case_execution_failed` and aborts.
- Returned `contract_failure` or `max_steps` records `loop_contract_failure` or `loop_max_steps` and
  aborts.
- Invalid outcome/counters records `loop_outcome_invalid`; malformed transcript/correlation records
  `transcript_malformed`; scorer throw or malformed score records `score_contract_invalid`. Each
  aborts at that case.
- Report validation or serialization failure throws `report_contract_invalid`; no invalid JSON is
  emitted.

## Offline CLI and Deno tasks

Add `v0/eval/offline_corpus_cli.ts`. It accepts no arguments and invokes the default runner once.

- A valid report is one JSON line plus newline on stdout.
- Exit 0 requires completed status and zero failed cases.
- A completed report with scored failures or an aborted report is emitted to stdout with exit 1.
- A preflight/report fatal condition leaves stdout empty and emits one compact, allowlisted error
  JSON line containing schema version and failure code to stderr, then exits 1.
- It reads no stdin and uses no file output, network, environment, subprocess, or persistent state.

Add these exact conceptual tasks to `deno.v0.json` using the repository-pinned Deno 2.9.4 path:

```text
agent:corpus:eval:offline =
deno run --no-prompt --allow-read=v0/corpus/task-corpus.v1.json,deno.v0.json
  v0/eval/offline_corpus_cli.ts

agent:corpus:eval:test =
deno test --no-prompt --allow-read=v0/corpus/task-corpus.v1.json,deno.v0.json
  tests/v0/offline_corpus_runner_test.ts
```

Add new source/tests to `v0:check` and the focused test to `v0:gate`. Existing directory scopes
cover format, lint, and the full suite. The gate must not invoke the offline CLI itself or production
`agent:run`/`agent:acceptance`.

## File ownership and unchanged files

Implementation ownership after approval:

- new `v0/eval/scripted_corpus_model.ts`
- new `v0/eval/offline_corpus_runner.ts`
- new `v0/eval/offline_corpus_cli.ts`
- new `tests/v0/offline_corpus_runner_test.ts`
- modified `deno.v0.json`
- new `docs/plans/offline-corpus-eval-runner-results.md`
- repository owner only: phase/checkpoint updates in `AGENTS.md` and `.handoff/handoff.md`

Remain unchanged:

- `v0/corpus/task-corpus.v1.json` and `v0/corpus/task_corpus.ts`
- all `v0/agent/` sources
- production `agent:run` and `agent:acceptance` task literals
- `README.md`, dependencies, lockfiles, provider/profile/credential behavior, persistent state,
  archive, and `_refs/`

If implementation requires changing the corpus, scorer, loop, product runtime, provider boundary,
or these external contracts, stop and return the cause, evidence, impact, plan delta, and validation
proposal.

## Ordered implementation

1. Add report/result/error types, strict validator, and serializer.
2. Add the exact 24-case script table, transcript-aware scripted model, and complete-ID self-check.
3. Implement preflight-once, fresh per-case dependencies, canonical execution, observation mapping,
   scoring, and continue/abort behavior.
4. Add the stdout-only offline CLI.
5. Add focused direct tests and exact-permission Deno tasks; integrate check and gate.
6. Run all verification, write the requirement-to-evidence result, and perform bounded independent
   review.

## Direct test matrix

Focused tests must directly cover:

- default runner: 24 passed in canonical order and counts 24 total/completed/passed, 0 failed;
- missing/extra/duplicate script IDs, prompt mismatch, unknown tool, and script exhaustion;
- exact preceding-result validation for single- and multi-tool rounds;
- zero construction/run before successful corpus validation, including malformed/drifted fixture;
- 24 factory calls with distinct model/registry objects and per-case call-ID reset;
- wrong final and valid-but-forbidden tool call as case-local failures that do not stop later cases;
- dependency construction exception, loop exception, contract failure, and max steps as immediate
  abort with canonical not-run suffix;
- malformed user/prompt/role order, empty call batch, missing tool message, count/ID/name mismatch,
  duplicate call ID, terminal text mismatch, and counter mismatch;
- ordinals: zero for single-tool, zero then one for separate rounds, same ordinal for one batch;
- strict report rejection for field/version/mode/count/order/partition/score-task drift;
- serialization parse round-trip, exact newline, and absence of time/token/cost/rate/pair fields;
- exact read-only permissions with no net/env/write/run permission;
- unchanged production task strings and no production invocation in the gate; and
- zero fetch, credential source, provider adapter, or persistent write on default runner/CLI paths.

## Verification and acceptance evidence

Use the repository-pinned Deno 2.9.4 binary:

```sh
deno task --config deno.v0.json agent:corpus:eval:test
deno task --config deno.v0.json agent:corpus:eval:offline
deno task --config deno.v0.json agent:corpus:test
deno task --config deno.v0.json agent:runtime:test
deno task --config deno.v0.json v0:check
deno task --config deno.v0.json v0:fmt
deno task --config deno.v0.json v0:lint
deno task --config deno.v0.json v0:test
deno task --config deno.v0.json v0:gate
git diff --check
```

Do not run `agent:run`, `agent:acceptance`, or another production provider command.

Completion requires:

- one validated report-v1 JSON line with 24 canonical results and counts 24/24/24/0;
- focused and full repository gates green;
- corpus, scorer, product runtime, production tasks, dependencies, and lockfiles unchanged;
- a result mapping requirements to exact commands/counts, provider/network/credential/persistent-write
  zero evidence, deviations, review result, and remaining risks; and
- a 30-minute bounded read-only review of preflight order, fresh state, real loop/registry use,
  transcript mapping, abort behavior, schema, permissions, and scope. If fixed, one changed-lines-only
  re-review is limited to 15 minutes. Blocker/P1/P2 must be zero for GO.

Rollback removes only the additive eval files, two task entries and gate/check additions, results,
and lifecycle bookkeeping. There is no migration.

Residual risks:

- The scripted model proves deterministic wiring and scoring, not live-model quality.
- Script data duplicates expected behavior, so simultaneous corpus/script mistakes still require
  review.
- Twenty-four cases cannot support statistical claims.
- Intentional `deno.v0.json` fixture changes stop preflight until a corpus-revision decision.

## Human Gate

**Does the user approve this plan?**

Approval authorizes only the local offline runner, exact scripted model, strict report/CLI, tests,
Deno task/gate integration, result evidence, and bounded review described above.

Live provider/model execution, credential existence/value access, repeated trials, success-rate or
pair A/B/ranking aggregation, token/cost collection, production CLI exposure, report persistence,
dependencies, lockfiles, commit, push, tag, publish, and release remain separate Human Gates.
