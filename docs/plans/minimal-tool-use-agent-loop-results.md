# Minimal tool-use agent loop results

## Scope and outcome

The approved milestone 5 plan was implemented as a new, local fixture-only slice under `v0/agent/`.
The existing basic, legacy, provider, state, extension, and Spike paths were not modified.
The slice is provider-neutral, state-free, deterministic, and uses no additional dependency.

## Requirements-to-evidence

| Requirement | Evidence |
| --- | --- |
| Provider-neutral message/tool contract | `v0/agent/contracts.ts`; contract construction test |
| Stable Tool definitions and name resolution | `v0/agent/tools.ts`; registry definition/duplicate test |
| One deterministic fixed tool | `createFixtureTool`; success and invalid-input dispatch assertions |
| Unknown, invalid, and execution error normalization | registry dispatch test and loop error re-entry test |
| Scripted fixture request observation | `v0/agent/fixture_model.ts`; request snapshot test |
| Final-only, one-round, and two-round causal loops | corresponding direct loop tests |
| Finite max-step behavior | max-step test verifies exact model/tool counts |
| Local JSON command composition | `v0/agent/cli.ts`; fixture CLI test and `agent:fixture` task |
| Deny-by-default local test | `agent:test` task and `v0:gate` invocation |

## Verification

The implementation verification commands completed in the guest repository:

- `deno task --config deno.v0.json agent:fixture --task hello`: exit 0; deterministic final JSON
  with `Fixture result: HELLO`, 2 model steps, 1 tool call, and 1 tool result.
- `deno task --config deno.v0.json agent:test`: 12 passed, 0 failed under default-deny permissions.
- `deno task --config deno.v0.json v0:check`: passed for existing and new entrypoints/tests.
- `deno task --config deno.v0.json v0:fmt`: passed; 19 files checked.
- `deno task --config deno.v0.json v0:lint`: passed; 17 files checked.
- `deno task --config deno.v0.json v0:test`: 44 passed, 0 failed.
- `deno task --config deno.v0.json v0:gate`: passed check, format, lint, the 12 direct tests,
  and the 44-test v0 suite.
- `git diff --check`: passed.

Provider calls, credential access, persistent state changes, dependency/lockfile changes, commit,
push, and release are outside this slice.

## Deviations and remaining risk

No plan deviation is intended. The scripted fixture does not establish real-provider tool-call
protocol compatibility; provider integration, practical tools, streaming, sessions, permissions,
and other roadmap step 6+ concerns remain deferred by the approved plan.
