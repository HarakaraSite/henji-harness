# Live corpus evaluation implementation and acceptance plan

## Recommendation and boundary

Concept **GO**. Add an evaluation-only live runner and CLI around the accepted 24-case corpus,
mechanical scorer, `OpenRouterAgentModel`, `runAgent`, and fixed four-tool registry. Do not change
the normal product CLI, the offline runner, corpus data, scorer, provider adapter, or model profile.

Progress is deliberately split into three Human Gates:

1. **Gate A:** local implementation, fake-fetch tests, full offline gate, and bounded review;
2. **Gate B:** one fixed six-category sentinel provider attempt;
3. **Gate C:** one canonical 24-case provider attempt, only after a completely successful sentinel.

This plan is not implementation authorization until Gate A is explicitly approved. Gate A does not
authorize credential inspection or a provider request. Gate B and Gate C each require a separate
explicit approval and never authorize automatic retry, rerun, fallback, or follow-up. Expected next
requests inside one tool loop are not retries; they remain within the case's fixed request ceiling.

Confirmed baseline:

- `v0/corpus/task-corpus.v1.json` is the single canonical corpus source: schema 1, corpus ID
  `henji-normal-cli-small-v1`, 24 cases in canonical ID order, and six categories of four cases.
- `scoreCorpusObservation` provides case-local mechanical scoring and stable failure codes.
- The accepted offline report ID, mode, and 24-case behavior remain unchanged.
- `OpenRouterAgentModel.generate` starts zero or one external fetch and has no application retry.
- The normal runtime exposes the fixed four tools, permits only literal `deno.v0.json`, and has an
  eight-step upper bound. The live evaluator applies the narrower corpus case bounds of one to three.
- The adapter currently discards provider `usage`; actual token and billed-cost reporting is outside
  this increment.

## Scope and exclusions

Gate A scope is limited to canonical corpus/suite preflight, fresh per-case provider-model and
registry composition, a strict live report, a fixed-suite CLI, fake-fetch/dummy-credential tests,
Deno task/gate integration, an acceptance-results document, and bounded read-only review.

Out of scope:

- Gate A credential presence/value checks, real provider calls, or network access;
- changes to normal `agent:run`, basic/legacy/acceptance paths, corpus, scorer, offline report, model,
  endpoint, profile, tools, dependencies, or lockfiles;
- arbitrary task/subset/profile/endpoint/limit selectors, application retry, fallback, or rerun;
- response-usage parsing, actual token/cost collection, persistence, streaming, sessions, or state;
- rates, averages, confidence claims, pairwise comparisons, rankings, or prompt-quality conclusions;
- commit, push, tag, publish, release, archive changes, or `_refs/` changes/execution.

## Fixed suites and request ceilings

`sentinel_v1` contains exactly one canonical case from each category, retaining corpus-relative
order:

| Category | Exact task ID | Maximum requests |
| --- | --- | ---: |
| `character_count` | `v1.character-count.henji-chick.explicit` | 2 |
| `count_json_array_items` | `v1.count-json-array-items.complex.explicit` | 2 |
| `final_only` | `v1.final-only.echo` | 1 |
| `list_json_object_keys` | `v1.list-json-object-keys.fmt.explicit` | 2 |
| `multi_tool` | `v1.multi-tool.fmt.explicit` | 3 |
| `uppercase_text` | `v1.uppercase-text.ascii.explicit` | 2 |

The sentinel ceiling is `2 + 2 + 1 + 2 + 3 + 2 = 12` external requests.

`canonical_v1` uses all 24 validated cases without rewriting or reordering:

```text
4 final-only × 1 + 16 one-tool × 2 + 4 multi-tool × 3 = 48 requests
```

Suite construction must fail closed unless its exact IDs, order, category composition, case count,
and ceiling sum match these constants. The CLI accepts only literal `sentinel` or `canonical`; it has
no arbitrary selector.

## Execution and accounting contract

The runner performs all corpus, fixture, and suite preflight before constructing a registry, model,
credential source, or fetch. For each selected case it then:

1. constructs one fresh `createRuntimeRegistry()`;
2. constructs one fresh `OpenRouterAgentModel`;
3. calls `runAgent(task.prompt, model, registry, { maxSteps: task.maxRequests })` once;
4. converts the valid final transcript with the accepted `observationFromLoopOutcome`;
5. calls `scoreCorpusObservation` once and strictly validates the result;
6. records the case and proceeds according to the failure rules below.

