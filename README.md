# Henji Harness

Henji Harness is a small trusted-local Deno agent harness. The active pre-alpha implementation is
the `v0` tree; older implementations and stopped experiments are retained under `archive/` only as
historical evidence.

## Current implementation

- Product source: [`v0/`](v0/)
- Tests: [`tests/v0/`](tests/v0/)
- Task configuration: [`deno.v0.json`](deno.v0.json)
- Current plans and results: [`docs/plans/`](docs/plans/)
- Resume state: [`.handoff/handoff.md`](.handoff/handoff.md)

Use the exact Deno 2.9.4 binary embedded in `deno.v0.json`. The main local commands are:

```text
deno task --config deno.v0.json agent:fixture
deno task --config deno.v0.json agent:test
deno task --config deno.v0.json agent:transport:test
deno task --config deno.v0.json agent:acceptance:test
deno task --config deno.v0.json agent:selection:test
deno task --config deno.v0.json v0:check
deno task --config deno.v0.json v0:fmt
deno task --config deno.v0.json v0:lint
deno task --config deno.v0.json v0:test
deno task --config deno.v0.json v0:gate
```

`agent:acceptance` is the production provider task. It is not a local test and must not be run
without a separate explicit user instruction. Local gates use fixtures and require no credential.

## Current baseline

Roadmap steps 8–10 are complete. Step 8 added deterministic `character_count` beside `uppercase_text` and enforces selection
of the task-matching tool. Before the cleanup, selection direct tests passed 8 cases, the full v0
suite passed 72 tests, and check, format, lint, gate, and diff check passed. The post-implementation
review found no Blocker or P1 and one P2 for a missing negative test. The later local-fix added a
well-typed but incorrect fixed `text` value to the negative table; direct selection and full offline
gates pass with the regression covered.

Roadmap step 9 adds `list_json_object_keys` and completed one real task against `deno.v0.json`:
the model selected the tool once and returned the 12 task names. The first result differed from the
compact tool JSON only by whitespace, so completion now compares the parsed string arrays. No retry
or second provider attempt was made; the current full local suite passes 78 tests.

Roadmap step 10 combines `list_json_object_keys` with `count_json_array_items`. A real model used
the two tools in order over three requests and returned `{"count":12}`. The first attempt stopped
after the list because character counting was not a natural continuation; the task was corrected to
count JSON-array items, then completed without further changes.

The active step 5–10 evidence is retained in `docs/plans/`. Roadmap step 11+, broad practical
filesystem/shell/network tools, sessions, context management, skills, extensions, RPC, subagents,
self-revision, dependency changes, credential access, and additional provider calls are outside the
current scope.

## Archive

[`archive/`](archive/) is not active product source and is excluded from normal v0 commands:

- `archive/legacy-two-plugin/`: stopped source-direct two-plugin implementation and tests.
- `archive/safety-spikes/`: Spike 0–2 source, tests, configs, scripts, and evidence.
- `archive/history/`: superseded pre-alpha plans and results.

Do not import from, execute, or resume archived code without a new explicit decision. See
[`archive/README.md`](archive/README.md) for the retention boundary.

## Reference snapshots

[`_refs/`](_refs/) contains pinned read-only upstream snapshots used for comparison. It is not
product source, a dependency, or part of the archive cleanup. Its contents and pinned commits remain
unchanged.
