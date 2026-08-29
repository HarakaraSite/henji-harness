# Milestone 100 offline gate integrity hardening plan

## Decision summary

Concept **GO, initial Human Gate consumed/approved**.

This is the first bounded milestone 100 hardening increment. It removes the ambient all-permission
rerun from the repository's normal offline test gate and replaces it with one exact composition of
permission-bounded leaf test tasks. A new central topology test makes the test inventory and its
permission boundary fail closed as the suite evolves.

There is no product/runtime behavior change. The increment changes only task configuration, offline
gate topology evidence, and lifecycle documentation.

Planning baseline is commit `8a10be9` (`feat(v0): add bounded next-turn queue`). Its final offline
gate passes 503 tests with owner disposition Blocker/P1/P2 zero. The only baseline worktree entries
are existing user-owned untracked `_refs/` snapshots.

## Authority and rationale

The completed functional roadmap comprises cancellation, context management, persistent
session/history, tool progress, assistant streaming, bounded mid-turn steering, and the optional
bounded next-turn queue. The user selected milestone 100 hardening as the next phase and authorized
planning this increment.

Confirmed local evidence:

- `deno.v0.json` currently defines `v0:test` as one directory-wide test run with bare
  `--allow-read --allow-write --allow-run --allow-env --allow-net`;
- `v0:gate` repeats a changing subset of focused tasks, performs that broad rerun, and then runs
  further focused tasks, so its inventory and permissions are manually duplicated;
- the active direct inventory contains 44 `tests/v0/*_test.ts` files;
- 43 of those files are already owned by 41 permission-bounded focused test tasks; the three TUI
  unit files share `agent:tui:test`;
- `tests/v0/v0_test.ts` is the only direct test file without a focused task;
- the proposed bounded command for that legacy file passed locally 32/32. Its apparent
  `Deno.env.get` use is child-fixture source executed under the extension's denied permissions, so
  the parent test task needs no environment permission.

The current broad rerun is useful regression coverage but not a trustworthy least-authority gate:
an accidentally added filesystem, process, environment, or network dependency can pass silently.
Exact leaf composition preserves test coverage while making new capability requirements explicit.

## Scope

In scope:

- add one bounded leaf task for `tests/v0/v0_test.ts`;
- add one permission-bounded central offline-gate topology test and task;
- redefine `v0:test` as the exact ordered composition of all approved leaf test tasks;
- redefine `v0:gate` as an independent topology self-check followed by the exact composition of
  `v0:check`, `v0:fmt`, `v0:lint`, and `v0:test`;
- prove exact-once direct test-file coverage and least-authority task constraints;
- README, results, AGENTS, and handoff updates;
- local offline verification and bounded read-only review.

Out of scope:

- changes under product source `v0/` or to CLI/TUI/runtime/provider behavior;
- adding, removing, splitting, or semantically changing existing tests except for the new topology
  test and the reviewed topology-only expectation delta recorded below;
- changing existing focused-task permissions unless the central topology contract reveals a
  plan-level inconsistency before implementation approval;
- provider/network/credential/production commands or real persistent product state;
- dependencies, lockfiles, `_refs/`, archive, sibling repositories, CI/release workflows, commits,
  push, tag, publish, or release;
- Bash sandboxing or complete descendant containment, hostile same-user filesystem race defenses,
  directory-fsync durability, fuzzing, load/soak testing, or broader release hardening. These remain
  separately planned future hardening work.

## Task graph contract

All task invocations use the repository-pinned Deno 2.9.4 binary and `--no-prompt` for test
processes.

### Legacy leaf

Add exact task `v0:legacy:test`:

```text
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno test --no-prompt
  --allow-read=v0/extensions-src,/tmp
  --allow-write=/tmp
  --allow-run=/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno
  --allow-net=127.0.0.1
  tests/v0/v0_test.ts
```

The line wrapping above is explanatory; the JSON task value is one shell command. Network authority
is loopback-only for the existing local HTTP fixture. Process authority is only the pinned Deno
child used by the legacy runner tests. No environment or system-information permission is granted.

