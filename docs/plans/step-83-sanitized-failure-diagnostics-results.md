# Step 83 sanitized failure diagnostics — implementation results

Status: **implemented; Product and Evidence findings closed; offline verification complete**

This package records the bounded Human Gate 2 implementation, read-only review and owner verification.
The canonical plan is
[`step-83-sanitized-failure-diagnostics.md`](step-83-sanitized-failure-diagnostics.md), based on
concept revision 41 and the approved Human Gate 2 implementation context.

## Implemented increment

- `v0/agent/failure_diagnostic.ts` defines the immutable schema-v1 allowlist, exact compact codec,
  bounds/invariants, safe formatter projection, typed failure facts, and the complete finite parser
  refusal inventory.
- OpenRouter, loop, runtime, planner, and session paths preserve typed stage/code/status/reason,
  occurrence-bound fetch counts, one shared parent/planner record, and persistence-before-publish
  lifecycle ordering. Post-HTTP body/SSE acquisition failures retain `response_parse`, status, and
  `response_stream_failed`; persistence failure retains the same live record with a fixed store
  error and remains recoverable/non-evaluable. Failed turns remain uncommitted and empty session
  cleanup remains unchanged.
- `v0/agent/failure_diagnostic_store.ts` provides workspace-partitioned 0700/0600 atomic storage,
  strict 16-record/16-KiB capacity, nonblocking locking, collision/corruption/mode/owner/symlink/
  temporary-file rejection, and no automatic eviction.
- The diagnostic CLI and launchers provide read-only `list`, `latest`, and `show --id UUID` plus
  exact confirmed `delete --id UUID --yes` permissions. Readback does not initialize provider,
  credential, tool, session, or context paths; deletion is limited to the selected record and fixed
  diagnostic lock.
- The presentation adapter and retained TUI render one safe `failure>` line (including canonical
  `occurredAt`) and exact readback command from the same immutable ID. Duplicate IDs update
  durability/error state without adding entries. Production-shaped offline PTY evidence uses the
  real runtime/session lifecycle for success, durable persistence, recovery, Ctrl-D discard/exit,
  terminal restoration, empty-session cleanup, capacity failure, post-exit readback, restart
  readback, and private-marker absence.
- `deno.v0.json`, offline topology inventories, and boundary inventories now own all five diagnostic
  leaves and all new source/test check targets. The direct test inventory is 70 files, each owned
  exactly once.

## Focused evidence

All listed tests were run against disposable roots and fake/offline seams only. Each count is
passed/failed.

| Task | Result |
| --- | ---: |
| `agent:failure-diagnostic:test` | 13/13 |
| `agent:failure-diagnostic-store:test` | 16/16 |
| `agent:failure-diagnostic-cli:test` | 4/4 |
| `agent:failure-diagnostic-cli:process:test` | 2/2 |
| `agent:failure-diagnostic-cli:topology:test` | 2/2 |
| `agent:transport:test` | 20/20 |
| `agent:test` (loop) | 26/26 |
| `agent:runtime:test` | 51/51 |
| `agent:runtime:process:test` | 18/18 |
| `agent:planner-delegation:test` | 16/16 |
| `agent:session:test` | 15/15 |
| `agent:session-store:test` | 20/20 |
| `agent:session:process:test` | 3/3 |
| `agent:sessions:topology:test` | 2/2 |
| `agent:session:tui:test` | 9/9 |
| `agent:cancellation:test` | 18/18 |
| `agent:streaming:test` | 17/17 |
| `agent:tui:test` | 119/119 |
| `agent:tui:process:test` | 36/36 |
| `agent:portable-tui:process:test` | 2/2 |
| `agent:tui:topology:test` | 6/6 |
| `agent:ui-presentation:test` | 24/24 |
| `agent:ui-boundary:topology:test` | 3/3 |
| `v0:offline-gate:topology:test` | 2/2 |

The existing fixture diagnostic case remains 1/1, and the production-shaped runtime diagnostic
cases are independently filtered as 2/2 within `tests/v0/tui_process_test.ts`; the full TUI
process leaf above is the authoritative process count.

Configured quality checks completed after the inventory and formatting updates:

- `deno task --config deno.v0.json v0:check`: green;
- `deno task --config deno.v0.json v0:fmt`: green;
- `deno task --config deno.v0.json v0:lint`: green;
- `bash -n v0/agent/failure_diagnostic_cli_launcher.sh v0/agent/session_launcher.sh v0/agent/henji_machine_launcher.sh`: green;
- `git diff --check`: green.