No model, registry, transcript, call-ID state, or tool state is shared between cases. The runner does
not repair prompts, outputs, tool calls, or oracles.

A suite-scoped bounded fetch wrapper increments the external-request counter immediately before
delegating to the real fetch. It must not start another fetch after the fixed suite ceiling. The
per-case `maxSteps` bound is the primary request limiter; the suite wrapper is a fail-closed aggregate
backstop. Provider-internal routing/failover is not counted as Henji application retry evidence.

## Failure semantics

A valid final outcome that mechanically scores false is a case status `failed`; execution continues
through the selected suite. This includes wrong final text/JSON and forbidden, extra, missing,
misordered, or unsuccessful tool behavior represented by an otherwise valid transcript.

Evaluation-infrastructure failures abort immediately at the current case, record that case as
`error`, and mark only the remaining selected cases as canonical-order `not_run`. Allowlisted codes:

```text
corpus_preflight_failed
suite_contract_invalid
dependency_construction_failed
provider_invalid_input
provider_missing_credential
provider_transport_error
provider_http_error
provider_response_error
provider_limit_exceeded
external_request_ceiling
case_execution_failed
loop_contract_failure
loop_max_steps
loop_outcome_invalid
transcript_malformed
score_contract_invalid
report_contract_invalid
run_aborted
```

A thin tracking wrapper retains a typed `OpenRouterAgentError.code` internally. The runner must not
parse `runAgent`'s generic contract-failure string to guess a provider error. Preflight fatal errors
construct no case dependency and emit no full report; the CLI emits only a compact allowlisted error.
Raw errors, stacks, provider bodies, authorization data, or credential data never enter a result.

## Live report v1

The additive report contract is:

```ts
interface LiveCorpusEvalReportV1 {
  schemaVersion: 1;
  reportId: 'henji-live-corpus-eval-v1';
  mode: 'live_openrouter';
  suite: 'sentinel_v1' | 'canonical_v1';
  profile: {
    id: 'openrouter-google-gemini-3.7-flash-vertex-v0';
    model: 'google/gemini-3.7-flash';
  };
  corpus: { schemaVersion: 1; corpusId: 'henji-normal-cli-small-v1' };
  requestCeiling: 12 | 48;
  externalRequests: number;
  completion: {
    status: 'completed' | 'aborted';
    abortCode: LiveRunnerFailureCode | null;
    abortTaskId: string | null;
  };
  counts: {
    total: 6 | 24;
    completed: number;
    passed: number;
    failed: number;
    errors: number;
    notRun: number;
  };
  results: readonly LiveCorpusCaseResult[];
}
```

`passed`/`failed` contains task ID, status, final text, model request count, correlated tool events,
and the existing complete case score. `error` contains task ID, an allowlisted code, and only the
case's external-request count. `not_run` contains task ID and `run_aborted`.

Strict validation covers exact keys and constants, selected task order, counts/status partition,
score recomputation, abort suffix, per-case/suite counts, and the suite ceiling. The report contains
no timestamp, duration, endpoint, request/response body, header, raw transcript, raw tool arguments or
result text, exception/stack, `usage`, token, actual cost, rate, confidence, ranking, or pair result.

The CLI reads no stdin and writes no file. A valid report is one JSON line on stdout. A completely
passing report exits 0; a completed report with scored failures or an aborted report exits 1. A
preflight/serialization fatal leaves stdout empty and writes one compact error JSON line to stderr.

## Ordered Gate A implementation

### 1. Live contract and fixed suites

Add `v0/eval/live_corpus_runner.ts` with suite constants, types, failure taxonomy, request ceilings,
strict report validation, and serialization. Reuse the already-exported
`observationFromLoopOutcome`; do not change the offline source/report. If reuse requires an offline
contract change, stop and return a plan deviation.

### 2. Provider-aware fresh case execution

In the same runner, add full preflight, suite-scoped bounded fetch accounting, typed provider-error
tracking, fresh model/registry construction, per-task loop bounds, observation/scoring, ordinary
failure continuation, and error/not-run abort construction.

### 3. Fixed CLI

Add `v0/eval/live_corpus_cli.ts` with only the literal sentinel/canonical mode, stdout/stderr mapping,
and terminal exit behavior. It exposes no profile, endpoint, task ID, credential, or limit option.

### 4. Permission-free direct tests

Add `tests/v0/live_corpus_runner_test.ts`. All provider responses use fake fetch and all credentials
are non-secret injected dummy values. Tests receive no host environment or network permission.

The direct matrix must prove at least:

