# Milestone 100 offline gate integrity hardening results

## Scope and disposition

Implementation follows `docs/plans/milestone-100-offline-gate-integrity.md`, SHA-256
`78466a3737fd66d01e2a3b1a61e5937f740871cba366469793141701f78fa32a`. The change is limited to
offline task configuration, central topology evidence, the reviewed topology-only expectation
updates, and documentation. No product/runtime behavior, provider, credential, network, dependency,
lockfile, persistent product state, or `_refs/` snapshot changed.

The former all-permission directory rerun is replaced by 43 ordered leaf tasks. The leaves own all
45 direct `tests/v0/*_test.ts` files exactly once. `v0:gate` runs the topology self-check, check,
format, lint, and `v0:test`; consequently the topology test is observed twice by the full gate.
The central validator uses only `deno.v0.json` and the direct `tests/v0` directory, snapshots every
leaf target and permission flag in order, snapshots exact `v0:check`, `v0:fmt`, and `v0:lint`
executable/flag/target commands, and rejects in-memory mutations without rewriting the manifest.

## Implementation evidence

- `v0:legacy:test` runs `v0_test.ts` under the exact extension-source and `/tmp` reads, `/tmp`
  writes, pinned-Deno child, and IPv4 loopback permissions. It passed 32/32.
- `v0:offline-gate:topology:test` passed 2/2, including exact 43-leaf/45-file ownership and
  composition validation plus table-driven rejection of topology, maintenance-command injection,
  permission (including duplicate-existing-flag), grammar, self/mutual cycle, target, and
  production/provider/live/credential mutations.
- The reviewed topology-only expectation updates cover the six feature topology files, the
  runtime-process topology assertion, and the corpus topology assertion. They preserve exact
  command/permission, launcher, credential, registry, and production-boundary checks while
  asserting `v0:gate -> v0:test -> leaf` reachability.
- Direct focused topology leaves passed: instructions 1/1, skills 3/3, sessions 2/2,
  work-tools sentinel 1/1, planner-delegation sentinel 1/1, credential-launcher 1/1, and TUI
  4/4. The additional runtime-process topology leaf passed 18/18 and the corpus leaf passed 9/9.

## Offline verification

All commands use `/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno` and the repository task
configuration. The complete direct `v0:test` composition passed 505/505 tests (43 leaf tasks and
45 direct test files, exact-once ownership). The final `v0:gate` passed 507/507 tests: the same
505 direct tests plus the topology self-check's additional 2 tests.

Required checks passed with exit 0:

- `v0:offline-gate:topology:test`
- `v0:legacy:test`
- the seven existing feature topology tasks
- `agent:runtime:process:test`
- `agent:corpus:test`
- `v0:test` — 505/505
- `v0:check`
- `v0:fmt`
- `v0:lint`
- `v0:gate` — 507/507
- `git diff --check`

No provider, credential, production CLI/TUI/session, live sentinel/canonical, release, or external
operation was run.

## Review and residual risk

The initial implementation conflict with obsolete direct-gate assertions was closed through the
owner-approved, reviewer-GO local delta. Initial implementation review found P1 1/P2 3; the single
owner-approved finding-closure pass added the strict maintenance-command snapshots, exact-once leaf
assertions, and direct permission/cycle/chain mutations described above. The narrow re-review closed
all four findings and returned GO with Blocker/P1/P2 zero.

The coordinating owner independently reran central topology 2/2 and the complete `v0:gate`
507/507 at the final gate; exit was zero. Final owner disposition is Blocker/P1/P2 zero. No product
source or product behavior is part of this increment. The allowlists still intentionally do not
constrain capabilities delegated to permitted child executables such as trusted-local Bash; broader
process containment remains future milestone 100 work.

The reviewed increment was committed only after the final owner gate. No push, tag, publish, or
release was performed.
