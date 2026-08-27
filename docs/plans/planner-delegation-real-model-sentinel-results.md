# Fixed planner delegation real-model sentinel results

## Gate L scope

- Plan: `docs/plans/planner-delegation-real-model-sentinel.md`
- Plan SHA-256: `a6e0ccc655411ebb3b2d0700cca6f3ce3f767648e69297423c8361c364a0b07c`
- Baseline revision: `e4e3acf` (`feat(agent): add definitions and planner delegation`)
- Gate: local implementation and offline verification only; Gate S was not authorized or run.

## Implementation

The dedicated acceptance child composes the existing `runRuntime`, built-in default selection,
OpenRouter adapter, production registry, planner delegation, and a sentinel-only guarded fetch. The
guard proves the exact parent/child/parent request order, parent six-tool and planner two-tool
registries, planner instruction/transcript isolation, one delegation result, and the terminal parent
final before any underlying fetch is allowed to start. The child accepts no application arguments
and emits only a bounded sanitized JSON report.

The launcher reuses the existing credential reader without changing it. It creates one canonical
mode-0700 empty workspace, passes one credential environment variable to one clear-environment
child, bounds the two output channels and child lifetime, terminates and reaps bounded children,
independently verifies the workspace, and removes the owned workspace on every path. Child output
and launcher reports contain no raw provider, credential, transcript, argument, call-id, or path
evidence.

## Files

- `v0/agent/planner_delegation_sentinel.ts`
- `v0/agent/planner_delegation_sentinel_launcher.ts`
- `tests/v0/planner_delegation_sentinel_test.ts`
- `tests/v0/planner_delegation_sentinel_process_test.ts`
- `tests/v0/planner_delegation_sentinel_topology_test.ts`
- `tests/v0/fixtures/planner_delegation_sentinel_process_fixture.ts`
- `deno.v0.json`
- `README.md`
- `docs/plans/planner-delegation-real-model-sentinel-results.md`

## Gate L evidence

Focused tests completed locally with the repository-pinned Deno 2.9.4:

```text
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --config deno.v0.json agent:planner-delegation:sentinel:test
15 passed
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --config deno.v0.json agent:planner-delegation:sentinel:process:test
2 passed
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --config deno.v0.json agent:planner-delegation:sentinel:topology:test
1 passed
```

The owner full offline gate command was:

```text
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --config deno.v0.json v0:gate
```

It passed all configured checks, format/lint, focused suites, and the full `tests/v0` suite: 344
tests passed. The Gate L focused suites were 15 direct, 2 process, and 1 topology test. `git diff
--check` also passed. No production provider command, credential-file task, network request,
dependency or lockfile operation, persistent-state operation, `_refs/` operation, commit, push, tag,
publish, or release was performed for Gate L.

## Requirement evidence

| Requirement | Evidence |
| --- | --- |
| Fixed parent/child/parent causal contract and 2/1/3 bound | guarded-fetch success test, exact request order/counters, and fourth-request regression |
| Exact parent and planner tool topology with transcript isolation | direct fake-provider request-body assertions and six/two registry test |
| Fail-closed provider/adherence/delegation/final/workspace validation | wrong-tool, early-final, wrong-final, provider-failure, and workspace tests |
| Sanitized child success/failure report | strict parser, impossible-tuple rejection, marker-redaction, and nonzero-child tests |
| Credential/child/workspace lifecycle boundary | exact invocation, one credential read, pre-spawn signal registration, pending-status TERM/KILL, and cleanup tests |
| Partial workspace cleanup on setup failure | injected chmod, realpath, and validation failure cases verify removal of the created directory |
| Embedded process boundary and local task topology | process fixture/tests and topology test; production task is excluded from `v0:gate` |

## Initial review fixes and changed-lines evidence

The initial independent review was `NO-GO` with Blocker 0 / P1 0 / P2 5. All five findings were
fixed within the approved Gate L files without changing the request contract, permissions, or Human
Gate boundary:

1. Child status handling now uses bounded post-TERM and post-KILL waits and bounded capture release;
   the direct regression uses a permanently pending status and proves deadline, `SIGTERM`, `SIGKILL`,
   and prompt return.
2. `SIGHUP`/`SIGINT`/`SIGTERM` handlers are installed before child spawn; the exact invocation test
   asserts all three registrations are visible before `spawn`.
3. Workspace creation removes the directory if chmod, canonicalization, or validation fails before
   returning; injected direct cases verify all three failure points.
4. Strict failure parsing now rejects inconsistent completion/transcript tuples and any report that
   claims planner mutation or recursion; direct parser regressions cover both impossible forms. The
   final narrow tuple fix keeps legitimate third-phase failures with `plannerFinalValidated` and
   `childCompletedBeforeParentFinal` intact while preserving their allowlisted code and count.
5. The fourth-request regression first replays three valid guarded phases, then proves the fourth
   request is rejected before the underlying fetch is called.

The single changed-lines re-review then found one remaining P2 in the failure-tuple implication
above. The direct parser/launcher regression now covers both request-3 `provider_failure` and
`parent_final_mismatch`, preserving `externalRequests: 3`. Final owner closure is Blocker 0 / P1 0 /
P2 0. Changed-lines verification after all fixes: direct 15 passed, process 2 passed, topology 1
passed, and the full offline gate 344 passed / 0 failed.

## Deviations and remaining risk

No plan deviation was required. The sentinel is a fixed causal acceptance task and does not prove
general planner quality. A same-user process can observe the child environment, and crash-time
temporary workspace residue remains a bounded operational risk. Gate S remains a separate Human Gate
and has not been attempted.