- exact six-case/12-request sentinel and exact 24-case/48-request canonical suites;
- zero model/registry/credential/fetch activity before complete preflight;
- completely passing sentinel and canonical runs through the real adapter/loop/registry/scorer;
- fresh per-case state and fixed request bodies/tool definitions;
- literal file boundary and one/two/three-request case accounting;
- suite counter increments only when delegate fetch starts and no fetch beyond the ceiling;
- valid scored failures continue, while every provider/loop/transcript/score/report class aborts;
- exact error plus canonical `not_run` suffix after abort;
- strict report round-trip, channel/exit behavior, redaction, and absent forbidden fields;
- only two CLI modes and no arbitrary runtime selectors;
- focused task has no env/net/write/run permission;
- offline report remains `henji-offline-corpus-eval-v1`, `offline_scripted`, and 24/24/24/0;
- no local gate invokes normal/acceptance/live production commands or writes persistent state.

### 5. Deno task and gate integration

Update `deno.v0.json` with conceptually exact tasks using the pinned Deno 2.9.4 binary:

```text
agent:corpus:eval:live:test
  deno test --no-prompt
  --allow-read=v0/corpus/task-corpus.v1.json,deno.v0.json
  tests/v0/live_corpus_runner_test.ts

agent:corpus:eval:live:sentinel
  deno run --no-prompt
  --allow-env=HENJI_OPENROUTER_API_KEY --allow-net=openrouter.ai
  --allow-read=v0/corpus/task-corpus.v1.json,deno.v0.json
  v0/eval/live_corpus_cli.ts sentinel

agent:corpus:eval:live:canonical
  deno run --no-prompt
  --allow-env=HENJI_OPENROUTER_API_KEY --allow-net=openrouter.ai
  --allow-read=v0/corpus/task-corpus.v1.json,deno.v0.json
  v0/eval/live_corpus_cli.ts canonical
```

Add new source/tests to `v0:check` and the permission-free focused test to `v0:gate`. Neither local
gate nor any existing test task may invoke either live task, `agent:run`, or `agent:acceptance`.

### 6. Evidence and review

Add `docs/plans/live-corpus-evaluation-results.md`, mapping requirements to direct evidence. The
repository owner alone updates phase/handoff state. Expected product changes are limited to the two
new eval files, one new test, `deno.v0.json`, and the results document.

After implementation, run:

```sh
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --config deno.v0.json agent:corpus:eval:live:test
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --config deno.v0.json agent:corpus:eval:test
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --config deno.v0.json agent:corpus:eval:offline
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --config deno.v0.json agent:corpus:test
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --config deno.v0.json agent:runtime:test
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --config deno.v0.json agent:transport:test
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --config deno.v0.json v0:check
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --config deno.v0.json v0:fmt
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --config deno.v0.json v0:lint
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --config deno.v0.json v0:test
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --config deno.v0.json v0:gate
git diff --check
```

Do not execute either live task, normal provider task, acceptance task, or credential check in Gate A.

The independent read-only review is bounded to 30 minutes and stops after 10 minutes without new
evidence. It traces preflight ordering, fresh state, fixed suites, adapter/loop/registry composition,
request ceilings, quality/provider failure separation, abort suffix, report redaction/schema, CLI
permissions, offline/normal-runtime preservation, and gate non-reachability. One changed-lines-only
re-review is limited to 15 minutes. Gate A requires zero remaining Blocker/P1/P2 findings.

## Gate B: one sentinel provider attempt

Only after Gate A's full local gate and review are GO, present a separate approval with exact readback:

```sh
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --quiet \
  --config deno.v0.json agent:corpus:eval:live:sentinel
```

The readback includes the exact six IDs, fixed profile/model/endpoint/method/stream/completion limit,
12-request maximum, application retry/fallback/rerun/follow-up all zero, plan SHA/revision, Gate A
state, stop conditions, output/redaction rules, and freshly verified official model availability,
tool support, and pricing with URL and timestamp. If official facts differ, do not run.

As observed on 2026-08-25 from the official model page
`https://openrouter.ai/google/gemini-3.7-flash` and official model/pricing-field documentation
`https://openrouter.ai/docs/guides/overview/models`, the current prices are USD 0.375/M input tokens
and USD 1.875/M output tokens. At the repository's 77,824-token conservative input bound and 1,024
completion-token bound:

```text
77,824 × 0.375 / 1,000,000 = USD 0.029184
 1,024 × 1.875 / 1,000,000 = USD 0.001920
current-price per-request bound = USD 0.031104
```

