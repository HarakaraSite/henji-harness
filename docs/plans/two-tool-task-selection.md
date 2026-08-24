# Henji Harness roadmap step 8 implementation plan

## Concept review request

None.

The approved Revision 15 input is compatible with the accepted step 5–7 architecture. The new
selection slice can add one deterministic tool and a task-specific contract guard around the existing
`runAgent`/`Registry` path without changing the shared loop, transport, fixed step 7 acceptance, or
provider profile. No scope expansion or concept decision is required.

## Recommended plan and assumptions

Implement step 8 as an additive, offline-only composition with one registry containing the existing
`uppercase_text` and a new `character_count`. Run the two fixed tasks as separate invocations against
an injected `Model`; each invocation uses `maxSteps: 2` and a task-specific guard that accepts exactly
one expected first-step call and exactly one expected second-step final response. A mismatched tool,
unknown tool, zero or multiple calls, invalid arguments, a second tool call, or a wrong final response
is rejected by the guard before any disallowed dispatch or further model call.

Fixed cases:

| Case | Fixed input | Expected first call | Local tool result | Exact final text |
| --- | --- | --- | --- | --- |
| uppercase | `henji harness step eight` | `uppercase_text({"text":"henji harness step eight"})` | `HENJI HARNESS STEP EIGHT` | `HENJI HARNESS STEP EIGHT` |
| count | `Henji 🐣` | `character_count({"text":"Henji 🐣"})` | `{"count":7}` | `{"count":7}` |

Confirmed current-state facts:

- `Registry.definitions()` exposes tools in stable name order and `runAgent` records the full
  `user → assistant tool call → tool result → assistant final` transcript.
- `runAgent` otherwise dispatches every returned call and returns tool errors to the model. The step 8
  guard is therefore required to make wrong/unknown/multiple/schema-invalid first responses terminal
  before dispatch, rather than changing the reusable loop contract.
- The existing tool boundary places a text value in `ToolResultContent`, and the OpenRouter adapter
  serializes that text as a tool message. The count object will therefore cross this existing boundary
  as canonical compact JSON `{"count":7}`; direct tests will decode it and assert the exact logical
  object `{ count: 7 }`. This is a local representation adapter, not a change to the required output.
- `Array.from("Henji 🐣").length` is 7 because the count is by Unicode code point, not UTF-16 code unit.
- `deno.v0.json` explicitly lists check inputs and gate tasks, so the new module/test must be added to
  those lists. Its production `agent:acceptance` task is separate and must not be invoked.

Reversible implementation details left to the implementer are exported identifier names and the
internal shape of the two-case specification table. The two tool names/schemas/behaviors, fixed
inputs, expected selections/results/finals, exact counts, failure semantics, file boundary, and gates
are not discretionary. There are no unresolved user decisions.

## Exact scope and files

After Human Gate 2, limit the implementation slice to:

- `v0/agent/tools.ts`: preserve `createFixtureTool()` exactly and add the deterministic
  `character_count` tool factory plus its strict `{text: string}` validation. The adapter returns the
  compact JSON representation of `{count: Array.from(text).length}` through the existing text-result
  contract. No filesystem, network, environment, clock, random, or state access is added.
- `v0/agent/two_tool_task_selection.ts`: own the two fixed case specifications, the registry containing
  both tools, exact call/final validation, task-specific guarded model, and an injected-model runner
  that calls `runAgent(..., {maxSteps: 2})`. Do not import or construct `OpenRouterAgentModel`.
- `tests/v0/two_tool_task_selection_test.ts`: permission-free direct tests for both success cases and
  every required contract failure.
- `deno.v0.json`: add a permission-free `agent:selection:test` task; add the new source/test to
  `v0:check`; include the direct task in `v0:gate` without changing or weakening existing tasks.
- `docs/plans/two-tool-task-selection-results.md`: implementation acceptance package mapping each
  Revision 15 requirement to direct evidence, final review disposition, deviations, and provider
  call count 0.

