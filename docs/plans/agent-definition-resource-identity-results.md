# Agent Definition resource identity results

## Scope and authority

Roadmap step 76 was implemented from the approved plan
[`agent-definition-resource-identity.md`](agent-definition-resource-identity.md), SHA-256
`d27878f34ed90893f371084aa8886d9bd1db31209aaed23502306a1d6560cc42`. The planning input was
revision 22 at SHA-256 `0d3af9f66bc3c314aa7d37ccecb44e1e95be8c2671f9489450eec5335e77eeef`.
The initial implementation Human Gate was approved on 2026-08-30. Bounded changed-lines review,
one evidence-only closure pass, narrow re-review, and the owner final gate are complete with final
Blocker/P1/P2 zero.

## Implementation

The built-in `default` and `planner` Definitions now declare immutable, data-only canonical
resource identities for their model, instructions, skills, tools, and planner subagent. The
selection grammar is strict ASCII with kind-ranked and lexical ordering, duplicate rejection,
known topology correlation, bidirectional skill/manifest coherence, and a positive safe-integer
`maxSteps` parameter. Parent and lazy planner selections are validated immediately after Definition
evaluation and before model, credential, fetch, planner handler, or registry materialization.
Normal runtime max-step consumers use the selection parameter; the work-tools sentinel retains its
`MAX_STEPS` compatibility alias. Selection data is internal, startup-only, and is not serialized
into requests, events, transcripts, sessions, or provider payloads.

Exact built-in selections are covered for no-context/no-skill and workspace-instruction plus
`format`/`review` skill inputs. The default has 8 or 13 resources, and the planner has 4 or 9;
all use `{"maxSteps":8}`. Existing production/planner tool behavior and request admission remain
unchanged.

## Requirement-to-evidence map

- `agent:definition:test` covers grammar boundaries, unsafe components, duplicate and
  noncanonical ordering rejection, exact default/planner resource sets, conditional skills and
  manifest identities, delegation dual-resource rules, unknown/missing/extra tools, model and
  planner-policy correlation, frozen exact-shaped JSON data, malformed shape/max-step values,
  path/body/result/profile/credential non-exposure, and workspace/source metadata invariance.
- `agent:runtime:test` covers valid production and planner materialization, pre-materialization
  parent rejection with zero model/registry/credential/fetch effects, no-delegation behavior,
  parent/planner validation observer timing, invalid lazy-child rejection before child effects,
  alternate profile correlation, exact wire tools/instructions, one-shot/session max-step use,
  and existing 8/8/16 delegation behavior.
- Existing planner delegation and built-in selection suites rerun to preserve capability,
  nonrecursive admission, selector, and fixed-definition behavior.
- Central topology verifies the new source is in the exact `v0:check` inventory while retaining
  the existing leaf ownership, permissions, and gate composition.

## Offline verification

The approved pinned Deno 2.9.4 commands produced these results:

| Command | Result |
| --- | --- |
| `agent:definition:test` | 12 passed, 0 failed |
| `agent:runtime:test` | 38 passed, 0 failed |
| `agent:planner-delegation:test` | 16 passed, 0 failed |
| `agent:definition-selection:test` | 4 passed, 0 failed |
| `v0:offline-gate:topology:test` | 2 passed, 0 failed |
| `v0:check` | passed |
| `v0:fmt` | passed |
| `v0:lint` | passed |
| `v0:test` | 516 passed, 0 failed |
| `v0:gate` | 518 passed, 0 failed |
| `git diff --check` | passed |

The closure `v0:gate` reruns the independent topology task, so its total is 518 tests while direct
`v0:test` totals 516. No provider, network, credential, production command, dependency or lockfile
operation, persistent product-state operation, `_refs/` operation, commit, push, tag, publish, or
release was performed.

## Files and review boundary

Changed files are the new `v0/agent/resource_identity.ts`, the Definition and runtime sources,
their two existing focused test files, the `v0:check` inventory and central topology expectation,
this results document, `README.md`, `AGENTS.md`, and `.handoff/handoff.md`. No other product/test
file is in scope. Rollback is limited to those files; the existing `_refs/*` snapshots and unrelated
worktree changes remain untouched. No plan delta, unplanned bug, or stop condition was encountered.

Initial implementation review found two evidence-only P2s. The approved single closure pass
uses direct selection validation for envelope mutations, adds parameter-level symbol/accessor/
prototype/missing-key cases, and constructs canonical resolved selections for unknown/extra tools,
each production delegation resource removal, and each planner delegation resource addition while
asserting the sanitized rejection. No production defect surfaced. Focused and full gates were
rerun after closure. The single narrow re-review closed both findings and returned `GO` with
Blocker/P1/P2 zero. The coordinating owner independently reran `agent:definition:test` 12/12 and
the authoritative `v0:gate` 518/518, including check, format, lint, direct `v0:test` 516/516, and
the independent topology rerun; `git diff --check` also passed. Final owner disposition is
Blocker/P1/P2 zero.
