# D0 internal Agent Definition seam conformance plan

## Decision

**Disposition B: bounded implementation required. Initial Human Gate pending.**

Current code already has a shared Definition → validation → manifest → materialization path for
`default` and delegated `planner`; CLI/TUI/session share that composition, and the UI consumes core
events and a read-only display projection. Those parts are retained.

D0 is not complete because actual tools/subagents are still chosen by a separate registry preset,
the resolved Definition retains host objects, and the internal identity/topology contracts are
closed over the two public built-ins. The bounded implementation below removes those three seams
without adding a loader, plugin framework, provider, or third production Definition.

Planning source:

- concept revision: 46
- input: `/tmp/planner-inputs/henji-d0-internal-agent-definition-seam-conformance.md`
- input SHA-256: `4ff419b83f4f77acbba64e78a22fbbf9fc3b95208081e20dc1a0e8a4de807b3f`
- observed HEAD: `ce508e0afcac49c6bb7bf5283b434780b82466ea`
- observed tracked state: clean; only user-owned untracked `_refs/*` were present and were not read or
  changed

This document authorizes no implementation. Product source and tests remain unchanged until the
user approves this plan.

## Product outcome

After D0, a Definition is the single declarative source for its model declaration, effective
instructions, tools, skills, subagents, and limits. Runtime host context materializes that data into
the current OpenRouter model and executable Registry. Resource identity and the resolved manifest
are derived from the same effective declaration as the executable capabilities.

The existing `default` and `planner` behavior remains unchanged. A later compile-time Definition or
D1 loader can enter the same validation/materialization contract without adding another
`production | planner` branch to the general runtime core.

## Read-only conformance audit

### Current dataflow

| Stage | Default | Delegated planner | Finding |
| --- | --- | --- | --- |
| Selection | `runtime_cli.ts` / `tui_cli.ts` → `resolveBuiltinAgent()` | parent `delegate_to_planner` chooses the built-in planner | public selection is intentionally `default | planner` |
| Host discovery | `prepareRuntimeComposition()` resolves workspace, AGENTS instruction, and skills | child reuses the parent's frozen startup context | shared host discovery contract exists |
| Definition | `defaultAgentDefinition()` | `plannerAgentDefinition()` | both use the same Definition contract |
| Validation/manifest | resource validation and resolved-manifest correlation | the same validation and manifest codec | shared path exists |
| Materialization | OpenRouter adapter plus production Registry preset | OpenRouter adapter plus planner Registry preset | actual tools/subagent are preset-derived, not solely Definition-derived |
| Execution | `runAgent()` or prepared `AgentSession` | `runAgentTurn()` and typed delegation envelope | loop/session core need no redesign |
| UI | typed events and `RuntimeDisplayState` projection | child has no independent UI path | UI/Core boundary is already conformant |

### Composition ownership

| Composition dimension | Current source of truth | Status |
| --- | --- | --- |
| model | Definition's OpenRouter profile, materialized by the runtime adapter | met for the current provider; the declaration type needs a provider-neutral boundary, not a second provider |
| instructions | host discovery followed by Definition composition | met |
| tools | Definition resource list and a separate `registry.kind` factory | gap |
| skills | discovered catalog is used by Definition and Registry | effective behavior is explainable, but the host object remains in the resolved Definition |
| subagents | Definition resource/flag and production-registry closure | gap |
| maxSteps | Definition resource parameter | met |
| resource identity / manifest | Definition selection, but not correlated to the actual Registry definitions | gap |
| host/runtime objects | model/Registry/fetch/session are materialized later; Workspace and full SkillCatalog remain in `ResolvedAgentDefinition` | gap |
| UI projection | core-owned read-only state and typed events | met |

### Accepted source-to-product gaps

1. **Executable capability drift is possible.**
   `v0/agent/agent_definition.ts` and `v0/agent/resource_identity.ts` maintain resource declarations,
   while `v0/agent/runtime.ts` chooses `createProductionRegistry` or `createPlannerRegistry` by
   `registry.kind`, and `v0/agent/registries.ts` independently fixes the executable tool lists.
   The manifest can therefore describe a list that is not the actual Registry. A new tool subset or
   subagent combination requires another runtime preset branch. Naming, documentation, or tests
   cannot make these two sources one composition.

2. **The declarative result retains host objects.**
   `ResolvedAgentDefinition` retains `Workspace` and the full `SkillCatalog`. Consequently the
   Definition result is not a data-only declaration separable from the host context that owns
   filesystem access and executable factories. Moving those values outside the declaration requires
   a product-source change.

3. **The internal seam is closed over current built-ins.**
   `v0/agent/agent_identity.ts`, `agent_catalog.ts`, `resource_identity.ts`, and
   `resolved_manifest.ts` encode finite `default | planner` assumptions. The test-only comparison
   variant changes only `maxSteps`; it does not show that a Definition with another tool subset can
   use the same materializer. A third compile-time Definition or D1-loaded declaration would require
   coordinated edits to general runtime/topology switches rather than only catalog/loader admission.

These gaps satisfy the input's adoption rule: each has an exact current source path, blocks a stated
D0 property or D1/D2 post-install seam, and cannot be resolved by renaming, prose, or test-only work.

### Rejected gap candidates

- A current `provider: "openrouter"` value is not itself a defect. D0 requires a provider-neutral
  declaration boundary and the existing runtime adapter; it does not require a second provider.
