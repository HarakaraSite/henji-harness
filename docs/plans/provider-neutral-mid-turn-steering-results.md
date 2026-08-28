# Provider-neutral bounded mid-turn steering results

## Scope and authority

This evidence record covers provider-neutral-mid-turn-steering.md, SHA-256
021dd5c40db4d2f2412d35a1e3ff079d580782884a51f63c2f56ca202ba3872c. The reviewed increment was
committed after the final owner gate. All new tests use local fake models, sessions, and terminals
only.

## Implemented contracts

| Contract                                                              | Evidence                                                                                                                    |
| --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| One admitted NUL-free message per active parent turn                  | `v0/agent/steering.ts` and owner boundary tests; one admission remains `already_accepted` after pending, consumed, or close |
| Exact blank/NUL/Unicode/UTF-8 byte validation                         | agent_steering_test.ts owner test, including 65,536-byte boundary                                                           |
| No in-flight mutation and complete post-tool ordering                 | loop safe-boundary integration test and event sequence oracle                                                               |
| Consumed-only ordinary user transcript entry                          | session integration test and committed transcript oracle                                                                    |
| Final, terminal, max-step, cancellation, failure, and cleanup closure | focused stop-path matrix plus existing cancellation/session failure suites                                                  |
| Steering event snapshots and unchanged counters/task/turn             | events.ts, loop integration event oracle                                                                                    |
| Parent-only lane and unchanged planner/budget behavior                | existing planner/runtime/session suites; child loop receives no port                                                        |
| Additive schema-v1 causal validation                                  | `session_store.ts` parser and direct/store codec tests                                                                      |
| Completed-parent-turn nextTurn and metadata identity                  | parser count test; Deno store metadata/list/open/resume/rollback round trip                                                 |
| TUI busy editor, admission statuses, priority, and cleanup            | controller/render implementation, delayed cancellation/cleanup tests, and direct/PTY suites                                 |
| Direct NUL rejection before editor admission                          | controller paste guard and input/controller behavior                                                                        |
| Existing CLI/provider/stream/progress/cancellation contracts          | existing transport, streaming, progress, runtime, and cancellation suites                                                   |

Changed files:

- v0/agent/steering.ts
- v0/agent/events.ts
- v0/agent/loop.ts
- v0/agent/session.ts
- v0/agent/session_store.ts
- v0/agent/tui_cli.ts
- v0/tui/controller.ts
- v0/tui/render.ts
- tests/v0/agent_steering_test.ts
- tests/v0/agent_session_store_test.ts
- tests/v0/tui_controller_test.ts
- tests/v0/tui_process_test.ts
- tests/v0/fixtures/tui_process_fixture.ts
- deno.v0.json
- README.md
- docs/plans/provider-neutral-mid-turn-steering-results.md
- AGENTS.md and .handoff/handoff.md lifecycle evidence (coordinator-owned handoff)

## Offline verification

The focused permission-free task and check/gate wiring are:

    agent:steering:test

The following checks completed without provider, network, credential, production command,
persistent-state, dependency/lockfile, or _refs activity:

- agent:steering:test: 7 passed
- agent:test: 22 passed
- agent:session:test: 15 passed
- agent:session-store:test: 15 passed
- agent:tui:test: 48 passed
- agent:tui:process:test: 20 passed
- agent:tui:topology:test: 4 passed
- v0:check: passed
- v0:fmt: passed
- v0:lint: passed
- v0:test: 475 passed
- v0:gate: passed (full offline gate; v0:test 475 passed)
- git diff --check: passed

The full v0:gate completed after the implementation slice and finding-closure pass. The coordinating
owner independently reran the final `v0:gate`; it completed with 475/475 full offline tests and exit
code zero.

The finding-closure pass added exact evidence for the four initial P2 findings: delayed Escape,
Ctrl-C, SIGTERM, and SIGHUP clear the busy steering draft before status and reject late writes;
strict acceptance clearing turns a terminal write failure into `output_failure`, requests
cancellation, awaits the delayed turn, and restores once; the focused
stop/event/cancellation/planner matrix now covers final, terminal, max-step, model, cleanup,
event-delivery, post-consumption cancellation, complete multi-call parent-batch ordering, child
privacy, and 8/8/16 request budgets; Deno-backed schema-v1 tests
commit/read/list/open/resume/rollback a steering transcript and reject steering before the matching
tool result, at EOF, after final, twice in one parent turn, with raw user-count `nextTurn`, and with
NUL; direct and PTY TUI tests cover editor races, escaped consumed output, discard-before-
consumption, delayed cleanup, and one-time restoration. The gated PTY task now runs 20 cases.

## Review and deviations

No plan deviation, dependency/lockfile change, public CLI argument change, provider/profile change,
or persistence format change was introduced. Initial changed-lines review found Blocker 0/P1 0/P2
4: cancellation draft cleanup, strict clear failure propagation, material evidence coverage, and
rollback guidance. The single plan-scoped closure fixed all four; narrow re-review is `GO` with
Blocker/P1/P2 zero. The current residual risks are the plan's bounded-window race at a final/terminal
boundary, one-message capacity, long-running tool settlement, origin loss on restored user display,
and no real-provider claim.

## Activity boundary and rollback

Provider/network/credential/production activity: zero. Persistent product state activity: zero.
Dependency/lockfile activity: zero. _refs activity: zero. Commit/push/tag/publish/release activity:
zero. Rollback must first disable new steering writes (or retain the additive schema-v1 causal
parser) before removing steering integration. Once a steering-bearing schema-v1 record may exist,
the parser extension must remain available so that record can still be read; rollback never rewrites
or deletes existing session data. The owner, event, loop/session/TUI integration, task wiring,
focused tests, README text, and this result record may then be removed only as a code rollback, with
old-v1 bytes preserved.
