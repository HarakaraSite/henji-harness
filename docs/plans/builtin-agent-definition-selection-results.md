# Built-in Agent Definition selection implementation results

## Scope and authority

This increment implements [`builtin-agent-definition-selection.md`](builtin-agent-definition-selection.md)
at SHA-256 `10098e02a2d57897f647ad202aecfa9218934f83d215dd8d8ccf211884031e5e`.
The implementation was performed against the existing working-tree baseline at HEAD
`06565b7cba71a4f623cc9fedc0e0b5b0094cf2db`; the preceding Agent Definition composition increment
and user-owned `_refs/` snapshots remain in place.

## Changed files

- `v0/agent/agent_catalog.ts`: frozen compile-time `default`/`planner` catalog, exact ASCII ID
  validation, own-key resolution, and sanitized selection error.
- `v0/agent/agent_definition.ts`: planner registry declaration, fixed planner policy, and planner
  Definition with canonical `PROFILE` and eight-step bound.
- `v0/agent/registries.ts`: planner registry containing `read`, optional `skill`, and
  `submit_json_result` only.
- `v0/agent/runtime.ts`: explicit selection input and exhaustive planner/production materialization;
  the hidden `RuntimeTestSeam.agentDefinition` path is removed.
- `v0/agent/runtime_cli.ts`: combined `--task`/`--agent` parser, one-time early resolution, and
  selection-aware runner seam.
- `v0/agent/tui_cli.ts`: exact optional selector grammar, resolution before terminal access, and
  selection-aware one-session factory.
- `tests/v0/agent_catalog_test.ts`, `agent_definition_test.ts`: catalog and pure planner contract
  tests.
- `tests/v0/agent_runtime_test.ts`: planner/default materialization, tool topology, wire equivalence,
  and one-time selection tests.
- `tests/v0/agent_runtime_process_test.ts`, `fixtures/runtime_process_fixture.ts`: planner argv/piped
  process cases and sanitized invalid-selection evidence.
- `tests/v0/tui_controller_test.ts`, `tui_process_test.ts`, `fixtures/tui_process_fixture.ts`,
  `tui_topology_test.ts`: selector, early-preflight, planner session, PTY, and topology coverage.
- `deno.v0.json`: focused permission-free catalog task and check/gate inputs; production task
  permission literals remain unchanged.
- `README.md`: stable names, CLI forms, fixed-session behavior, planner capability boundary, and
  non-sandbox clarification.

## Requirement evidence

The catalog contains exactly the frozen IDs `default` and `planner`. Omission resolves the frozen
default selection; explicit default resolves the same Definition function. Resolution accepts only
case-sensitive ASCII IDs matching `/^[a-z][a-z0-9-]{0,31}$/` and then performs an exact own-key
lookup. Malformed and well-formed unknown values produce the same internal sanitized error without
evaluating a Definition or touching host resources.

The planner Definition preserves the canonical OpenRouter `PROFILE`, discovered workspace,
instructions, and immutable skill snapshot. It appends the exact fixed non-mutation policy after
existing context and manifest text and declares `maxSteps: 8`. Its registry advertises exactly
`read`, `submit_json_result` without skills, and `read`, `skill`, `submit_json_result` with a
callable saved skill. `bash`, `edit`, and `write` are not constructed or advertised. Existing
production process permissions remain unchanged; planner capability restriction is not described or
implemented as an OS sandbox.

`agent:run` accepts the two option orders, explicit `default`, and argv/piped planner tasks. Each
option consumes exactly its following value verbatim, including option-looking values; duplicates,
missing values, positional arguments, and `--agent=...` are rejected. Selection resolution occurs
before TTY probing, stdin reading, runtime/composition, workspace discovery, tool/model construction,
and credential access. `agent:tui` accepts only zero arguments or `--agent NAME`; it resolves before
terminal construction/probing, uses one selected session composition, and provides no switching path.
Default output channels and provider wire remain unchanged.

## Validation

All commands used the repository-pinned Deno 2.9.4 binary. No provider, network, credential,
production `agent:run`/`agent:tui`, dependency/lockfile, persistent product state, `_refs/`, commit,
push, tag, publish, or release operation was used.

| Command | Result |
| --- | --- |
| `deno task --config deno.v0.json agent:definition-selection:test` | PASS — 4 tests |
| `deno task --config deno.v0.json agent:definition:test` | PASS — 4 tests |
| `deno task --config deno.v0.json agent:runtime:test` | PASS — 24 tests |
| `deno task --config deno.v0.json agent:runtime:process:test` | PASS — 17 tests |
| `deno task --config deno.v0.json agent:tui:test` | PASS — 29 tests |
| `deno task --config deno.v0.json agent:tui:process:test` | PASS — 12 tests |
| `deno task --config deno.v0.json agent:tui:topology:test` | PASS — 3 tests |
| `deno task --config deno.v0.json v0:check` | PASS — 82 files checked |
| `deno fmt --check --config deno.v0.json v0 tests/v0` | PASS — 82 files checked |
| `deno lint --config deno.v0.json v0 tests/v0` | PASS — 79 files checked |
| `deno task --config deno.v0.json v0:gate` | PASS — exit 0; full suite 297 tests |
| `git diff --check` | PASS — no output |

The focused task has no permission flags and appears exactly once in `v0:gate`. Production
`agent:run` and `agent:tui` task literals retain their existing environment, network, workspace
read/write, and Bash permissions. Invalid-selection direct/process/PTY cases observe no runner,
provider, stdin, workspace, session, or raw-terminal use. The process and PTY fixtures use only dummy
credentials/fake providers or sessions.

## Review and residual risk

The independent initial review found Blocker 0, P1 0, and P2 2: README retained three descriptions
from the one-Definition baseline, and the new runtime CLI grammar lacked direct matrix evidence for
several selector forms. The README now distinguishes the two built-ins, their exact tool boundaries,
and the TUI selector grammar. A table-driven runtime CLI regression now covers duplicate and missing
`--agent`, equals form, malformed and option-looking selector values, option-looking task values, and
zero terminal/stdin/runner effects for invalid cases. The single changed-lines re-review confirmed
both findings resolved and returned `GO` with Blocker/P1/P2 zero. There are no accepted deviations.

Approved residual risks remain the trusted-local runtime/process model and internal structural
selection input; OS isolation, dynamic definitions, aliases/configuration, persistence, reactive
routing, and other agent purposes remain out of scope.
