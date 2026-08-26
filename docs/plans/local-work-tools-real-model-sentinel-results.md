# Fixed local work-tools real-model sentinel — Gate L and Gate S results

## Scope and authority

- Plan: [`local-work-tools-real-model-sentinel.md`](local-work-tools-real-model-sentinel.md)
- Plan SHA-256: `feca254c45cc967bd4c9b089c460baba4f7d54a7b5a6cb98ff3914c404bf4e6e`
- Base revision: `d4504c4`
- Gate L: local implementation, dummy/fake-provider tests, offline gates, and bounded review.
- Gate S revision: `51916c8`
- Gate S: the separately authorized production command was executed exactly once. Dependency/
  lockfile, `_refs/`, push, tag, publish, and release operations remained outside scope.

## Implemented files

- `v0/agent/work_tools_sentinel.ts`: fixed task, exact five-call guarded model, pre-dispatch
  transcript/result causality checks, production model/loop/registry composition, strict terminal and
  workspace validators, and bounded sanitized child report.
- `v0/agent/work_tools_sentinel_launcher.ts`: one-shot zero-argument parent, existing
  `readCredential` reuse, mode-0700 disposable workspace lifecycle, exact child argv/env/stdio,
  bounded capture/deadline/kill/reap, strict child report parsing, independent workspace check, and
  cleanup override.
- `tests/v0/work_tools_sentinel_test.ts`: permission-free dummy credential seams, fake-provider
  causal success/failure, guard negative cases, launcher ordering, redaction, process/status,
  credential taxonomy, signal escalation, and cleanup regressions.
- `tests/v0/work_tools_sentinel_process_test.ts` and
  `tests/v0/fixtures/work_tools_sentinel_process_fixture.ts`: real embedded-Deno child boundary
  from an unrelated cwd with dummy secret-only environment, actual sentinel model/loop/registry
  execution through an in-memory fake provider, local workspace mutation, and preserved nonzero
  provider-failure evidence.
- `tests/v0/work_tools_sentinel_topology_test.ts`: focused permission and task/gate reachability
  assertions.
- `deno.v0.json`: focused local tasks, production-only credential task, check coverage, and gate
  inclusion. The production credential task is not in `v0:gate`.
- `README.md`: sentinel usage and Gate L/Gate S boundary section.

No existing runtime, model, loop, work-tool, corpus/eval source, or credential-launcher source was
changed. No dependency or lockfile was changed.

## Requirement evidence

| Requirement | Evidence |
| --- | --- |
| Exact fixed task and five-call order | `work_tools_sentinel_test.ts` fake provider and `GuardedModel` causal tests |
| Exact arguments and preceding result correlation | guarded request/transcript checks plus success fake body assertions |
| Hard five-request/five-call bound | sixth `generate` regression asserts delegate count remains five |
| Real production composition | child imports `OpenRouterAgentModel`, `runAgent`, `createProductionRegistry`, and `MAX_STEPS` |
| Exact terminal JSON and filesystem | child outcome and workspace validators; direct success test |
| Child report sanitization and failure evidence | strict report fields, raw-marker rejection, and valid nonzero provider-failure report preservation with `externalRequests:1` |
| Credential boundary and one child | launcher dummy filesystem seam, exact invocation assertions, preflight ordering test |
| Credential failure taxonomy | all existing `credential_*` codes map to parent `stage:"credential"` with no child/workspace access |
| Temp lifecycle and cleanup override | success, malformed output, spawn/status, and cleanup failure tests |
| Handled signal lifecycle | TERM-ignoring child regression proves prompt TERM → grace → KILL → reap and `child_signal` |
| Tool execution classification | expected correlated tool error maps to `tool_execution_failure` before any next fetch |
| Actual process boundary | embedded Deno fixture test with unrelated cwd and workspace-only read/write grants |
| Local topology | topology test and focused tasks in `v0:gate`; production task excluded |

## Local verification

The focused implementation tests pass:

| Command | Result |
| --- | --- |
| `agent:work-tools:sentinel:test` | 12 passed |
| `agent:work-tools:sentinel:process:test` | 2 passed |
| `agent:work-tools:sentinel:topology:test` | 1 passed |
| `v0:check` | passed |
| `v0:lint` | passed |
| `v0:fmt` | passed; 58 files checked |
| `v0:test` | 179 passed |
| `v0:gate` | passed; 179 tests in final full suite |
| `git diff --check` | passed |

The exact focused commands were:

```text
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --config deno.v0.json agent:work-tools:sentinel:test
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --config deno.v0.json agent:work-tools:sentinel:process:test
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --config deno.v0.json agent:work-tools:sentinel:topology:test
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --config deno.v0.json v0:check
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --config deno.v0.json v0:fmt
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --config deno.v0.json v0:lint
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --config deno.v0.json v0:test
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --config deno.v0.json v0:gate
git diff --check
```

The full gate uses only the repository-pinned Deno 2.9.4 binary. Initial independent review found
Blocker 0, P1 1, and P2 4; all five findings were fixed within the approved local scope. The bounded
changed-lines re-review is `GO` with Blocker/P1/P2 zero. The repository owner independently reran the
three focused suites and full 179-test gate successfully after review.

## Permission and safety matrix

- Direct suite: `/tmp` read/write and `/bin/bash` only; credential path, environment, network, and
  provider are not accessed. The fake provider is an in-memory `fetch` seam and the credential is a
  dummy string.
- Process suite: parent may run only the embedded Deno binary; the child fixture has read/write only
  on its disposable workspace and receives only the dummy `HENJI_OPENROUTER_API_KEY` value.
- Topology suite: reads only `deno.v0.json`.
- Production parent task: fixed credential read for the recorded external path, `/tmp` workspace
  read/write, embedded-Deno child run, and narrow `--allow-sys=uid`; no parent env/net/
  `/bin/bash` permission. It was run exactly once at Gate S.
- Retry, fallback, rerun, and follow-up: zero.

## Gate S one-shot outcome

The separately authorized credential-file task was executed exactly once from revision `51916c8`
and exited successfully. Its sanitized aggregate report established:

| Field | Result |
| --- | --- |
| Outcome | `passed` |
| Model requests / external requests | 5 / 5 |
| Tool calls / tool results | 5 / 5 |
| Tool order | `write`, `read`, `edit`, `bash`, `submit_json_result` |
| Stop reason | `tool_terminal` |
| Result | path `work/item.txt`, content `beta\n`, 5 bytes, Bash result `verified:5` |
| Workspace | final state verified; disposable workspace removed |
| Retry / fallback / rerun / follow-up | 0 / 0 / 0 / 0 |

The authorization ceiling was USD 0.320. Actual provider cost was not collected. No credential
value, provider response body, raw transcript, or raw tool argument/result was recorded, and the
successful one-shot was not rerun.

## Deviations, review, and remaining risk

- No plan or permission deviation was required during the local implementation. The previously
  accepted `--allow-sys=uid` requirement for the existing credential owner check is retained.
- Initial review disposition: NO-GO with Blocker 0 / P1 1 / P2 4. Fixes preserve valid nonzero child
  failure evidence, map credential errors, escalate handled signals immediately, classify expected
  correlated tool errors as execution failures, and clean up the cleanup-failure test harness.
- Changed-lines re-review: `GO`, Blocker 0 / P1 0 / P2 0. It directly reconfirmed valid nonzero
  failure evidence, credential taxonomy, prompt signal escalation/reap, execution-error classification,
  and zero remaining `henji-launcher-failure-*` directories.
- Gate S completed in its separately authorized one-shot with the aggregate result above. No retry,
  rerun, follow-up provider attempt, push, tag, publish, or release was performed.
- Accepted residual risks remain those in the plan: trusted-local unsandboxed Bash, same-user process
  environment observability, SIGKILL/VM-loss orphaned disposable directories, incomplete descendant
  containment, irreversible provider effects, and the fixed sentinel's limited adherence coverage.
