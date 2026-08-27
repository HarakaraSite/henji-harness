# Bounded synchronous planner delegation tool results

## Scope and authority

- Plan: `docs/plans/bounded-planner-delegation-tool.md`
- Plan SHA-256: `5f8da680dabc7223d6320c5129c0350ed64fe7b0f7d613a4a44a7a9f5d26570d`
- Implementation revision: working tree based on `06565b7cba71a4f623cc9fedc0e0b5b0094cf2db`
- Status: local implementation, offline verification, and independent bounded review are complete.

## Implementation

The normal `default` runtime now advertises one nonterminal, synchronous
`delegate_to_planner({task})` tool. A valid task is passed verbatim to one built-in `planner`
child, which uses the startup-frozen workspace, AGENTS instruction, and skill catalog with only
`read`, optional `skill`, and `submit_json_result`. Parent and child events/transcripts remain
private to their respective turns; the parent receives one continuing, sanitized JSON result.

The provider-neutral turn context admits one child per accepted parent turn and enforces parent 8,
child 8, and aggregate 16 model-request claims immediately before model generation. A rejected
claim reaches no model, credential source, or fetch. Child success accepts plain assistant text or
terminal JSON. Complete envelopes are bounded to 65,536 UTF-8 bytes; oversized results are replaced
without truncation. No retry or fallback was added.

Files owned by this increment:

- `v0/agent/execution_context.ts`
- `v0/agent/planner_delegation.ts`
- `v0/agent/loop.ts`
- `v0/agent/tools.ts`
- `v0/agent/session.ts`
- `v0/agent/agent_definition.ts`
- `v0/agent/registries.ts`
- `v0/agent/runtime.ts`
- `v0/agent/work_tools_sentinel.ts`
- `tests/v0/planner_delegation_test.ts`
- `tests/v0/agent_definition_test.ts`
- `tests/v0/agent_runtime_test.ts`
- `tests/v0/agent_runtime_process_test.ts`
- `tests/v0/agent_work_tools_test.ts`
- `tests/v0/agent_skills_topology_test.ts`
- `tests/v0/work_tools_sentinel_test.ts`
- `tests/v0/fixtures/runtime_process_fixture.ts`
- `tests/v0/tui_controller_test.ts`
- `deno.v0.json`
- `README.md`

## Contract evidence

Description and schema are fixed to the canonical plan. Representative successful envelopes are:

```json
{"ok":true,"agent":"planner","output":{"kind":"text","text":"..."},"usage":{"modelRequests":1,"externalRequests":1}}
```

```json
{"ok":true,"agent":"planner","output":{"kind":"json","json":"{\"key\":\"value\"}"},"usage":{"modelRequests":2,"externalRequests":2}}
```

Failure envelopes use only the allowlisted code/message pairs `delegation_limit`, `planner_failed`,
`planner_output_invalid`, and `planner_output_limit`, plus nonnegative usage counters. Focused
tests cover exact schema, invalid-input non-admission, text and JSON mapping, malformed/NUL/
unpaired output, sanitization, byte limits, one-call admission, concurrent dispatch, and result
continuation.

The exact registry topology is:

| registry | tools without skills | tools with skills |
| --- | --- | --- |
| default | `bash`, `delegate_to_planner`, `edit`, `read`, `submit_json_result`, `write` | those six plus `skill` |
| planner | `read`, `submit_json_result` | `read`, `skill`, `submit_json_result` |
| corpus/eval | existing five | existing five |

The top-level planner remains nondelegating. The fixed sentinel uses the explicitly named
`createWorkToolsRegistry` helper, which has no delegation declaration; production registry
materialization requires a handler and cannot silently omit the declared capability.

## Measured verification

The focused delegation suite passed 16 tests. The affected runtime suite passed 35 direct tests,
the runtime process suite passed 18 tests, and the TUI direct suite passed 30 tests. The
authoritative offline gate passed 326 tests with zero failures. It also
passed the repository's check, format, lint, definition, selection, instruction, skill, work-tool,
corpus, provider-neutral, transport, runtime, and managed-PTY suites. `git diff --check` passed.

Evidence includes the fake-provider process delegation flow (parent request, child planner request,
parent continuation), actual runtime child read-to-final, terminal JSON, max-step and missing-
credential outcomes, exact 8/8/16 admission with a seventeenth request rejected before credential
and fetch, and stateful discovery/materialization counters. Startup workspace context, instruction,
and skill discovery each occur once; child rediscovery is zero. No-delegation paths evaluate one
Definition and materialize only the parent model/registry. Accepted runtime session turns receive
fresh context; rejected blank/busy submissions consume no turn, admission, child, or request.

Actual runtime-session event regressions cover failure before the parent `tool_call` (child request
zero) and after child completion (parent draft rollback and fresh next turn). A managed TUI
controller test drives an actual `AgentSession` through two accepted delegated turns, each with one
child admission and a fresh 8/8/16 context, while the existing PTY/CLI tests cover selection,
busy-input, failure, and terminal restoration.

Production task permission literals remain unchanged. The focused delegation task is permission-free
and the v0 gate excludes production/provider tasks.

## Review, deviations, and risks

Initial independent read-only review returned NO-GO with Blocker 0, P1 0, and P2 3. The
production-registry fallback was removed, the fixed sentinel was split to an explicit work-tools
registry, and runtime/session/TUI evidence was added for every reported gap. Corrected changed-lines
re-review returned `GO` with Blocker/P1/P2 zero.
There is no product-plan deviation. The fixed sentinel now uses the explicitly named
`createWorkToolsRegistry`; `createProductionRegistry` requires a delegation handler and always
advertises the declared capability. This preserves the sentinel's separate five-tool topology
without permitting a production registry to silently omit delegation.

Rollback is limited to this increment's execution-context threading, delegation tool and default
declaration, runtime child factory, tests/task wiring, README, and this results record; prior
Definition increments and unrelated working-tree changes remain intact.

Residual risks are the plan's stated risks: planner capability is not an OS sandbox; child reads
mutable workspace contents at delegation time; parent event failure after child completion cannot
roll back external work; descendant containment, persistence, recovery, streaming, cancellation,
real-provider behavior, and hostile same-user isolation remain out of scope.

No provider/network/credential/production command, dependency or lockfile change, `_refs/` or
archive change, commit, push, tag, publish, or release operation was performed.
