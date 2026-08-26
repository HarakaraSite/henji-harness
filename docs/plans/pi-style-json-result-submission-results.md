# Pi-style terminal JSON result submission — implementation results

Plan: `docs/plans/pi-style-json-result-submission.md`

Approved plan SHA-256:
`56fcfc5044993db7ede70ed88ded5931cc15d8500869d7b94815e0e59bda143e`

## Scope and implementation

Implemented the provider-neutral terminal execution boundary and the fixed
`submit_json_result` tool. The normal registry now advertises, in sorted order:

```text
character_count
count_json_array_items
list_json_object_keys
submit_json_result
uppercase_text
```

The submission accepts only `{json: string}`, enforces 65,536 UTF-8 bytes before
parsing and after canonicalization, parses the complete string, rejects
non-finite values, and performs the standard parse/stringify round trip. A
successful sole terminal call records a correlated terminal tool result and
returns `outcome: final`, `stopReason: tool_terminal`,
`terminalKind: json_result` with no follow-up request. Mixed or multiple
terminal batches execute zero calls and emit one correlated continuing error per
call.

Corpus observation and scoring now keep the four domain tools separate from
`submission` evidence. JSON-oracle tasks require one successful submission;
exact-text tasks require no submission. Offline and live writers emit strict
report v2 while v1 report validators remain available for legacy
read/validation. The scripted model uses terminal submission for all 17 JSON
tasks and the assistant-final path for all seven text tasks.

## Changed files owned by this increment

- `v0/agent/contracts.ts`
- `v0/agent/tools.ts`
- `v0/agent/loop.ts`
- `v0/agent/runtime.ts`
- `v0/agent/runtime_cli.ts`
- `v0/corpus/task_corpus.ts`
- `v0/eval/scripted_corpus_model.ts`
- `v0/eval/offline_corpus_runner.ts`
- `v0/eval/offline_corpus_cli.ts`
- `v0/eval/live_corpus_runner.ts`
- `v0/eval/live_corpus_cli.ts`
- `tests/v0/agent_loop_test.ts`
- `tests/v0/agent_openrouter_model_test.ts`
- `tests/v0/agent_runtime_test.ts`
- `tests/v0/agent_runtime_process_test.ts`
- `tests/v0/fixtures/runtime_process_fixture.ts`
- `tests/v0/task_corpus_test.ts`
- `tests/v0/offline_corpus_runner_test.ts`
- `tests/v0/live_corpus_runner_test.ts`
- `tests/v0/json_object_keys_tool_test.ts` (necessary dispatch-wrapper
  compatibility)
- `tests/v0/two_tool_task_selection_test.ts` (necessary dispatch-wrapper
  compatibility)
- `README.md`
- this results document

The shared worktree also contains pre-existing changes owned by other work; they
were preserved. No corpus JSON, provider profile, endpoint, credential launcher,
dependency/lockfile, archive, `_refs/`, `.handoff/handoff.md`, or credential
document was changed by this increment.

## Verification

All commands below used the repository-pinned Deno 2.9.4 binary and exited 0.

| Command                                                       | Result                                  |
| ------------------------------------------------------------- | --------------------------------------- |
| `deno task --config deno.v0.json agent:test`                  | 20 passed                               |
| `deno task --config deno.v0.json agent:transport:test`        | 11 passed                               |
| `deno task --config deno.v0.json agent:runtime:test`          | 14 passed                               |
| `deno task --config deno.v0.json agent:runtime:process:test`  | 10 passed                               |
| `deno task --config deno.v0.json agent:corpus:test`           | 9 passed                                |
| `deno task --config deno.v0.json agent:corpus:eval:test`      | 14 passed                               |
| `deno task --config deno.v0.json agent:corpus:eval:offline`   | v2 completed 24/24/24/0; 17 submissions |
| `deno task --config deno.v0.json agent:corpus:eval:live:test` | 10 passed                               |
| `deno task --config deno.v0.json v0:check`                    | passed                                  |
| `deno task --config deno.v0.json v0:fmt`                      | passed; 49 files checked                |
| `deno task --config deno.v0.json v0:lint`                     | passed; 46 files checked                |
| `deno task --config deno.v0.json v0:test`                     | 154 passed                              |
| `deno task --config deno.v0.json v0:gate`                     | passed; 154 tests in final full suite   |
| `git diff --check`                                            | passed                                  |

