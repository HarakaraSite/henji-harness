# Provider-neutral tool progress events results

## Contract and implementation

- Plan: [`provider-neutral-tool-progress-events.md`](provider-neutral-tool-progress-events.md)
- Plan SHA-256: `192c49fc094a8c6256e639a27e376247aa25779f326a0449a1498827b632e196`
- Baseline: persistent session/history increment, prior offline gate 417 tests
- Implementation revision: current working tree (no commit was created)
- Bounds: 8,192 UTF-8 bytes and 64 accepted snapshots per tool call; Bash observes 4,000 bytes
  per stream and retains the existing 4,096-byte final capture

The loop now passes an execution-only reporter to active tools. It validates and correlates each
snapshot, closes the reporter at the first dispatch settlement, and latches synchronous event-sink
failure before requesting turn cancellation. Bash independently decodes stdout and stderr with
strict UTF-8 streaming and reports accumulated `stdout`/`stderr` snapshots without changing the
final result. The renderer keeps one escaped replaceable live line; completed records, transcripts,
requests, counters, persistence, and provider-facing behavior remain unchanged. Finding closure
also moves busy-TUI cancellation before fallible redraw, routes signal-listener redraw failures
through guarded crash settlement, and awaits active settlement before restore. It proves delayed
Bash capture settlement and cleanup-failure precedence, and verifies no-sink, canonical persistence
bytes, and resumed replay state.

Changed files:

- `v0/agent/events.ts`
- `v0/agent/execution_context.ts`
- `v0/agent/loop.ts`
- `v0/agent/tui_cli.ts`
- `v0/agent/work_tools.ts`
- `v0/tui/render.ts`
- `v0/tui/controller.ts`
- `tests/v0/agent_tool_progress_test.ts`
- `tests/v0/agent_session_test.ts`
- `tests/v0/agent_session_store_test.ts`
- `tests/v0/agent_work_tools_test.ts`
- `tests/v0/tui_render_test.ts`
- `tests/v0/tui_controller_test.ts`
- `tests/v0/tui_process_test.ts`
- `tests/v0/tui_topology_test.ts`
- `tests/v0/fixtures/tui_process_fixture.ts`
- `deno.v0.json`
- `README.md`
- `docs/plans/provider-neutral-tool-progress-events-results.md`
- `AGENTS.md` and `.handoff/handoff.md` lifecycle evidence

## Evidence matrix

| Contract | Evidence |
| --- | --- |
| Event shape, correlation, order, and two-call/two-turn isolation | `agent_tool_progress_test.ts` |
| Unicode, 8,192-byte, 64-update, abort, settlement, and no-sink bounds | `agent_tool_progress_test.ts` |
| Snapshot mutation and unchanged result/transcript/counters | `agent_tool_progress_test.ts`, `agent_session_test.ts` |
| Sink failure, cancellation request, settlement, rollback, and cleanup precedence | `agent_tool_progress_test.ts`, `agent_work_tools_test.ts`, `tui_controller_test.ts` |
| Accumulated stdout/stderr and unchanged final JSON | `agent_work_tools_test.ts` |
| Split, malformed, incomplete, within-read, and across-read UTF-8 cap behavior | `agent_work_tools_test.ts` |
| Bash timeout/cancellation and direct-child TERM/KILL/reap behavior | existing work-tools tests plus progress sink-failure regression |
| Replaceable escaped live TUI state, signal-failure settlement, and non-scrollback cleanup | `tui_render_test.ts`, `tui_controller_test.ts`, `tui_process_test.ts` |
| Persistence exclusion, byte-canonical records, and replay of completed history with clean live state | `agent_session_store_test.ts` |
| Runtime/provider/corpus/sentinel compatibility | existing session, runtime, transport, and full v0 suites |
| Focused task/check/gate topology | `tui_topology_test.ts`, `deno.v0.json` |

## Offline verification

The focused progress task is permission-free and occurs once in `v0:gate`:

```text
agent:tool-progress:test
```

The following checks are required to run without provider, network, credential, production, or
`_refs/` activity:

- `agent:tool-progress:test`
- `agent:session:test`
- `agent:session-store:test`
- `agent:work-tools:test`
- `agent:cancellation:test`
- `agent:context:test`
- `agent:planner-delegation:test`
- `agent:runtime:test`
- `agent:runtime:process:test`
- `agent:tui:test`
- `agent:tui:process:test`
- `agent:tui:topology:test`
- `agent:sessions:topology:test`
- `agent:transport:test`
- `agent:test`
- `v0:check`, `v0:fmt`, `v0:lint`, `v0:test`, `v0:gate`, and `git diff --check`

The focused counts are: progress 7, session 15, store 13, work-tools 25, TUI direct 40, TUI
process 16, and topology 4. Supporting focused compatibility counts were cancellation 18, context
15, planner delegation 16, runtime 35, runtime process 18, transport 16, and loop 22. `v0:test`
and the full run in `v0:gate` each passed all 439 tests; `v0:check`, `v0:fmt`, `v0:lint`, and
`git diff --check` passed.

## Review, deviations, and activity boundary

No plan deviation, dependency/lockfile change, public CLI argument/output change, provider/profile
change, persistence schema change, or descendant-containment redesign was introduced. Initial
changed-lines findings and the final owner-only signal-listener P1 branch are closed. The
coordinating owner inspected the guarded crash-settlement path and independently reran TUI 40/40,
full `v0:gate` 439/439, and `git diff --check`; final disposition is Blocker/P1/P2 zero.

Provider/network/credential/production command activity: zero. Dependency/lockfile activity: zero.
`_refs/` activity: zero. Commit/push/tag/publish/release activity: zero.

Residual risks remain the approved ones: high-volume Bash can reach the 64-event bound, cross-stream
ordering follows scheduling, event failure waits for bounded tool cleanup, local side effects are
not rolled back, arbitrary descendants are not fully contained, and terminal/process failure can
remain unhandleable. Final bounded Bash capture remains authoritative when live decoding is disabled.