### Topology leaf

Add exact task `v0:offline-gate:topology:test`:

```text
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno test --no-prompt
  --allow-read=deno.v0.json,tests/v0
  tests/v0/offline_gate_topology_test.ts
```

The topology test may read only the task manifest and direct test directory. It performs no writes,
child process, environment read, system query, or network access.

### Full offline test task

Replace the broad `v0:test` command with an ordered `deno task --config deno.v0.json ...` chain.
The exact leaf set is 43 tasks, each referenced once:

```text
v0:offline-gate:topology:test
v0:legacy:test
agent:test
agent:definition:test
agent:definition-selection:test
agent:planner-delegation:test
agent:instructions:test
agent:instructions:topology:test
agent:skills:test
agent:skills:topology:test
agent:session:test
agent:session-store:test
agent:session:process:test
agent:session:tui:test
agent:sessions:test
agent:sessions:topology:test
agent:cancellation:test
agent:context:test
agent:steering:test
agent:tool-progress:test
agent:streaming:test
agent:transport:test
agent:runtime:test
agent:runtime:process:test
agent:work-tools:test
agent:tui:test
agent:tui:process:test
agent:tui:topology:test
agent:selection:test
agent:json-keys:test
agent:corpus:test
agent:corpus:eval:test
agent:corpus:eval:live:test
agent:corpus:eval:live:credential-launcher:test
agent:corpus:eval:live:credential-launcher:process:test
agent:corpus:eval:live:credential-launcher:topology:test
agent:work-tools:sentinel:test
agent:work-tools:sentinel:process:test
agent:work-tools:sentinel:topology:test
agent:planner-delegation:sentinel:test
agent:planner-delegation:sentinel:process:test
agent:planner-delegation:sentinel:topology:test
agent:acceptance:test
```

The order is stable evidence, not a promise that tests may share state. Every leaf must continue to
pass independently. `v0:test` must contain only these task calls and shell `&&`; it must not invoke a
test file, directory, glob, production task, or itself directly.

### Full repository gate

Replace the duplicated `v0:gate` body with exactly:

```text
deno task --config deno.v0.json v0:offline-gate:topology:test &&
deno task --config deno.v0.json v0:check &&
deno task --config deno.v0.json v0:fmt &&
deno task --config deno.v0.json v0:lint &&
deno task --config deno.v0.json v0:test
```

Each call uses the same pinned absolute Deno executable in the actual JSON value. `v0:gate` contains
no direct test target and no production/provider task. The independent first topology edge is
intentional: `v0:test` also contains the topology leaf so direct `v0:test` is complete, but removal
of that inner edge cannot prevent `v0:gate` from detecting the omission. A successful `v0:gate`
therefore executes every ordinary test file once and the topology file twice.

## Central topology test contract

Add `tests/v0/offline_gate_topology_test.ts`. It uses a deliberately small parser for the fixed task
grammar in this plan; unsupported quoting, substitution, redirection, pipeline, grouping, dynamic
target, or separator other than the expected `&&` fails closed. Expanding that grammar is a plan
delta, not an implementation convenience.

The test proves:

1. `v0:test` contains exactly the 43 named leaf tasks above, in the fixed order, with no duplicate,
   omission, extra task, recursion, directory target, glob, or dynamic target.
2. `v0:gate` contains exactly independent `v0:offline-gate:topology:test`, `v0:check`, `v0:fmt`,
   `v0:lint`, and `v0:test`, in that order and once each. The topology validator requires both its
   outer edge and its inner `v0:test` ownership edge.
3. Enumerating only direct regular `tests/v0/*_test.ts` files yields exactly 45 files after this
   increment, and every file occurs in exactly one leaf command. Multi-file ownership by
   `agent:tui:test` remains explicit and valid.
4. Every leaf command invokes the pinned Deno executable, uses `test --no-prompt`, and names one or
   more explicit direct test files.
