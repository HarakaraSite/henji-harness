# Provider-neutral cancellation implementation results

## Scope and authority

- Canonical plan: `docs/plans/provider-neutral-cancellation.md`
- Canonical plan SHA-256: `2e7de535ce3979f79b0d46515e076a67e9e76da6654c2cd0788e688e755bdfab`
- Implementation baseline: `962fa19ac5043791ec2c768c60e05fed231f2f19`
- Implementation revision: working tree based on that baseline; no commit was created
- One fresh cancellation owner and `AbortSignal` are allocated after each accepted session turn.
  Cancellation is synchronous/idempotent, arbitrates normal settlement, and a cleanup failure
  permanently poisons the owning session.

## Changed files

Product and test changes are limited to:

- `v0/agent/cancellation.ts`
- `v0/agent/contracts.ts`
- `v0/agent/execution_context.ts`
- `v0/agent/loop.ts`
- `v0/agent/openrouter_model.ts`
- `v0/agent/planner_delegation.ts`
- `v0/agent/runtime.ts`
- `v0/agent/session.ts`
- `v0/agent/skills.ts`
- `v0/agent/tools.ts`
- `v0/agent/tui_cli.ts`
- `v0/agent/work_tools.ts`
- `v0/tui/controller.ts`
- `tests/v0/agent_cancellation_test.ts`
- `tests/v0/agent_work_tools_test.ts`
- `tests/v0/fixtures/tui_process_fixture.ts`
- `tests/v0/tui_process_test.ts`
- `deno.v0.json`
- `README.md`

This is the exact implementation/test inventory. The approved canonical plan was created before
implementation, and the default agent separately owns the required `AGENTS.md` and
`.handoff/handoff.md` lifecycle updates. `_refs/`, archives, dependency files, and sibling
repositories were not changed.

## Contract evidence

The loop now emits exact `cancelled` outcomes with `ok: false`, no final/error fields, accurate
completed model/tool counters, defensive pre-cancellation drafts, and one last
`turn_end` carrying `committed: false`. Cancelled drafts are never committed; completed effects
are intentionally not rolled back. Tool dispatch rethrows cancellation and cleanup errors, keeps
interrupted batch results out of partial `ToolMessage` appends, and does not fabricate an
interrupted `tool_result`.

`ModelGenerateOptions.signal` and `ToolExecutionContext.signal` keep execution control separate
from request admission. Parent and planner child contexts carry the same signal object. Planner
cancellation is rethrown rather than wrapped as `planner_failed`; request lanes and one-child
admission remain unchanged.

OpenRouter checks cancellation before credential resolution/fetch, composes a per-call signal with
the existing timeout, distinguishes turn cancellation from timeout transport failure, and settles
every acquired response body by reading it to completion or awaiting body cancellation before
classification. Body cleanup failure after turn cancellation is the fixed `cancellation cleanup
failed` error; existing wire/profile, body/response bounds, credential timing, and zero-retry
behavior remain unchanged.

Read/skill, write/edit, terminal submission, Registry, and Bash observe the signal at effect
boundaries. Atomic replacement removes a pre-rename sibling temporary and preserves the target;
the post-rename race retains the completed visible effect while rolling back the turn draft; cleanup
failures use the fixed `cancellation cleanup failed` error. Bash cancellation uses the existing
direct-child TERM/grace/KILL path and awaits status reap and capture settlement. Timeout teardown
observes cancellation dynamically, so status/capture/owned cleanup failure after the request is
fatal. No process-group or descendant-containment claim was added.

Ordinary contract failures now use the same normal-settlement arbitration as successful outcomes;
a failure that wins leaves a later turn-end cancellation request idle, while a cancellation that
wins produces the cancelled outcome. The managed PTY fixture now supports cooperative cancellation,
OS signal delivery, delayed settlement, pending nonzero-signal cleanup failure, and fatal cleanup
precedence without changing permissions.

