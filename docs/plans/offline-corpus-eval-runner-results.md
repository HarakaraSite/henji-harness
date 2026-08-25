# Offline corpus eval runner results

## Scope and outcome

The approved offline runner plan was implemented at SHA-256
`6522ef9e2ba83bd48c1b23f313de87b9897cb885d92107bfc3798713009d1e78`.
The slice adds a deterministic 24-case scripted model, a real `runAgent`/four-tool-registry
offline runner, strict report-v1 validation/serialization, a stdout-only CLI, focused tests, and
limited Deno task/check/gate integration. Corpus data, scorer, product runtime, provider adapter,
production task literals, dependencies, lockfiles, and persistent product state were not changed.

## Implemented evidence

- `v0/eval/scripted_corpus_model.ts` contains the exact canonical 24-task executable table. Each
  fresh model verifies the four advertised tool definitions, exact prompt/transcript prefix, and
  every preceding result's ID, name, text, and successful outcome. `assertScriptedCorpusTaskSet`
  binds the table's exact ordered ID set to the validated corpus before case dependencies exist.
- `v0/eval/offline_corpus_runner.ts` loads and validates the corpus once, constructs fresh model
  and real registry state per case, calls the existing loop once with `maxSteps: 8`, maps the strict
  transcript contract to zero-based tool events, scores once, and validates the complete report.
  Ordinary score failures continue; dependency, loop, transcript, score, and report contract
  failures abort with one sanitized error and canonical `not_run` suffix.
- `v0/eval/offline_corpus_cli.ts` accepts no arguments, emits exactly one JSON report line on
  stdout for valid runs, returns 1 for scored failures/abort reports, and emits one allowlisted
  compact error JSON line on stderr for fatal conditions.
- `tests/v0/offline_corpus_runner_test.ts` has 14 focused tests covering the positive 24-case
  matrix, exact script IDs and preceding-result checks, fresh per-case state and call-ID reset,
  ordinary failure continuation, all abort classes, preflight ordering and fixture drift,
  malformed transcript/correlation/counter cases, round ordinals, strict report rejection and
  serialization, CLI channels, production task preservation, and exact read-only task flags.

## Verification

All commands used the repository-pinned Deno 2.9.4 binary at
`/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno`.

| Command | Result |
| --- | --- |
| `agent:corpus:eval:test` | 14 passed, 0 failed |
| `agent:corpus:eval:offline` | exit 0; one JSON line; `completed`, counts `24/24/24/0` |
| `agent:corpus:test` | 9 passed, 0 failed |
| `agent:runtime:test` | 14 passed, 0 failed |
| `v0:check` | passed; 40 files checked |
| `v0:fmt` | passed; 40 files checked |
| `v0:lint` | passed; 37 files checked |
| `v0:test` | 124 passed, 0 failed |
| `v0:gate` | passed; focused eval 14, full v0 124, check/fmt/lint passed |
| `git diff --check` | passed |

The offline CLI report has schema version 1, report ID `henji-offline-corpus-eval-v1`, mode
`offline_scripted`, corpus ID `henji-normal-cli-small-v1`, completion `completed`, and no abort
metadata. Tool rounds are observed as ordinal 0 for single rounds and ordinals 0 then 1 for the
sequential two-round cases. The report contains no timestamps, duration, token, cost, rate,
ranking, or pair-comparison fields.

## Boundaries and review status

The eval runner and CLI use no provider adapter, fetch/network, environment credential source,
subprocess, stdin, file output, or persistent product write. Production `agent:run` and
`agent:acceptance` were not invoked; no credential existence/value was inspected; no dependency,
lockfile, commit, push, tag, release, or publish operation was performed. The full v0 suite's
existing test fixtures may exercise their own local test state, but the new eval path is state-free.

No plan deviation is intended. The exact script-table/corpus-set preflight assertion and explicit
focused gate invocation are within the approved contract and only strengthen its stated matrix and
gate requirements.

## Initial review and re-review status

The initial independent bounded read-only review was `NO-GO` with three P2 findings. All three were
fixed within the owned eval runner/test/results files:

1. Report validation accepted a retained score after `finalText`, `requestCount`, or `toolEvents`
   changed. Validation now reconstructs each passed/failed `CorpusObservation`, recomputes the
   fixed scorer result, and requires exact canonical score equality; focused negative cases cover
   all three mutations.
2. Assistant/request counter mismatches were classified as `transcript_malformed`. The mapper now
   classifies `assistantCount`, tool-call/result, and request-counter mismatches as
   `loop_outcome_invalid`, while preserving `transcript_malformed` for structural damage. Direct
   mapper and runner abort assertions cover both classes.
3. Focused coverage lacked a direct scorer exception (`score_contract_invalid`) and an aborted CLI
   report readback. The runner test now corrupts a scorer-required task field through the existing
   dependency seam to exercise the fixed scorer exception path, and the CLI test verifies an
   aborted report is emitted on stdout with exit 1.

The single changed-lines-only independent re-review confirmed all three P2 fixes and returned `GO`,
with Blocker/P1/P2 zero. Remaining approved risks are that scripted wiring does not measure
live-model quality, the script duplicates expected behavior, 24 cases cannot support statistical
claims, and intentional fixture changes require a corpus revision.
