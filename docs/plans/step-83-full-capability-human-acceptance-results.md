# Step 83 full-capability Human Gate — implementation results

Status: **review NO-GO; machine install and final real-screen Human Gate not run**

The approved continuation adds a fixed repository-owned machine launcher and check/install/rollback
entry point, physical caller-workspace authority to the persistent launchers, a request-time fixed
credential-file source for production TUI composition, and task-oriented F1 help. The existing
presentation adapter, retained state/layout/controller, full default registry, session schema, and
provider-neutral cancellation/streaming contracts remain in place.

## Evidence

The focused and authoritative offline counts are recorded only after the final green tree. The
production `henji` entry point, live credential value, provider/network, actual acceptance workspace
or session, and machine-local install are intentionally not used by this implementation pass.

Final green-tree evidence:

- transport and shared credential file: 20/20;
- TUI input/render/controller: 114/114;
- machine and provider-free launcher process: 8/8;
- session process: 3/3; session topology: 2/2;
- TUI topology: 6/6; UI boundary topology: 3/3;
- credential-launcher compatibility: 8/8; topology: 1/1;
- offline-gate topology: 2/2;
- authoritative `v0:gate`: full offline `713/713`, including topology `2/2`, `v0:check`,
  `v0:fmt` (152 files), and `v0:lint` (149 files);
- `git diff --check`: green.

## Finding closure evidence

- Blocker: `v0/agent/henji_machine_launcher.sh` now uses the fixed repository root rather than
  `$0` ancestry. The process regression copies it into an installed-shaped `.local/bin/henji`,
  invokes it from `/tmp`, and verifies the forwarded invalid argv, sanitized exit, fixed config,
  fixed session launcher, and no copied-wrapper path leakage.
- P1: the package assertions are included in the launcher-process test leaf and read only the
  README and Human Gate document. They require the installed bare command, exactly three task
  headings, `--continue`, the 48-request/no-retry bounds, exact top-level entries, expected-file
  creation and `diff -u`, lock/temp absence, guarded cleanup, and post-cleanup absence. No fake
  fixture or fake command is used by this package test.
- P2 F1: the retained layout keeps startup help at the first wrapped rows, uses compact narrow
  safety rows for input/stop/restart/trusted-local guidance, regenerates the overlay on resize,
  and restores the exact draft/cursor after dismissal. The 80x24→24x8→80x24 regression passes.
- P2 installer: the process seam proves install success, check, rollback, recovery publication,
  18 install command-failure positions, seven rollback failure positions, cleanup failure, and
  target byte/mode/symlink survival. All temporary roots are disposable; the machine target was
  not touched.
- P2 credential/effect boundary: async credential resolution is rechecked after settlement, a
  cancelled source performs zero fetches, each parent/planner request refreshes the source, and
  source failure remains sanitized with zero fetches. Existing session/context/manifest/replay,
  event/help, and Bash clean-environment/commit regressions remain in the gate.

The production `henji` entry point, live credential value, provider/network, actual acceptance
workspace or session, and machine-local install are intentionally not used by this implementation
pass.

Initial review found Blocker 1, P1 1, and P2 3. The approved single closure pass closed the
credential-lifecycle finding and the functional installed-location Blocker. Applying the repository's
review taxonomy, the remaining state is product NO-GO with P1 1/P2 1, plus Evidence gaps E2 2:

- Product P1: unsafe/non-executable acceptance cleanup sequencing and an invalid shared-state lock
  predicate.
- Product P2: F1 does not preserve stop/restart/trusted-local priority on realistic short terminals.
- Evidence E2: machine-wrapper argv/exit/signal boundary regression is incomplete.
- Evidence E2: late rollback-publication/target-survival failure regression is incomplete.

The original narrow review reported all four under the product severity count. They are separated
here without weakening the two actual product findings or claiming verification complete. Because
the product P1 remains open, owner verification, machine installation, and the separate final Human
Gate were not started.

The separate acceptance package is
[step-83-full-capability-human-acceptance-gate.md](step-83-full-capability-human-acceptance-gate.md)
and is not approved for execution in this state.

## Excluded operations

No credential value was read or logged. No provider/network request, production `henji` launch,
machine-local installation, persistent product state, dependency/lockfile change, `_refs/` change,
commit, push, tag, publish, or release was performed.