5. Every leaf has the exact permission multiset assigned below. Added, removed, widened,
   reordered, duplicated, or reassigned permission flags fail, including a nominally allowlisted
   executable granted to the wrong leaf.
6. No leaf contains `-A`, `--allow-all`, `--allow-env`, `--allow-sys`, an unknown
   permission-capable flag, or a bare `--allow-read`, `--allow-write`, `--allow-run`, or
   `--allow-net`.
7. No leaf grants environment or system-information permission. The only network permission is
   `v0:legacy:test` with exact host `127.0.0.1`.
8. The graph cannot reach `agent:run`, `agent:tui`, `agent:sessions`, provider acceptance/live
   evaluation, credential-file launchers, or any other non-test/production task.

The test treats task names, complete explicit test targets, and exact permission multisets as
configuration contracts. A new direct test file or focused test task fails the topology test until
its ownership and exact permissions are reviewed and added explicitly.

### Exact per-leaf permission snapshot

The validator encodes these exact groups. An omitted flag also matters; no leaf may acquire even an
otherwise allowlisted permission without a reviewed plan update.

| Exact permission multiset | Leaf tasks |
|---|---|
| none | `agent:acceptance:test`, `agent:cancellation:test`, `agent:context:test`, `agent:corpus:eval:live:credential-launcher:test`, `agent:definition-selection:test`, `agent:definition:test`, `agent:instructions:test`, `agent:planner-delegation:test`, `agent:selection:test`, `agent:session:test`, `agent:skills:test`, `agent:steering:test`, `agent:streaming:test`, `agent:test`, `agent:tool-progress:test`, `agent:transport:test`, `agent:tui:test` |
| `--allow-read=deno.v0.json` | `agent:corpus:eval:live:credential-launcher:topology:test`, `agent:instructions:topology:test`, `agent:json-keys:test`, `agent:planner-delegation:sentinel:topology:test`, `agent:skills:topology:test`, `agent:tui:topology:test`, `agent:work-tools:sentinel:topology:test` |
| `--allow-read=v0/corpus/task-corpus.v1.json,deno.v0.json` | `agent:corpus:test`, `agent:corpus:eval:test`, `agent:corpus:eval:live:test` |
| `--allow-read=/tmp --allow-write=/tmp` | `agent:planner-delegation:sentinel:test`, `agent:session-store:test`, `agent:session:tui:test`, `agent:sessions:test` |
| `--allow-read=/tmp --allow-write=/tmp --allow-run=/bin/bash` | `agent:runtime:test`, `agent:work-tools:sentinel:test`, `agent:work-tools:test` |
| `--allow-read=/tmp --allow-write=/tmp --allow-run=<PINNED_DENO>` | `agent:planner-delegation:sentinel:process:test`, `agent:work-tools:sentinel:process:test` |
| `--allow-run=<PINNED_DENO>` | `agent:corpus:eval:live:credential-launcher:process:test` |
| `--allow-run=<PINNED_DENO> --allow-read=deno.v0.json,/tmp --allow-write=/tmp` | `agent:runtime:process:test` |
| `--allow-run=<PINNED_DENO>,/bin/sh --allow-read=/tmp,v0 --allow-write=/tmp` | `agent:session:process:test` |
| `--allow-read=deno.v0.json,v0/agent` | `agent:sessions:topology:test` |
| `--allow-run=/usr/bin/script` | `agent:tui:process:test` |
| `--allow-read=v0/extensions-src,/tmp --allow-write=/tmp --allow-run=<PINNED_DENO> --allow-net=127.0.0.1` | `v0:legacy:test` |
| `--allow-read=deno.v0.json,tests/v0` | `v0:offline-gate:topology:test` |

`<PINNED_DENO>` is exactly
`/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno`. Flag order is part of the current command
snapshot so the parser stays simple and drift is visible; an intentional reordering requires
updating the reviewed snapshot even when Deno semantics would be equivalent.

### Negative mutation evidence

The topology suite uses in-memory cloned manifest values and table-driven mutations; it never
rewrites `deno.v0.json`. Exact regressions must prove rejection of:

