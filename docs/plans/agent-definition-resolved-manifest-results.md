# Agent Definition resolved manifest results

## Authority and status

- Planner input: `/tmp/planner-inputs/henji-agent-definition-resolved-manifest.md`, SHA-256
  `5520f69a1ec0dc2c5f7e5a5f08894e792543f5b661b789970c27fc76ab687df0`.
- Canonical plan: `docs/plans/agent-definition-resolved-manifest.md`, SHA-256
  `9321cbb783844261647c6479757a1a17196eef67ae2771a0ba2bb58151456d3c`.
- Implementation base: Step 76 commit `e359cda9bef9ad44e115881c5e9e0ebeaa057f12`; the reviewed
  Step 77 tree is recorded by the user-authorized final integration commit containing this result.
- Initial implementation review found Blocker 0/P1 1/P2 2. One approved, plan-scoped closure pass
  fixed all three findings; the sole narrow changed-lines re-review returned GO, Blocker/P1/P2 zero.

## Implemented contract

`v0/agent/resolved_manifest.ts` constructs and validates an internal, fresh, deep-frozen
schema-v1 envelope with exact own-key order:

```text
schemaVersion, definitionId, resources, parameters, identity
```

The identity-excluded payload is compact UTF-8 JSON. The digest input is
`UTF8("henji-agent-resolved-manifest:v1\n") || payload`, hashed with full Web Crypto SHA-256 and
encoded as lowercase `henji-agent-resolved-manifest:v1:sha256:<64 hex>`. Descriptor-safe validation
rejects accessors, symbols, unknown keys, noncanonical order, sparse/subclass arrays, unsafe
prototypes, invalid resource grammar/topology, unknown versions/IDs, wrong domain/digest, and
cross-bound default/planner topology with one sanitized `AgentResolvedManifestError`.

The Step 76 resource validator now shares one built-in topology helper with the manifest validator.
Runtime prepare resolves startup snapshots, evaluates the selected Definition once, validates the
selection and manifest, and only then materializes model/registry. Admitted lazy planner turns use
the same validation order. Persistent TUI uses prepare, store record acquisition/validation, then
materialization; the manifest is absent from runtime composition, model wire, events, transcript,
session record, CLI, and TUI output.

## Known answers

All four plan fixtures pass byte-for-byte payload and identity checks:

| Definition/context | Identity |
| --- | --- |
| `default`, no instruction/skills | `bdf0e5c7e70ac5d928aab4681bb3228c642d0af89a498ae9f3f9c2940f7a4a58` |
| `default`, workspace + `format`/`review` | `7b45d146eecac2dd0f1126889f5d0728b64535e1294ad68556b42d1825545505` |
| `planner`, no instruction/skills | `fc23e5faaddf628f2d30adee4793c196db3e9b5cfc5714629193fbc6c3bd30eb` |
| `planner`, workspace + `format`/`review` | `6974dafb9c9ea74c7bfc93046d5920cc829c5d7d6c75629d51e885d3b75ecc5a` |

## Evidence

- `agent:resolved-manifest:test`: 9/9. Covers known answers, byte/domain/identity exclusion,
  path/content invariance, strict shape/descriptor/prototype/array/encoding negatives, exact
  known-topology extras/omissions for both definitions, post-call snapshot mutation, real
  Definition discovery invariance, one-resource differences with rehashed rejection, and
  cross-bound topology with a recomputed digest.
- `agent:definition:test`: 12/12; Step 76 selection and shared topology regressions.
- `agent:runtime:test`: 46/46; exact observer/materialization order, parent and lazy-child factory
  failures, sanitized continuation/ownership, top-level planner composition, failure pre-effect
  counters, child continuation, and no-delegation behavior.
- `agent:planner-delegation:test`: 16/16; delegation admission, isolation, and request bounds.
- `agent:session:test`: 15/15; session transcript/cancellation/commit behavior unchanged.
- `agent:session-store:test`: 15/15; schema-v1 store codec, list/open/resume/rollback and bounds.
- `agent:session:tui:test`: 8/8; production default TUI session factory, persistent settlement,
  exact artifact-tree preservation across new/continue/exact factory failures, invalid resumed
  metadata cleanup/reopen, rollback/commit failures, and manifest failure before any store
  operation/materialization.
- `agent:tui:test`: 68/68; renderer/controller/input lifecycle and nonleakage regressions.
- `v0:offline-gate:topology:test`: 2/2; new permission-free leaf, exact ownership/permissions,
  direct composition, and fail-closed mutation checks.

The closure direct `v0:test` run passed 537/537. The coordinating owner independently reran the
manifest suite 9/9 and authoritative `v0:gate`, which passed 537/537 after its independent topology,
check, format, and lint stages; `v0:check`, `v0:fmt`, `v0:lint`, and `git diff --check` all passed.

## Changed files and boundaries

Implementation/evidence changes are limited to `v0/agent/resolved_manifest.ts`, the shared
resource helper, runtime/TUI composition wiring, the manifest/runtime/TUI/topology tests,
`deno.v0.json`, and this results/lifecycle documentation. No provider, network, credential,
production command, dependency/lockfile, external persistent product state, `_refs/`, commit,
push, tag, publish, or release operation was performed.

## Review and residual risk

The implementation review's P1 was the shared topology helper accepting grammar-valid extras or
omissions; its P2s were missing descriptor/snapshot/invariance and runtime/persistent-TUI causal
evidence. The closure pass made topology exact, added synchronous snapshot and real-Definition
invariance/shape matrices, and added factory, causal-order, nonleakage, artifact-preservation,
invalid-resume, cleanup, and lock-reopen regressions. No production defect, plan delta, stop
condition, or unplanned bug was found. The sole narrow changed-lines re-review closed P1 1/P2 2 and
returned GO, Blocker/P1/P2 zero. The owner final manifest 9/9 and full gate 537/537 passed.

The internal equality contract assumes the usual collision resistance of SHA-256. Schema migration,
manifest persistence, public exposure, dynamic Definitions, and provider-side manifest semantics
remain out of scope. Rollback is limited to the Step 77 implementation/evidence files and lifecycle
entries; prior plans, session data, workspace data, and `_refs/` remain untouched.
