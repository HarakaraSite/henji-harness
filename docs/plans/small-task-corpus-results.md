# Small task corpus results

## Scope and acceptance

The approved plan at `docs/plans/small-task-corpus.md` was implemented at its required SHA-256
`e582a02b80b12f9623c1a0cae949b7e2ce253b1828f300233e92e864c5e5fb39`. The implementation adds the
versioned JSON corpus at `v0/corpus/task-corpus.v1.json`, its strict loader/scorer, focused offline
tests, limited task/gate integration, and this evidence record. Product runtime files, production
task strings, dependencies, lockfiles, credentials, and `_refs/` were not changed.

The corpus is schema version 1, ID `henji-normal-cli-small-v1`, with 24 canonical tasks, six
balanced categories (four each), 10 explicit/implicit controlled pairs, and only the literal
`deno.v0.json` `fmt` and `lint` fixtures. Validation rejects unknown fields, widened paths, fixture
drift, malformed or unsafe oracles, matrix/pair/balance changes, and invalid tool/request
observations. Scoring is case-local and mechanical: exact text, whole-value JSON, correlated tool
events, required sequence, separate rounds, and request ceilings.

## Verification evidence

All commands used the repository's pinned Deno 2.9.4 binary.

| Command | Result |
| --- | --- |
| `deno task --config deno.v0.json agent:corpus:test` | 9 passed |
| `deno task --config deno.v0.json agent:runtime:test` | 14 passed |
| `deno task --config deno.v0.json agent:runtime:process:test` | 9 passed |
| `deno task --config deno.v0.json v0:check` | passed |
| `deno task --config deno.v0.json v0:fmt` | passed; 36 files checked |
| `deno task --config deno.v0.json v0:lint` | passed; 33 files checked |
| `deno task --config deno.v0.json v0:test` | 110 passed, 0 failed |
| `deno task --config deno.v0.json v0:gate` | 110 passed, 0 failed |
| `git diff --check` | passed |

The full gate also covered the existing offline suites: transport 10, agent loop 12, JSON-key 6,
fixed acceptance contract 10 (fake fetch only), and selection 8, in addition to the corpus 9,
process 9, runtime 14, and existing v0 tests.

The focused corpus command uses only `--allow-read=v0/corpus/task-corpus.v1.json,deno.v0.json`.
The gate directly asserts that provider `agent:run` and `agent:acceptance` tasks are not invoked and
that their production task strings remain unchanged.

## Boundary evidence and risks

- Provider/model/network/production command invocations: 0.
- Credential existence/value check or read: 0.
- Evaluation runner, aggregation, A/B comparison, live E2E, fuzz/load/soak: not implemented or run.
- One transient local config typo during implementation omitted `/2.9.4/` from nested gate task paths;
  it was corrected immediately, the focused corpus suite passed 9/9, and the final gate passed 110/110.
  This caused no plan, product, dependency, or runtime change.
- Initial bounded independent review was `NO-GO` on one P2: fixture IDs were syntactically restricted
  but not bound to their exact v1 object-key/key-list tuples. The fix binds `deno-v0-fmt` to
  `fmt`/`lineWidth,semiColons,singleQuote` and `deno-v0-lint` to `lint`/`rules`, with focused
  negative coverage for sorted tuple substitutions. The single changed-lines re-review confirmed
  the prior bypass now fails and returned `GO`, with Blocker/P1/P2 zero.

Remaining risks are the approved plan risks: a model can compute a literal answer without using the
required tool and therefore fail tool scoring; 24 cases provide only an initial signal; intentional
`fmt`/`lint` fixture changes stop validation until the corpus revision is updated; and no live model
quality or statistical evaluation is established by this increment.

## Future runner handoff

A later runner should validate this corpus once before provider/model construction, execute tasks in
canonical ID order with fresh runtime state per task, and pass the raw final text, request count, and
correlated tool events to `scoreCorpusObservation`. It must not correct prompts/oracles or aggregate
rates/pair comparisons in this increment. Provider authorization and credential handling remain a
separate human-gated decision.