- removing either the outer `v0:gate` topology edge or inner `v0:test` topology leaf;
- an added, removed, widened, reordered, duplicated, or differently assigned permission flag;
- every forbidden grammar class: quoting, command substitution, variable expansion, redirection,
  pipe, grouping, newline/semicolon/alternate separator, and unexpected whitespace form;
- recursion or cycles in either composition;
- a directory, glob, dynamic target, extra positional test target, omitted target, duplicate target,
  unowned direct file, or non-direct test file;
- an extra, missing, duplicated, reordered, production, provider, live, or credential task edge.

## Planned files

- `deno.v0.json`: add two leaf tasks, add the topology file to `v0:check`, and replace `v0:test` /
  `v0:gate` composition.
- `tests/v0/offline_gate_topology_test.ts`: new central inventory and permission-boundary evidence.
- `tests/v0/agent_instructions_topology_test.ts`, `agent_skills_topology_test.ts`,
  `tui_topology_test.ts`, `work_tools_sentinel_topology_test.ts`,
  `planner_delegation_sentinel_topology_test.ts`, and
  `live_corpus_credential_launcher_topology_test.ts`: reviewed local plan delta replacing obsolete
  direct `v0:gate` leaf expectations with exact `v0:gate` → `v0:test` → leaf reachability only.
- `tests/v0/agent_runtime_process_test.ts`: the same reviewed delta applies only to its topology
  wiring assertions for `agent:runtime:process:test` and `agent:definition-selection:test`.
- `tests/v0/task_corpus_test.ts`: the same reviewed delta applies only to its topology wiring
  assertion for `agent:corpus:test`.
- `README.md`: document that offline tests are exact least-authority leaf composition and explain
  how a new direct test is enrolled.
- `docs/plans/milestone-100-offline-gate-integrity-results.md`: implementation and verification
  evidence.
- `AGENTS.md` and `.handoff/handoff.md`: lifecycle state and checkpoint only.

No product source file is planned.

## Implementation sequence

1. Reconfirm baseline commit/status and preserve untracked `_refs/`.
2. Add the legacy and topology leaf task definitions.
3. Implement the topology test, exact per-leaf command/permission snapshot, and synthetic negative
   mutations against the current inventory and fixed parser grammar.
4. Replace `v0:test` and `v0:gate` with their exact task compositions.
5. Run the focused topology and legacy tasks, then the complete local verification matrix.
6. Update README, results, AGENTS, and handoff with exact observed counts and deviations.
7. Perform initial read-only changed-lines review, one finding-closure pass if required, and one
   narrow re-review. Final owner verification closes any residual evidence-only finding.

## Verification and acceptance

Required commands, using the pinned binary and repository task configuration:

```text
deno task --config deno.v0.json v0:offline-gate:topology:test
deno task --config deno.v0.json v0:legacy:test
deno task --config deno.v0.json v0:test
deno task --config deno.v0.json v0:check
deno task --config deno.v0.json v0:fmt
deno task --config deno.v0.json v0:lint
deno task --config deno.v0.json v0:gate
git diff --check
```

Also rerun the existing task-topology leaves directly to ensure the central composition did not
mask a local topology regression. Do not run any production/provider/credential task.

Acceptance requires:

- all 45 direct test files are covered exactly once by the 43 leaf tasks;
- direct `v0:test` executes all 45 files once; `v0:gate` intentionally executes only the topology
  file a second time through its independent self-check edge;
- the former bare all-permission `v0:test` command and duplicated gate body are absent;
- `v0:test`, `v0:gate`, every leaf, and every leaf-owned file satisfy the central topology
  invariants;
- the legacy task passes under its exact bounded permissions;
- focused, full test, check, format, lint, diff, and final gate commands pass;
- README/results/lifecycle evidence matches actual counts and commands;
- independent disposition is GO with Blocker/P1/P2 zero.

## Review contract

