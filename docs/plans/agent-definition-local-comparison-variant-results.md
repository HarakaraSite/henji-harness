# Agent Definition local comparison variant results

## Authority and status

- Planner input: `/tmp/planner-inputs/henji-agent-definition-local-comparison-variant.md`, SHA-256
  `7c99b4dbbd353f722e0b70e57fc9489f1acc87e06ab0dac21f29820a03b097c6`.
- Canonical plan: `docs/plans/agent-definition-local-comparison-variant.md`, SHA-256
  `4d134e26ea4e96fffa43997e085b3d900c1a108a06eb0fb963dc691be919b72d`.
- Implementation base: Step 77 commit `59b4ab3cc1325d4f9c8daae057b1e61a46b33fbb`.
- Human Gate: implementation and final integration commit approved. The single changed-lines re-review is
  `GO`, and the owner final disposition is Blocker/P1/P2 zero.

## Implemented contract

`v0/agent/agent_identity.ts` owns independent finite domains for public built-in IDs, the one internal
comparison ID, manifest IDs, and executable resource topology IDs. `agent_catalog.ts` still exposes only
`default` and `planner`; `default-max-steps-4` is rejected by the public resolver.

`v0/agent/comparison_variant.ts` validates one frozen compile-time entry and evaluates the existing
`defaultAgentDefinition` once. Its production wrapper remains fixed to that Definition; the separately named
direct-test-only evaluator seam is used only to count that call without creating runtime reachability. It creates a comparison-owned frozen parent envelope, then derives a fresh
variant selection with the identical resource strings and `maxSteps` changed from 8 to 4. Model, registry,
profile, workspace, skill catalog, instructions, and system instruction are shared by reference. The
mechanical relationship validator rejects declaration, ownership, shape, topology, and any non-axis drift.

The schema-v1 manifest codec retains its domain, key order, payload, and digest algorithm. Its finite
internal ID contract now accepts `default-max-steps-4`, binds that ID to default topology, and requires
`maxSteps === 4`; the four Step 77 known answers remain unchanged. Runtime imports no comparison module and
correlates every standalone-valid manifest with the requested public built-in ID, exact resources, and
maxSteps before observer, materialization, credential, or fetch effects for both parent and lazy planner.

## Known answers

The two new variant answers pass byte-for-byte:

| Definition/context | Identity |
| --- | --- |
| `default-max-steps-4`, no instruction/skills | `90121c85e8c3a26f48eeca0ede02667584cd9056d53ba85173b2022812dca389` |
| `default-max-steps-4`, workspace + `format`/`review` | `26c9197ad70e1f2b89cc574f7da67d2bb9d1c78b3d80879450518fb3e5ab54e0` |

All four existing Step 77 payloads and identities remain exact.

## Evidence and measured verification

- `agent:comparison-variant:test`: 6/6. Covers finite catalog shape/ownership, malformed and drifted
  entries, exact one-evaluation derivation for no-context/no-skills and workspace/skills inputs,
  frozen/reference relations, the complete sole-axis/non-axis drift matrix (including frozen entry mapping,
  registry delegation, resource reorder, all invalid max-step values, and top-level shape cases), marker
  invariance, and the workspace/skill comparison identity.
- `agent:resolved-manifest:test`: 10/10. Covers six known answers and variant default-topology/fixed-
  maxSteps rejection while retaining prior codec negatives.
- `agent:definition-selection:test`: 4/4. Public built-in resolver remains exactly `default`/`planner`.
- `agent:definition:test`: 12/12. Existing Definition and resource topology contract remains green.
- `agent:runtime:test`: 49/49. Covers variant/wrong-selection factory correlation rejection before all
  host effects and lazy planner continuation with no child effects, CLI/TUI comparison-selector rejection
  before terminal/session effects, and exact successful fake wire/event/outcome/transcript/session/result
  nonleakage assertions.
- `agent:runtime:process:test`: 18/18. Existing offline process boundary remains green.
- `agent:tui:test`: 68/68; `agent:tui:topology:test`: 4/4. Existing TUI behavior and permissions remain
  green and expose no comparison selector.
- `v0:offline-gate:topology:test`: 2/2. The new permission-free leaf, direct ownership, check target,
  exact permissions, and gate composition are fail-closed.

The approved single implementation finding-closure pass addressed all three initial evidence P2s without
changing the product contract: direct-only exactly-once observation, complete mechanical drift coverage,
and public/runtime isolation evidence were added. The direct `v0:test` run passed 547/547. The authoritative
`v0:gate` passed with exit 0 and the same 547/547 full offline test total after its independent topology,
check, format, and lint stages.
`v0:check` passed with the new identity/comparison source and test targets, `v0:fmt` checked 115 files,
`v0:lint` checked 112 files, and `git diff --check` passed.

The sole narrow changed-lines re-review confirmed all three P2s closed at their intended semantic branches
and returned `GO`, Blocker/P1/P2 zero. The owner independently reran comparison 6/6, runtime 49/49,
definition-selection 4/4, topology 2/2, and the authoritative full `v0:gate` 547/547 with exit 0. Final
owner disposition is Blocker/P1/P2 zero.

## Scope, review, and residual risk

Changed implementation/test/task files are limited to the Step 78 ownership list, plus this results
document and the implementation-stage lifecycle updates. Runtime, CLI, TUI, provider, event, transcript,
session, persistence, permissions, and public selector behavior remain unchanged except for the required
manifest correlation rejection boundary. No plan deviation, scope expansion, or unplanned bug has been
found. The initial implementation review's three P2 evidence findings were addressed in the one approved
closure pass. The sole narrow re-review closed all findings, and the owner final gate confirmed the reviewed
tree. Final Blocker/P1/P2 disposition is zero.

The reviewed increment is recorded by the user-authorized final integration commit. No provider, network,
credential, production command, actual external persistent state, dependency or lockfile, `_refs/`, push,
tag, publish, or release operation was performed.
