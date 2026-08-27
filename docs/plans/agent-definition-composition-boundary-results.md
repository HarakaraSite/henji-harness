# Agent Definition composition boundary implementation results

## Scope and authority

This increment implements [`agent-definition-composition-boundary.md`](agent-definition-composition-boundary.md)
at SHA-256 `226692cdc46f466460244dd6df655803831c30ecd06dad92a662f398367e6b55`.
The implementation is based on HEAD `06565b7cba71a4f623cc9fedc0e0b5b0094cf2db` and keeps the
external `agent:run` and `agent:tui` invocation contracts unchanged.

## Changed files

- `v0/agent/agent_definition.ts`: internal pure Agent Definition contracts, canonical `PROFILE`
  declaration, instruction/skill projection, production registry declaration, and max-step value.
- `v0/agent/openrouter_model.ts`: structural profile contract, optional captured profile, and
  profile-driven endpoint, credential environment, method, and request controls.
- `v0/agent/runtime.ts`: once-per-composition Definition evaluation, exhaustive model/registry
  materialization, `composition.maxSteps` wiring, and `MAX_STEPS` compatibility alias.
- `tests/v0/agent_definition_test.ts`: permission-free pure declaration tests.
- `tests/v0/agent_runtime_test.ts`: single-evaluation, max-step, session, and startup zero-use
  regressions.
- `tests/v0/agent_openrouter_model_test.ts`: alternate profile, default/explicit wire equality,
  and endpoint precedence regressions.
- `deno.v0.json`: Definition task plus source/test check and gate inputs; production task literals
  and permissions are unchanged.
- `README.md`: internal shared startup Definition boundary note.

## Requirement evidence

The default Definition returns `provider: 'openrouter'` and the exact canonical `PROFILE` object,
preserves the discovered workspace, immutable skill catalog, optional instructions, and composed
system instruction, and declares `maxSteps: 8`. It performs no filesystem, credential, fetch,
tool, session, event, or UI work; its focused test runs without permissions.

The host remains responsible for workspace and instruction/skill discovery, counted fetch,
credential/test seams, and concrete materialization. The injected Definition seam is test-only;
production always selects `defaultAgentDefinition`. One-shot and two-turn session tests observe one
Definition evaluation per composition, while startup observes zero credential-source reads and zero
fetch starts. A discriminating injected Definition test materializes an alternate profile and a
different skill catalog, observing the alternate endpoint/body and the resulting `skill` tool. The
one-shot and session custom one-step Definitions each stop after one nonterminal round with
`max_steps`, proving both consumers use `composition.maxSteps`.

The adapter captures an explicit structural profile. Offline alternate-profile evidence shows the
model, derived endpoint, method, stream flag, and completion-token field are profile-driven; an
explicit endpoint still wins. Omitted profile and `profile: PROFILE` produce equal endpoint,
method, headers, and request-body bytes. Lazy credential timing and request-count behavior remain
unchanged. The production five-tool registry and skill conditionality remain covered by the
existing runtime/work-tool suites.

## Verification

All commands used the repository-pinned Deno 2.9.4 binary. No provider, network, credential, or
production runtime command was run.

| Command | Result |
| --- | --- |
| `/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --config deno.v0.json agent:definition:test` | PASS — 2 tests |
| `/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --config deno.v0.json agent:runtime:test` | PASS — 18 tests |
| `/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno test --no-prompt tests/v0/agent_openrouter_model_test.ts` | PASS — 16 tests |
| `/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --config deno.v0.json agent:runtime:process:test` | PASS — 14 tests |
| `/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --config deno.v0.json agent:session:test` | PASS — 14 tests |
| `/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --config deno.v0.json agent:instructions:test` | PASS — 9 tests |
| `/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --config deno.v0.json agent:skills:test` | PASS — 12 tests |
| `/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --config deno.v0.json agent:work-tools:test` | PASS — 13 tests |
| `/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --config deno.v0.json agent:tui:test` | PASS — 26 tests |
| `/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --config deno.v0.json agent:tui:process:test` | PASS — 10 tests |
| `/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --config deno.v0.json agent:tui:topology:test` | PASS — 3 tests |
| `/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --config deno.v0.json v0:check` | PASS — 81 files checked |
| `/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --config deno.v0.json v0:fmt` | PASS — 80 files checked |
| `/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --config deno.v0.json v0:lint` | PASS — 77 files checked |
| `/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --config deno.v0.json v0:test` | PASS — 277 tests |
| `/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --config deno.v0.json v0:gate` | PASS — exit 0; 277 tests |
| `git diff --check` | PASS — no output |

The gate contains `agent:definition:test` exactly once. The pure Definition task has no permission
flags. Existing `agent:run` and `agent:tui` production task literals retain their prior
environment, network, workspace read/write, and Bash permissions. No dependency/lockfile,
`_refs/`, persistent product state, commit, push, tag, publish, or release operation was used.

## Review, deviations, and residual risk

The initial bounded independent read-only review reported Blocker 0, P1 0, and three accepted P2
evidence gaps. All three are fixed within scope: `agent_definition_test.ts` is included in the
`v0:check` input, runtime evidence now proves injected profile and registry/skill materialization,
and a session max-step regression proves one nonterminal request and one fetch. Changed-lines
re-review independently reran runtime 18/18, `v0:check`, and `git diff --check`, and returned GO with
Blocker/P1/P2 zero. No requirement, provider profile value, report/budget schema,
production permission, wire format, or external behavior deviation was identified during the
fixes. Rollback is limited to the new Definition source/tests/results, adapter explicit-profile
support, runtime materialization, compatibility wiring, and README/task entries; unrelated
working-tree changes remain outside the rollback scope.

Remaining approved risk is limited to the internal test seam and the existing trusted-local
materialization/tool execution model. Multiple Definitions, public selection/configuration,
per-call reactive evaluation, provider/network execution, credential access, and broader runtime
ownership changes remain out of scope.
