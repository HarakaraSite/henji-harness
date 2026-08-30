# Step 79 implementation results

## Scope and authority

- Canonical plan: `docs/plans/agent-definition-replay-envelope-execution-record.md`
- Plan SHA-256: `e5327c39e01adb89569375051705135319b40de525b3c0127f910d6974a4300f`
- Delivered authority SHA-256: `dc4d2046f00170c5575606feba320859d2b982d62349a3acd02887ac5fc4d775`
- Roadmap revision: 25 / Step 79
- Implementation is pure internal data/observation infrastructure. No runtime, event, session,
  persistence, provider, CLI, TUI, or Step 80 integration was added.

## Implemented contract

- `canonical_identity.ts` provides only domain-separated SHA-256 and preserves all Step 77 manifest
  known answers.
- `replay_value.ts` validates finite JSON-shaped values, messages, and bounded causal transcripts
  using fresh, deeply frozen descriptor-safe clones. It rejects accessors, symbols, sparse/extra
  array properties, non-plain prototypes, invalid Unicode and surrogate pairs, noncanonical object
  order, nonfinite numbers, scalar/container node overflow, and all configured limits.
- `replay_envelope.ts` implements schema-v1 workspace descriptors, budget/model/manifest
  correlation, canonical payload bytes, and the domain `henji-agent-replay-envelope:v1\n`. Workspace
  digests use `henji-workspace-content:v1\n`; digest and envelope identity validation requires
  primitive strings and never invokes caller coercion. Workspace construction snapshots all fields
  before the asynchronous manifest digest and has no filesystem scanner.
- `execution_record.ts` implements schema-v1 normalized model/tool observations and a pure poisoned
  finite-state recorder. `runOrdinal` identifies a record; measured duration is never an identity.
  Tool-result bounds, references, duplicate rejection, and malformed-event poisoning happen before
  append. Global result order may interleave roles while each role remains an exact dispatch/result
  prefix; transcript batches correlate declaration, dispatch, result, and commit layers. Clock
  start/end are each read once, and provider token usage/cost are exact `unsupported` literals.

## Fixed known answers

- `alpha\n` workspace digest:
  `henji-workspace-content:v1:sha256:32ebafd879a1dc968107ec2e9a063ab8963e8854ea49c236e464f5c6e2a976bf`
- `beta\n` workspace digest:
  `henji-workspace-content:v1:sha256:371631304952cb768c5d06dbf46fae0e60bee30cf2f38578ad48a6d3b0f951e4`
- fixed envelope identity:
  `henji-agent-replay-envelope:v1:sha256:8779910633ac41ff36b9aec498d80f0c525aac16279c431ef5a8382797f9fa72`
- fixed execution record representation and all top-level/property orders are asserted by the direct
  suite.

## Evidence

Focused replay/record suite: 13 tests passed. The suite covers the fixed payload and identities,
  fresh/frozen ownership, field and budget binding, descriptor-safe malformed inputs, exact hostile
  coercion rejection, delayed manifest-validation mutation stability, strict task/path Unicode and
  scalar/container boundaries, causal validation, all five stop
  families, zero-observation failure/cancellation, dispatch-before cancellation, terminal results
  after cancellation/contract failure, planner-role observations with interleaved parent results,
  strict partial prefixes and reordered negatives, poisoned immediate result reuse/513th-result
  limits, fresh terminal/reference/value validation branches, exact twice-read clock behavior
  including pre-first-observation wall overflow, duration nonidentity, unsupported usage, and no
  identity field on execution records.

Step 77 manifest regression: 10 tests passed. Offline topology: 2 tests passed, including exact new
leaf ownership, permission-free execution, check inventory, direct composition, and mutation
rejection.

Related focused suites passed: comparison 6, session-store 15, session 15, runtime 49, TUI direct
68, TUI process 25, and topology 4. Direct `v0:test` passed 560/560 and the authoritative
`v0:gate` passed 560/560. `v0:check` passed; `v0:fmt` checked 120 files; `v0:lint` checked 117
files; and `git diff --check` passed. The permission-bounded offline topology test reads all four
new modules and asserts no production/provider/runtime/session imports and no `Deno.`, `fetch(`,
`process.`, or `Bun.` permission/ambient-operation API markers; the permission-free replay leaf
continues to import and exercise the same modules successfully.

## Permissions and exclusions

`agent:replay-record:test` is a permission-free leaf running the pinned Deno test command against
`tests/v0/agent_replay_record_test.ts`. The topology leaf has only the explicit read access to
`deno.v0.json`, `tests/v0`, and `v0/agent` needed for its source-inventory assertion; the new modules
use no Deno permission APIs. No provider, network, credential, production command, actual persistent
state, dependency/lockfile, `_refs/`, push, tag, publish, or release operation was performed. The
reviewed increment is recorded by the user-authorized final integration commit.

## Review/lifecycle

- Initial implementation Human Gate: approved 2026-08-31.
- Initial implementation review: NO-GO, Blocker 0 / P1 3 / P2 2. The one approved closure pass
  addressed all five findings. The sole narrow changed-lines re-review remains NO-GO with Blocker 0 /
  P1 1 / P2 2 because three closures were incomplete.
- P1 closure: primitive digest/identity validation now rejects caller objects without coercion and
  snapshots before asynchronous validation; recorder result admission validates bounds, references,
  duplicates, fields, values, and poisons immediately; declaration/dispatch/result/transcript
  correlation now enforces role-local prefixes and permits interleaved parent/planner observations,
  including observed terminal results on cancelled/contract-failure records.
- P2 closure: well-formed Unicode and UTF-8 callId bounds use one shared helper with exact scalar /
  container node accounting; direct evidence covers required stop, planner, partial, timing,
  semantic-negative, sanitized-error, and source-isolation cases.
- Approved residual closure fixed the sole narrow re-review residual P1 1/P2 2: constructor and
  standalone validator now snapshot caller-owned `modelIdentity` / `identity` before asynchronous
  manifest validation; envelope task/path validation reuses the shared strict Unicode contract;
  fresh recorder fixtures reach terminal/reference/value branches; and topology performs the actual
  four-module source inventory assertion. No further review pass was performed. The owner independently
  reran replay 13/13, offline topology 2/2, manifest 10/10, and authoritative full `v0:gate` 560/560;
  all residuals are Closed and final owner disposition is Blocker 0 / P1 0 / P2 0.
- Plan delta: none.
- Unplanned bug: none observed.