Do not modify `v0/agent/contracts.ts`, `v0/agent/loop.ts`, `v0/agent/fixture_model.ts`,
`v0/agent/openrouter_model.ts`, `v0/agent/real_provider_acceptance.ts`, existing tests, legacy paths,
provider/profile configuration, dependencies, lockfiles, state, Spike files, or step 7 result records.
Repository-owner gate documents may be updated separately by the default agent only when Human Gate 2
changes the authorized state; they are not implementation-writer ownership in this plan.

## Ordered increments

### 1. Add and prove the deterministic `character_count` tool

Outcome:

- Add the exact definition name `character_count`, an input schema requiring the single string field
  `text` with `additionalProperties: false`, and no other accepted shape.
- Count `Array.from(text).length`; return a non-negative safe integer in the exact logical object
  `{count: n}`, encoded as compact JSON only at the existing text tool-result boundary.
- Keep `uppercase_text` name, schema, description, validation, and uppercase behavior unchanged.

Dependency: none.

Verification:

- Directly compare both definitions and their stable registry order
  (`character_count`, `uppercase_text`).
- Assert `Henji 🐣` produces logical `{count: 7}` and dispatched text `{"count":7}`; include an
  astral-character assertion that would fail under JavaScript `.length` semantics.
- Assert missing `text`, non-string `text`, extra properties, array, and null are rejected as invalid
  arguments. Reuse one table because these share one schema-validation failure mode.
- Re-run the existing uppercase success and invalid-input assertions unchanged through the full gate.

### 2. Add the fixed two-task selection composition and terminal guard

Outcome:

- Define only the two approved independent task cases. Each case fixes task text, expected tool name,
  exact single-key arguments, expected local result text, and exact final text.
- Build one registry with both tools for every case, so selection is observable from the model request
  rather than preselecting a one-tool registry.
- On model step 1, accept only one call with a nonblank call ID, the case's exact name, and exact
  `{text: fixedInput}` arguments. Throw a stable task-selection contract error for final/zero-call,
  unknown or other tool, multiple calls, or schema/value mismatch before returning the result to
  `runAgent`; this yields terminal `contract_failure` with zero tool calls/results and no second model
  call.
- On model step 2, first verify that the request transcript contains exactly one successful matching
  local result, then accept only the exact final text. Any tool call, wrong result context, or wrong
  final is terminal. Never retry, fall back, repair names/arguments/tasks, or permit a third call.
- Evaluate the completed outcome as exactly: `final`, 2 model steps, 1 tool call, 1 tool result, the
  four-message causal transcript, selected/excluded tool counts `1/0`, matching result, and exact final.

Dependency: increment 1.

Verification:

- Use a fresh injected `FixtureModel` and fresh composition for each task; never combine both tasks in
  one run or share mutable call state.
- Assert both definitions are present in every model request and the second request observes the first
  request's selected call and local result.
- Assert the complete success tuple and transcript for each case, including selected tool once,
  nonselected tool zero times, result value, two steps, and exact final.

### 3. Add bounded negative coverage at the contract boundary

Outcome: prove each specified violation stops at its first observable boundary without dispatching a
disallowed tool or issuing an extra model call.

Dependency: increment 2.

Verification matrix:

| Failure fixture | Terminal evidence |
| --- | --- |
| Initial final response (zero calls) | `contract_failure`, steps 1, calls/results 0, model calls 1 |
| Other registered tool for either task | same; both tool implementations execute 0 times |
| Unknown tool | same; no registry dispatch and no repair |
| Two calls in the first result | same; neither call executes |
| Missing/wrong/extra `text` argument | same; no dispatch and no second model call |
| Expected first call followed by a second tool call | `contract_failure`, steps 2, calls/results 1, model calls 2, no third call |
| Expected first call followed by wrong final text | same bounded counts, with the first result preserved and no third call |

Use table-driven cases only where stop stage and failure mode are identical. The existing generic
Registry unknown/error re-entry tests remain regression evidence for the reusable loop; step 8 tests
specifically prove the stricter task-selection guard.

### 4. Integrate local gates and prepare the acceptance package

Outcome:

- Add the new source/test to explicit type-check coverage and add `agent:selection:test` without Deno
  permissions.
- Include the direct task in `v0:gate`; retain all existing step 5–7 direct and full-suite commands.
- Record exact commands/results, requirement-to-test mapping, changed-file inventory, review outcome,
  deviations, remaining risks, and `provider calls: 0` in the results document.