The accepted repository profile is more conservative: `worstCaseUsd = 0.062208` and authorization
limit `maxUsd = 0.064` per request. Gate B therefore uses the higher bound:

```text
12 × 0.062208 = USD 0.746496 repository worst case
12 × 0.064    = USD 0.768 authorization ceiling
```

This is an authorization ceiling derived from enforced bounds, not a provider-side spend limit.
Actual billed usage is not observed. If fresh pricing/support makes USD 0.064 per request
non-conservative, stop for a new decision.

The approved command itself may read exactly `HENJI_OPENROUTER_API_KEY`; no separate command may
display or probe credential presence/value. Missing credential aborts with zero requests and no
rerun. Provider/contract failure stops immediately. A scored failure continues only through the six
fixed cases, produces a report, and makes Gate C ineligible. The command is run at most once.

## Gate C: one canonical provider attempt

Gate C may be presented only if Gate B returns a valid `sentinel_v1` report that is completed with
6/6 passed, zero failed/error/not-run, no more than 12 requests, no leak, and no rerun. It requires a
new explicit approval and a fresh official profile/pricing readback.

```sh
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --quiet \
  --config deno.v0.json agent:corpus:eval:live:canonical
```

```text
Canonical request maximum: 48
48 × 0.062208 = USD 2.985984 repository worst case
48 × 0.064    = USD 3.072 authorization ceiling
```

Gate C is one command and one canonical traversal. Abort, partial completion, or scored failure never
triggers retry, rerun, or a follow-up attempt.

## Zot-first reference and explicit deviation

The first reference is Zot pinned at commit
`9b7bb6a4f36bc8c8deb2cc5796a8f557f4fb7479`:

- `_refs/zot/packages/agent/modes/print.go` runs noninteractive work to terminal completion and keeps
  final assistant text separate from presentation history;
- `_refs/zot/packages/agent/modes/json.go` represents assistant/tool events as machine-readable data;
- `_refs/zot/packages/agent/cli.go` (`runPrintMode`, `writePrintStats`) separates execution from
  post-success statistics;
- `_refs/zot/packages/provider/retry.go` retries transient failures twice, for three total attempts.

Henji adopts the separation of execution, transcript observation, scoring, and report presentation.
It does not adopt Zot streaming, sessions, usage/cost events, or persisted statistics here.

Application retry zero is an intentional Henji safety/evidence deviation: a failed provider attempt
must remain visible rather than being replaced by another application attempt, and fixed request/cost
ceilings remain directly attributable. OpenRouter-internal routing/failover is neither controlled nor
claimed as Henji retry-zero evidence.

## Completion, evidence, and rollback

Gate A completes only when the fixed suites/report are implemented, fake-fetch evidence proves fresh
real composition and 12/48 ceilings, all focused/regression/full gates and `git diff --check` pass,
credential/provider/persistence activity is zero, and review is GO with Blocker/P1/P2 zero.

Gate B completes only after one exact sentinel command returns a valid sanitized report. Gate C is
offered only after complete 6/6 sentinel success. Gate C records exact 24-case passed/failed counts
and evidence without deriving rates, confidence, or prompt/model-quality conclusions.

`docs/plans/live-corpus-evaluation-results.md` records plan SHA/revision, gate authorities reached,
requirement-to-file/test evidence, changed files, commands/counts/exits, suite IDs, official readback,
approved request/cost ceilings, observed external requests, case/count status, retry/persistence facts,
redaction checks, review, deviations, unperformed items, and remaining risks. It never records a
credential, Authorization header, provider body, raw exception, stack, or secret-bearing environment.

Rollback removes only the additive live runner/CLI/test/results, the Deno task/check/gate additions,
and lifecycle bookkeeping. It does not reset the worktree or touch the offline runner, corpus,
normal runtime, or `_refs/`. Provider observations and incurred cost are not reversible, which is why
Gate B and Gate C remain separate one-shot decisions.

Stop and return the cause, evidence, impact, proposed plan delta, verification, and required user
decision if implementation would require changing the corpus/scorer/offline report/normal runtime,
provider adapter/profile, usage parsing, selector/retry/fallback/persistence, request/cost ceiling, or
if current official availability/pricing conflicts with this plan.

## Human Gate A

**Approve only the local implementation, permission-free tests, full offline verification, results,
and bounded read-only review described above.** This approval does not include credential inspection,
network/provider execution, Gate B, Gate C, commit, push, tag, publish, or release.