## Product versus evidence status

Product behavior covered by the focused evidence includes safe-field preservation, exact status and
parser-reason mapping, occurrence-bound request accounting, parent/child correlation, lifecycle
settlement, durable atomicity/capacity/permissions, readback/delete isolation, retained UI
correlation, persistence failure and duplicate durability semantics, marker absence across typed
diagnostic/event/UI/file and external readback surfaces, and success/cancellation non-diagnostic
behavior. Internal `LoopOutcome.error` compatibility text remains outside those projections.

Initial read-only implementation review found Product Blocker 0 / P1 3 / P2 1 and Evidence E1 0 /
E2 2. The approved closure fixed persistence-before-publication and recoverable durable failure,
later-step request accounting, post-HTTP stream classification, and live timestamps, and added the
production-shaped lifecycle and marker evidence. Narrow re-review closed every Product finding and
left one evidence-only step-two/marker E2. The owner evidence closure corrected the inclusive
step-two count and injected all three markers into the runtime-shaped path. Two later gate-discovered
product regressions were fixed locally and the exceptional ultra-narrow review returned GO. Final
disposition is Product Blocker/P1/P2 zero and Evidence E1/E2 zero.

## Integration observations

Two stale expectations were corrected during integration: the central production/boundary inventories
now include the reachable diagnostic schema/store, and the session-launcher process expectation now
includes the intentional `--no-session` diagnostic state-root permissions. A prior PTY readback
assertion was normalized for the terminal's CRLF framing only. Closure-specific evidence added
valid deterministic UUID/timestamp fixture setup, real runtime/session PTY paths, later-step exact
aggregate counts, parent step-two transport/HTTP/parser facts, and fixed marker-absence checks.
These are test/inventory corrections and bounded evidence additions; the focused suites are green.
A first full PTY verification pass had one existing daily-editor history assertion fail; its isolated
rerun and the subsequent full PTY rerun passed 36/36, with no product change for that harness
observation.
The final evidence pass additionally checks the canonical diagnostic JSON bytes directly, confirms
that diagnostic-only runs create no session/context artifacts, and checks all three fake markers in
post-exit and restart readback stdout/stderr. The step-two production-shaped matrix now observes
two counted fetches through transport/HTTP/parser failure and one pre-fetch aggregate for later
credential failure, with exact step/status/reason assertions and terminal-event identity.
The first authoritative gate attempt was stopped at the context leaf after 14/15 cases exposed a
plan-scoped compatibility-text regression; `loop.ts` now restores the existing `errorText` result
while retaining typed diagnostics, and the isolated case plus focused context suite pass 1/1 and
15/15. A closure rerun was therefore required.
The second authoritative gate attempt stopped at the portable documented `agent:tui --no-session`
leaf: that launcher branch still allowed XDG/HOME and let the child re-resolve state instead of
receiving the launcher's fixed workspace-partitioned root. The focused fix now passes the resolved
root as `HENJI_SESSION_STATE_ROOT`, grants only that environment permission, and retains the
diagnostic state-root read/write permissions while keeping session/context persistence disabled.
The exact child environment is captured by the launcher process matrix; the portable documented
case passes 1/1 and the full portable process leaf passes 2/2, with session launcher process 3/3,
session topology 2/2, diagnostic CLI topology 2/2, TUI topology 6/6, and the no-session/diagnostic
PTY artifact regressions included in TUI process 36/36.

The third closure gate passed every assertion reached before the Deno task process itself exited 139
at the start of `agent:tui:pending:test`; no test failure was reported. That exact leaf immediately
passed 3/3 in isolation. To avoid rerunning the already-green prefix a fourth time, the owner ran the
remaining canonical `v0:test` suffix from `agent:tui:file-reference:test` through
`agent:acceptance:test` once in the exact manifest order; every leaf passed, including TUI process
36/36 and portable process 2/2. Together the successful closure-gate prefix, isolated stop-point and
ordered suffix cover all 70 direct test files and 763 offline tests. Topology 2/2, check, format
(161 files), lint (158 files), launcher shell syntax and diff check are green. The exit-139 event is
recorded as a non-reproducing Deno/native harness observation, not a product failure.

## Excluded operations and residual risk

No credential value/file was inspected, no provider/network request or production `henji` command was
run, and no actual persistent acceptance state was used or cleaned. No dependency or lockfile,
`_refs/*`, commit, push, tag, publish, or release operation was performed. Any provider retry remains
a separate explicit Human Gate.