The TUI maps busy Escape to cooperative cancellation and same-session `ready`, busy Ctrl-C/SIGINT
to cancellation and exit 0, and busy SIGTERM/SIGHUP to cancellation and exit 143/129. Cancellation
requests and restore are idempotent; pending exit intent is monotonic and fatal cleanup failure
overrides it with the existing sanitized agent-failure path. Idle input, busy input discard,
terminal controls, and no-cancel CLI/TUI channels remain compatible.

## Verification

All commands used the repository-pinned Deno 2.9.4 binary from `deno.v0.json`.

- `agent:cancellation:test`: **18 passed, 0 failed**
- `agent:session:test`: **14 passed, 0 failed**
- `agent:test`: **22 passed, 0 failed**
- `agent:transport:test`: **16 passed, 0 failed**
- `agent:planner-delegation:test`: **16 passed, 0 failed**
- `agent:runtime:test`: **35 passed, 0 failed**
- `agent:runtime:process:test`: **18 passed, 0 failed**
- `agent:work-tools:test`: **19 passed, 0 failed**
- `agent:tui:test`: **30 passed, 0 failed**
- `agent:tui:process:test`: **15 passed, 0 failed**
- `agent:tui:topology:test`: **3 passed, 0 failed**
- `v0:check`: passed
- `v0:fmt`: passed (`Checked 93 files`)
- `v0:lint`: passed (`Checked 90 files`)
- `v0:test`: **377 passed, 0 failed**
- `v0:gate`: passed; final full suite **377 passed, 0 failed**, with the focused cancellation task
  present exactly once
- `git diff --check`: passed

The focused tests include pending model cancellation and fresh signal reuse, final-event and
mid-batch arbitration/counters, cleanup poisoning despite masked `turn_end` failure, exact
parent/child signal identity, planner admission, response-body cancel/read cleanup success and
failure, abort-ignoring body settlement, timeout classification, pre- and post-rename atomic write
behavior, timeout-first Bash cancellation and cleanup-failure races, busy Escape reuse, busy signal
exits/precedence, pending nonzero-signal cleanup failure, and fatal TUI cleanup. Work-tool tests
cover retained post-rename effects,
pre-rename target preservation, injected temp-cleanup failure, and direct-child TERM/KILL/reap.
Managed PTY process tests cover cooperative Escape/Ctrl-C, OS SIGINT/SIGTERM/SIGHUP settlement
ordering, pending nonzero-signal cleanup failure precedence, and fatal cleanup precedence. Existing
process/topology suites continue to pass.

## Review and deviations

The initial independent read-only review reported Blocker 0, P1 2, and P2 2. The single
changed-lines re-review closed the three implementation findings and reported Blocker 0, P1 0,
P2 2: pending nonzero-signal cleanup precedence still lacked PTY evidence, and this inventory
omitted the modified process test. The owner-final evidence closure added the exact SIGTERM/SIGHUP
fatal-precedence regression and corrected the inventory; focused and full gates pass afterward.
Final owner disposition is Blocker/P1/P2 zero. No material plan deviation was required. The fixes
preserve response-body ownership, dynamic Bash cleanup classification, normal contract-failure
arbitration, and managed PTY signal evidence within the approved contract.

No provider, network, credential read/probe, production `agent:run`/`agent:tui`, production
sentinel/launcher, dependency or lockfile, persistent-state, commit, push, tag, publish, release,
or `_refs/` operation occurred. The full gate exercised only its existing offline test fixtures.

## Rollback and remaining risks

Rollback is limited to removing the files and deltas listed above; it must preserve prior
multi-turn, TUI, Definition, delegation, work-tool, handoff, and reference state. Completed
filesystem, Bash, provider, and planner effects cannot be undone. Deno filesystem calls and
abort-ignoring adapters can delay safe settlement, arbitrary Bash descendants may survive direct
child cleanup, SIGKILL/process/VM/terminal-emulator failure remains unhandleable, and cancellation
adds no progress/streaming/steering/queue/persistence semantics.
