# Live corpus evaluation Gate A results

## Authority and boundary

- Plan: `docs/plans/live-corpus-evaluation.md`
- Plan SHA-256: `700d8427a9ea976d454d6b2d88d3f4920575ddd2447fb96122d5cd9e10400ef8`
- Repository phase: Revision 15, Gate A local implementation approved and completed.
- Gate A only: no credential lookup, provider request, network access, live task, commit, push,
  release, persistence, dependency, corpus, scorer, offline-contract, normal-runtime, adapter, or
  profile change.

## Implemented scope

| Requirement | Evidence |
| --- | --- |
| Fixed `sentinel_v1` and `canonical_v1` suites | `v0/eval/live_corpus_runner.ts`; direct suite tests prove 6/12 and 24/48 in canonical order. |
| Complete corpus/fixture/suite preflight before case dependencies | `runLiveCorpusEval`; preflight test observes zero model, registry, credential-source, and fetch activity. |
| Fresh fixed runtime composition per case | Each case creates a new `createRuntimeRegistry()` and `OpenRouterAgentModel`; direct test observes 6/24 distinct instances and fixed four-tool request definitions. |
| Per-case bounds and suite request backstop | `runAgent(..., { maxSteps: task.maxRequests })` plus bounded fetch wrapper; observed sentinel 12 and canonical 48 external requests. |
| Typed provider failure separation | `OpenRouterAgentError.code` is retained through a thin tracking model and mapped to the allowlisted provider codes without parsing generic loop text. |
| Scored-failure continuation and infrastructure abort | Direct tests prove a scored failure completes the suite, while provider/loop/transcript failures produce the exact error and canonical `not_run` suffix. |
| Strict sanitized report and fixed CLI | Strict report validation/recomputation and one-line stdout/compact stderr behavior are tested; no raw transcript, arguments, result text, provider body, stack, usage, or cost fields are emitted. |
| Permission-free local test task and gate integration | `agent:corpus:eval:live:test` grants only the two canonical read paths; new source/test files are in `v0:check` and the focused test is in `v0:gate`. |
| Offline behavior preserved | Focused direct test and offline task report retain `henji-offline-corpus-eval-v1`, `offline_scripted`, and 24/24/24/0. |

## Review delta

The initial bounded read-only review was `NO-GO` with four P2 findings. All four were fixed within
the approved ownership and covered by direct tests:

1. Strict report validation now requires `externalRequests` to equal the sum of completed-case
   request counts and error-case external counts; completed and aborted count/suffix mutations are
   rejected.
2. CLI stdout/stderr use a bounded full-write loop over Deno byte writers; the direct matrix feeds a
   partial byte writer and verifies the complete line is emitted.
3. `OfflineCorpusEvalError` from `observationFromLoopOutcome` is preserved, distinguishing
   `loop_outcome_invalid` from `transcript_malformed`.
4. The direct matrix now covers provider invalid-input, missing-credential, transport, response, and
   limit failures; the aggregate ceiling no-delegate boundary; loop contract/max-step; score/report
   aborts; count/abort-suffix mutations; completed-failed and aborted CLI exits; and v0:gate
   non-reachability.

The single changed-lines-only re-review confirmed all four fixes and returned `GO`, with
Blocker/P1/P2 zero. A permission-free diagnostic additionally confirmed that both top-level and
error-case request-count mutations in an aborted report fail with `report_contract_invalid`.

## Verification

All commands below used `/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno`. Every command
exited 0 unless stated otherwise; no live, normal-provider, or acceptance production task was run.

| Command | Result |
| --- | --- |
| `deno task --config deno.v0.json agent:corpus:eval:live:test` | 10 passed, 0 failed |
| `deno task --config deno.v0.json agent:corpus:eval:test` | 14 passed, 0 failed |
| `deno task --config deno.v0.json agent:corpus:eval:offline` | One completed report: total 24, completed 24, passed 24, failed 0 |
| `deno task --config deno.v0.json agent:corpus:test` | 9 passed, 0 failed |
| `deno task --config deno.v0.json agent:runtime:process:test` | 9 passed, 0 failed |
| `deno task --config deno.v0.json agent:runtime:test` | 14 passed, 0 failed |
| `deno task --config deno.v0.json agent:transport:test` | 10 passed, 0 failed |
| `deno task --config deno.v0.json v0:check` | Type check passed |
| `deno task --config deno.v0.json v0:fmt` | 43 files checked |
| `deno task --config deno.v0.json v0:lint` | 40 files checked |
| `deno task --config deno.v0.json v0:test` | 134 passed, 0 failed |
| `deno task --config deno.v0.json v0:gate` | All checks passed; focused 14+10 tests and full 134-test suite passed |
| `git diff --check` | Passed |

The focused live test uses only fake fetch responses and a non-secret injected dummy credential. It
does not read host credentials, call a provider, open a network connection, write persistent state,
or spawn a process. Full `v0:test` and `v0:gate` intentionally retain their pre-existing broad test
permissions for unrelated regression coverage; the new focused task remains permission-free.

## Gate status and unperformed items

- Gate A: complete; local implementation, verification, and bounded read-only review are `GO`.
- Gate B sentinel provider attempt: authorized and executed exactly once at 2026-08-25 22:03 JST.
  The command emitted one sanitized `sentinel_v1` report and aborted before any external request with
  `provider_missing_credential` on `v1.character-count.henji-chick.explicit`. Counts were total 6,
  completed 0, passed 0, failed 0, errors 1, and not-run 5; `externalRequests` was 0. The remaining
  five exact sentinel cases were marked `run_aborted`. No retry, rerun, fallback, or follow-up was
  performed.
- Gate C canonical provider attempt: not authorized and not run.
- The public Gate B documentation preflight was read back from official OpenRouter pages at
  2026-08-25 21:24 JST. The exact slug remains `google/gemini-3.7-flash`, tool calling remains
  supported, current routed headline pricing is USD 0.375/M input and USD 1.875/M output, and the
  listed Google AI Studio fallback is USD 0.75/M input and USD 3.75/M output. The repository's
  USD 0.064 per-request authorization ceiling covers that higher listed provider at the enforced
  token bounds. Sources: `https://openrouter.ai/google/gemini-3.7-flash` and
  `https://openrouter.ai/docs/guides/overview/models`.
- No aggregation, statistics, persistence, usage, token, cost, rate, confidence, ranking, or quality
  conclusion was produced.

The exact Gate B command was:

```sh
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --quiet \
  --config deno.v0.json agent:corpus:eval:live:sentinel
```

Because the sentinel did not complete 6/6, Gate C is ineligible under the approved plan. Credential
location/value was not inspected, displayed, copied, or recorded. A credential remediation or a new
sentinel attempt requires a separate plan and explicit authorization; this Gate B is consumed.

## Changed files

- `v0/eval/live_corpus_runner.ts`
- `v0/eval/live_corpus_cli.ts`
- `tests/v0/live_corpus_runner_test.ts`
- `deno.v0.json`
- `docs/plans/live-corpus-evaluation-results.md`

No credential, authorization value, provider response body, raw exception, stack, or secret-bearing
environment value is recorded here.