Initial review is read-only and limited to 30 minutes. It must inspect the plan-scoped diff,
baseline task graph, test ownership, parser fail-closed behavior, permission sufficiency and
non-escalation, recursion/cycle risks, production/credential reachability, and whether eliminating
the broad rerun loses or duplicates any direct test.

The initial plan review found P1 2/P2 1: a self-omission blind spot, insufficiently leaf-specific
permission enforcement, and missing fail-closed parser mutation evidence. This revision closes them
with the independent outer topology edge, exact per-leaf permission snapshot, and table-driven
negative mutation contract. One narrow read-only plan re-review is required before the Human Gate.

### Reviewed local implementation delta

During implementation, the new 5-edge `v0:gate` exposed six existing feature topology tests whose
old assertions required their focused leaf directly in the manually duplicated gate. New central
topology passed 2/2 and legacy passed 32/32, but `agent:instructions:topology:test` demonstrated the
conflict with `0 !== 1`; implementation stopped before broadening scope.

A read-only delta review returned GO with Blocker/P1/P2 zero. Narrow follow-up reviews also returned
GO with Blocker/P1/P2 zero for the same obsolete assertions in `agent_runtime_process_test.ts` and
`task_corpus_test.ts`. The owner approves updating only these eight planned files so each proves:

- `v0:gate` calls `v0:test` exactly once;
- `v0:test` calls that feature leaf exactly once;
- any old source/test path assertion moves to `v0:check`;
- production/provider/credential task absence is retained across both compositions;
- command permissions, launcher separation, credential boundaries, and all unrelated assertions
  remain unchanged.

This is a local, reversible evidence-shape correction. It changes no Why/What/Whether, permission,
external contract, success condition, verification level, Human Gate, or product behavior. All six
feature topology tasks plus `agent:runtime:process:test` and `agent:corpus:test` must be rerun
directly before the full verification matrix.

The initial implementation review identified one P1 and three P2 evidence/validator findings. The
owner approved one bounded finding-closure pass: snapshot the exact maintenance-command topology,
restore exact-once assertions for the instructions and definition-selection leaves, and add direct
permission/cycle and production/provider/credential-chain mutations. No product behavior or task
contract changes are included in that closure.

One finding-closure implementation pass and one narrow changed-lines re-review of at most 15 minutes
are planned. Additional scope requires a new owner decision; Why/What/Whether, permissions, external
contracts, success criteria, or Human Gates cannot be changed locally.

## Human Gates

### Initial implementation gate — consumed/approved

The owner approved and consumed this gate for the planned repository-local configuration, topology
test, README/results/lifecycle changes, disposable local test state, full offline verification,
bounded review, and the single plan-scoped finding-closure pass described above.

It does not authorize product behavior changes, provider/network/credential/production operations,
real persistent product state, dependencies/lockfiles, `_refs/`, archive/sibling changes, commit,
push, tag, publish, or release.

### Commit and external gates

Commit remains a separate explicit user instruction after final GO. Any push, tag, publish, release,
or real-provider attempt remains a separate explicit Human Gate.

## Rollback and residual risk

Rollback restores the prior `deno.v0.json`, removes the new `offline_gate_topology_test.ts`, and
restores the eight reviewed topology-delta files (`agent_instructions_topology_test.ts`,
`agent_skills_topology_test.ts`, `tui_topology_test.ts`, `work_tools_sentinel_topology_test.ts`,
`planner_delegation_sentinel_topology_test.ts`, `live_corpus_credential_launcher_topology_test.ts`,
`agent_runtime_process_test.ts`, and `task_corpus_test.ts`) to their pre-increment expectations;
it reverts the README/results/lifecycle documentation as one change. No product or persisted-session
migration exists.

This increment hardens the declared offline gate, not the operating-system sandbox. Permission
allowlists prove the Deno task envelope but do not constrain capabilities intentionally delegated to
allowed child executables, especially trusted-local Bash and shell/process fixtures. Exact task
composition can also increase maintenance work when tests are added; that friction is intentional
review pressure. More complete process containment, filesystem race/crash hardening, fuzzing, and
release automation remain future milestone 100 candidates.