- CLI/TUI/session do not have hidden composition paths requiring replacement.
- UI does not own Definition, model, Registry, provider, or plugin instances.
- Missing permutations or a desired test count are not product gaps.

## Bounded implementation

### 1. Separate declarative composition from host context

Refactor `v0/agent/agent_definition.ts` and `v0/agent/runtime.ts` so the resolved Definition contains
only immutable declarative data needed to explain and materialize the agent:

- provider-neutral model resource declaration carrying the current OpenRouter profile;
- effective system instruction and declared skill resources;
- ordered tool and subagent resource identities;
- current limits, including `maxSteps`.

Keep `Workspace`, full discovered `SkillCatalog`, credential source, fetch, model instance, Registry,
session, and executable closures in the prepared/materialized runtime host context. Definition input
may receive the data needed to compose effective instructions/resources, but its resolved result must
not retain host-owned objects.

### 2. Materialize capabilities from the effective declaration

Refactor `v0/agent/registries.ts`, `v0/agent/resource_identity.ts`, and `v0/agent/runtime.ts` around a
thin runtime-owned tool factory lookup keyed by the declared canonical tool identities.

- Build the executable Registry in the Definition's declared order using current factories and host
  context.
- Construct planner delegation only when the declared subagent capability requires it.
- Derive resource selection and the resolved manifest from the same effective declaration.
- Remove `production | planner` as the authority for tool/subagent membership and remove duplicate
  hard-coded capability lists used as a second truth.
- Reject a declaration only when a declared current resource cannot be materialized or its derived
  manifest is incoherent; do not introduce new permission, input, safety, or hardening policy.

The existing production and planner factory implementations may remain as narrow helpers where they
construct an individual known tool. They must no longer decide the agent's complete capability set.

### 3. Open the internal validation/materialization seam

Adjust `v0/agent/agent_identity.ts`, `v0/agent/agent_catalog.ts`,
`v0/agent/resource_identity.ts`, `v0/agent/resolved_manifest.ts`, and runtime types so an internal
compile-time Definition can use the same data validation, manifest derivation, and materialization
without adding a new general-runtime preset branch.

The public CLI/TUI selector remains exactly `default | planner`. No third production Definition is
added. Persisted/public identity and presentation contracts remain limited to currently supported
built-ins; D1 owns loader identity and admission policy.

## Behavior that must remain unchanged

- Omitted and explicit `--agent` behavior for `default` and `planner`.
- Current OpenRouter profile, request/stream/evidence behavior, and credential boundary.
- Default tools and optional skill/delegation exposure; planner's read-only tool set and no recursive
  delegation.
- Existing instructions, skill discovery/snapshots, planner task/result envelope, request budgets,
  `maxSteps`, cancellation, session persistence, and typed events.
- CLI/TUI use of the same prepared/materialized composition and UI use of read-only projections.
- No provider request, credential read, production `henji`, machine launcher, or retained acceptance
  state operation during D0 local implementation.

## Functional verification

After implementation, use only focused offline checks tied to the changed product behavior:

- Exercise the real prepare/materialize seam for `default` and `planner` and compare the declared
  ordered capabilities with the resulting Registry definitions and manifest resources.
- Exercise one synthetic compile-time Definition with a different supported tool subset or
  `maxSteps` through the same validation/materialization seam, proving no new runtime preset switch
  is needed. This is test input, not a third product Definition.
- Confirm the resolved declarative value does not contain Workspace, Registry, model instance,
  credential/fetch, session, or executable closures, while the host context still supplies current
  tools and skills.
- Run the existing focused runtime, Definition, delegation, CLI/TUI composition tests affected by
  the refactor, followed by repository-defined type check, format, lint, and `git diff --check`.

Do not create a coverage matrix or target a test count. Tests follow the concrete behavior above.
Do not run `v0:test` or `v0:gate` during implementation or review. Once product findings are closed
and the candidate is stable, the coordinating owner runs the authoritative `v0:gate` once because
the change crosses Definition, Registry, manifest, CLI/TUI preparation, and planner delegation.

## Review and closure

After focused checks pass, perform one bounded read-only functional review of the changed source.
The review checks current behavior preservation, single-source capability/materialization,
Definition/host separation, D1 seam usability, and concrete regressions. It does not perform a
general safety review or request speculative matrices.

Return concrete findings to the single implementation agent. One narrow re-review is limited to
changed fixes and prior findings. Then the owner performs the single stable-candidate gate and reads
back the seven D0 completion conditions from current source and execution evidence.

## Deferred work and boundaries

The following remain outside D0:

- user-authored `agent.ts`, loader, dynamic import, module identity/source policy, and hot reload;
- plugin lifecycle, install/update/remove, marketplace, or registry manager;
- another provider, model picker, credential/login UI, or provider/model presentation;
- a third production Definition, new tools/subagents, self-revision, or FR2–FR4 Gate 1;
- general safety hardening, permission/filesystem matrices, new rejection limits, or cleanup policy;
- provider/network/credential/production command, machine launcher, retained acceptance
  workspace/session/evidence cleanup;
- dependency/lockfile, `_refs/*`, commit, push, tag, publish, or release.

## Stop condition and next decision

Stop after this plan. The next step is user approval or revision of this Disposition B implementation
plan. Approval authorizes the three bounded implementation slices, focused offline verification,
one functional review, one narrow re-review if findings require fixes, one final authoritative gate,
and results/handoff recording. It does not authorize any deferred or provider-facing operation.