Dependency: increments 1–3 pass.

Verification sequence:

1. `deno task --config deno.v0.json agent:selection:test`
2. `deno task --config deno.v0.json v0:check`
3. `deno task --config deno.v0.json v0:fmt`
4. `deno task --config deno.v0.json v0:lint`
5. `deno task --config deno.v0.json v0:test`
6. `deno task --config deno.v0.json v0:gate`
7. `git diff --check`, then exact changed-file and diff inspection

The gate must show the new direct task succeeds with default-deny permissions, existing
`agent:test`, `agent:transport:test`, and `agent:acceptance:test` remain green, and the full v0 suite
regresses neither the loop/registry nor transport/acceptance paths. Do not run `agent:acceptance`, any
valid external-call command, credential check, or provider/network operation.

### 5. Bounded independent review

Outcome: an independent reviewer returns `GO` with Blocker/P1/P2 zero for the exact step 8 diff, or
findings are dispositioned before Human Gate 2 acceptance evidence is presented.

Review scope:

- exact Unicode code-point behavior and schema;
- both tools are advertised while only the task-matching tool can dispatch;
- every negative response stops at the stated request/dispatch boundary;
- max steps 2, no retry/fallback/repair/third call;
- existing uppercase, loop, transport, and step 7 acceptance contracts remain unchanged;
- no permissions, provider/credential path, dependency, state, or out-of-scope file change.

Use the normal 30-minute bounded review with a 10-minute no-new-evidence stop rule. One
changed-lines-only re-review may run for up to 15 minutes after fixes. A required shared-contract
change, scope expansion, or unresolved Blocker/P1/P2 returns to the default agent as a plan delta or
concept-review candidate rather than being implemented silently.

## Failure handling, compatibility, and rollback

Contract violations return the existing sanitized `LoopOutcome` `contract_failure`; no exception is
allowed to escape the composition. The guard rejects invalid model results before disallowed dispatch,
and `maxSteps: 2` is defense in depth against a third model call. Test fixtures inject only
`FixtureModel`; they contain no provider response, production credential, fetch, or network mock.

This slice is additive and state-free. It introduces no migration and does not change existing command
names, task behavior, transcript shape, provider wire format, state schema, or step 7 acceptance. The
only shared source edit adds the second tool factory while preserving the existing factory byte-for-byte
apart from formatting required by the repository formatter.

Rollback only the exact step 8 diff: remove the `character_count` addition from `tools.ts`; delete
`two_tool_task_selection.ts`, its direct test, and its results document; and remove only the new
`deno.v0.json` task/check/gate entries. Do not reset the dirty worktree or remove/alter any pre-existing
step 5–7, Spike, dependency, lockfile, handoff, or gate-state content. No data, credential, provider,
or persistent-state rollback is needed.

## Completion conditions and Human Gate 2 boundary

Planning is complete when this document has been read back with the canonical Revision 15 boundary,
exact owned files, ordered increments, direct test matrix, gate/review sequence, failure behavior,
compatibility, rollback, and no Concept review request.

Stop at Human Gate 2 after delivering this plan. Plan approval does not authorize source, test,
configuration, results, or handoff changes; test/review execution; provider/network calls; credential
checks; dependency/lockfile changes; persistent state; commit; push; or release. After explicit Human
Gate 2 approval, authorization extends only through the local implementation, offline validation,
acceptance package, and bounded review described above. It never authorizes a provider call.

## Remaining risks and deferred work

- The scripted model proves deterministic selection enforcement, not that a real model will choose
  correctly; real-provider observation requires a separate future concept and explicit attempt gate.
- JSON text is the existing transport representation of the logical count object. A future structured
  tool-result contract would be a separate cross-cutting change and is unnecessary for this slice.
- Grapheme-cluster counting is intentionally not provided: combining sequences and emoji ZWJ sequences
  count by Unicode code point exactly as Revision 15 requires.
- Practical tools, multi-tool composition in one task, parallel calls, task repair, streaming,
  sessions, context management, skills, extensions, RPC, subagents, self-revision, and step 9+ remain
  deferred.