The focused process suite includes canonical JSON stdout from a terminal
submission and retains the unchanged assistant-text and sanitized failure
channels.

## Evaluation evidence

- Offline CLI report ID: `henji-offline-corpus-eval-v2`.
- Offline report: schema v2, completed, total 24, completed 24, passed 24,
  failed 0. The source partition is 17 `json_result` submissions and seven
  assistant-final text completions; domain `toolEvents` contain only the four
  corpus tools. Domain request ceilings remain 1/2/3 by corpus category and a
  submission replaces the former final request.
- Live fake sentinel report ID: `henji-live-corpus-eval-v2`, suite
  `sentinel_v1`, 6/6 passed, 12/12 external-request ceiling.
- Live fake canonical report ID: `henji-live-corpus-eval-v2`, suite
  `canonical_v1`, 24/24 passed, 48/48 external-request ceiling.
- Five advertised tool definitions and terminal transcript transport were
  exercised through the fake OpenRouter adapter. No provider-specific schema,
  strict-schema option, response-format field, prompt rewrite, or task-profile
  selector was added.

## Plan delta

`v0/agent/two_tool_task_selection.ts` has one accepted compile-only
compatibility edit: its existing counting wrapper now forwards the expanded
`Tool.execute` return union without changing runtime behavior. The file was not
in the plan's owned implementation list, but the change is required for the
repository check gate after the generic terminal contract extension. Together
with the two test wrapper updates listed above, this is a local plan-compatible
dispatch-shape delta: it adds no permission, dependency, provider, corpus,
scorer, or external contract.

## Review chronology and final owner gate

The initial independent review was NO-GO with Blocker/P1 zero, four P2 findings,
and a verification gap. The implementation fixes were then checked by one
changed-lines re-review. That re-review confirmed all implementation defects and
the terminal test gap were resolved, but found one remaining P2: the
abort-prefix regression tests did not source an abort at task index one or
later.

The final test-only fix adds exact offline and live task-index-1 cases with a
retained abort error, consistent counts/request accounting, and an earlier
passed result mutated to `not_run`. The complete fix evidence is:

- terminal transcript mapping now requires the exact `{json: string}` call,
  fixed `json result submitted` acknowledgement, bounded finite whole-value
  parse, and canonical JSON equal to `LoopOutcome.finalText`;
- V2 submission ordinals must be `requestCount - 1` and strictly follow every
  domain event;
- offline/live V2 aborted reports require a passed/failed prefix, exactly one
  abort error at `abortTaskId`, and only `run_aborted` not-run suffix entries;
- offline/live validator regressions now source an abort at task index 1 and
  adjust counts/request accounting before mutating the earlier passed result to
  `not_run`, directly exercising the prefix invariant;
- direct loop regressions cover multiple and terminal-plus-unknown batches,
  terminal contract mismatches, and failed/throwing terminal recovery.

The mapper and V2 report invariants are covered by the focused offline suite (14
passed) and live fake suite (10 passed). The re-review found Blocker/P1 zero and
P2 one before this final test-only fix; no reviewer GO is claimed. Final owner
verification inspected both task-index-1 regressions, reran agent 20, offline
14, live fake 10, the offline v2 CLI, and the full 154-test gate, and confirmed
format, diff, plan SHA, corpus, and lockfile boundaries. All passed, so the
repository owner closes the remaining test-only P2 with Blocker/P1/P2 zero. No
provider, network, credential, production, or persistent-state operation was
used.

## Safety and unperformed work

Provider/network calls, credential reads or probes, live sentinel/canonical
provider tasks, credential-launcher production tasks, `agent:run`, and
`agent:acceptance` were not run. No commit, push, tag, publish, release, or
persistent state migration was performed. No raw credential/provider material is
recorded.

The local implementation gate is complete. Deferred risks remain real-model
adherence, provider availability/cost behavior, broader structured-output
schemas, streaming and sessions, persistence, arbitrary-precision numbers,
retry/fallback, and aggregation/statistics.
