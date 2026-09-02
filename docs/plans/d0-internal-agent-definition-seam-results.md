# D0 internal Agent Definition seam conformance results

## Outcome

**D0 complete. Product GO.**

Approved plan: `docs/plans/d0-internal-agent-definition-seam.md`, SHA-256
`b5a578dfc9cbb457793c0b3073099380b803e8c7c70789626765e919f2fe04fe`.

The implementation closes the three audited product gaps:

- `ResolvedAgentDefinition` is declarative data and no longer retains Workspace, full SkillCatalog,
  Registry, model instance, credential/fetch, session, or executable closures.
- Definition capability identities are the source used to materialize actual tools and planner
  delegation; resource selection and the resolved manifest derive from the same declaration.
- An internal compile-time admission with another supported tool subset traverses the real
  prepare → Definition validation → manifest validation → materialization path without adding a
  public selector or a new runtime preset branch.

Public CLI/TUI selection remains exactly `default | planner`. Current default/planner tools,
instructions, skills, OpenRouter profile, planner delegation, maxSteps, CLI/TUI/session composition,
typed events, persistence, and provider evidence behavior remain unchanged.

## Functional verification

The focused functional suite passed 7/7. Its single D0 regression confirms:

- default/planner declarations materialize the expected Registries;
- resolved Definitions do not expose the removed host objects;
- a synthetic supported tool subset and changed maxSteps traverse the real prepared runtime path;
- observed manifest resources/maxSteps and materialized Registry match that Definition.

Focused type check, format check, lint, and `git diff --check` passed.

Initial functional review found one P1: the first implementation accepted the synthetic Definition
only through isolated validation/Registry helpers while the real manifest path remained closed to
built-in topology. The approved in-plan correction introduced an internal declared-topology
admission and routed it through the existing prepare/manifest/materialize stages. The single narrow
re-review confirmed the P1 closed, found no new Blocker/P1, and returned GO.

The coordinating owner then ran the authoritative `v0:gate` exactly once on the stable candidate:

- `v0:check`: passed
- `v0:fmt`: passed, 83 files checked
- `v0:lint`: passed, 80 files checked
- current smoke: 7/7 passed
- provider stream compatibility: 7/7 passed
- total current offline tests: 14/14 passed

## D0 completion readback

1. Default/planner use the same Definition → validation → manifest → materialization contract: met.
2. Model, instructions, tools, skills, subagents, and maxSteps are Definition-derived: met.
3. Declarative Definition data and host/runtime objects are separated: met.
4. Manifest/resource identity and actual capability materialization share one effective declaration:
   met.
5. CLI/TUI/session retain the shared prepared/materialized composition: met.
6. UI remains decoupled through typed events and read-only projections: met.
7. A compile-time Definition with another supported capability subset can use the internal seam
   without general agent-core redesign: met.

## Boundaries

No loader, plugin system, additional provider, third production Definition, general safety
hardening, dependency/lockfile, provider/network/credential/production command, machine/launcher,
retained acceptance state cleanup, `_refs/*`, commit, push, tag, publish, or release operation was
performed.

The next roadmap action is Gate 1 preparation or the next supplied planning input. Any commit or
provider-facing action remains separately user-authorized.
