# Step 83 full-capability Human Gate — implementation results

Status: **local integration GO; final real-screen Human Gate consumed but non-evaluable**

## Historical VM launcher antecedent

On 2026-09-01, the earlier VM-local launcher wrapper changed the process working directory to the
repository root before executing the fixed Deno entry point. The later Step 83 implementation
superseded that behavior with a caller-cwd-preserving wrapper while retaining the same repository
authority. The replaced Go executable was retained at
`/home/masat.guest/.local/bin/henji.previous-e7f9ef8c`, and the legacy state tree was retained at
`/home/masat.guest/.local/state/henji-harness.pre-current-20260901-130038`; the old wrapper SHA-256
`33adeae91697778d5c648d948a2df50ff2d6476aa72b9fdf29ac3fe8437f1c12` is recorded below.

These are dated historical observations. Their existence and current state were not checked during
this documentation migration. No cleanup, rollback, or machine-state operation is authorized by
this result update.

The approved continuation adds a fixed repository-owned machine launcher and check/install/rollback
entry point, physical caller-workspace authority to the persistent launchers, a request-time fixed
credential-file source for production TUI composition, and task-oriented F1 help. The existing
presentation adapter, retained state/layout/controller, full default registry, session schema, and
provider-neutral cancellation/streaming contracts remain in place.

## Evidence

The focused and authoritative offline counts are recorded only after the final green tree. The
production `henji` entry point, live credential value, provider/network, and actual acceptance
workspace or session were not used while collecting this offline evidence. The machine-local install
occurred only after review and the single authoritative owner gate, as recorded below.

Prior green-tree evidence before the residual correction:

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

Residual correction evidence on the current tree (the authoritative full `v0:test`/`v0:gate` was
intentionally deferred until after narrow review):

- TUI input/render/controller focused suite: 115/115;
- machine and provider-free launcher process suite: 9/9;
- transport and shared credential file suite: 20/20;
- offline-gate topology: 2/2;
- `v0:check`: green; `v0:fmt`: green (152 files); `v0:lint`: green (149 files);
- `git diff --check`: green; launcher and installer shell syntax: green.
- final narrow review: Product GO, Blocker/P1/P2 zero; Verification complete, E1/E2 zero;
- coordinating-owner authoritative `v0:gate`: one execution, full offline `715/715`, topology,
  check, format, and lint green.

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
credential-lifecycle finding and the functional installed-location Blocker. The residual continuation
separates the two product corrections from the two Evidence E2 regressions without weakening either
category. Product P1 is implemented with one guarded assertion/cleanup unit: assertion failure
preserves the diagnosis workspace and expected file, the selected session UUID is checked directly,
and the normal shared `.index.lock` plus unrelated state namespaces are not treated as residue.
Product P2 is implemented with row-capacity-aware F1 selection; both 40x12 and 120x12 retain input,
stop, restart, and trusted-local guidance, and dismissal restores the editor state.

Evidence E2 now covers an installed-shaped copied wrapper seam for arbitrary argv, child exit 37,
and SIGTERM/143 forwarding, and rollback late-phase `cp`/`chmod`/`cmp`/`mv` injections that retain
the old target and backup bytes. Evidence E1 adds one disposable shell execution with an early
top-level mismatch; it observes the sanitized failure, retained workspace/expected file, and no
cleanup marker. Product review is GO and verification is complete.

After review and the single owner full gate, the repository-owned installer updated
`/home/masat.guest/.local/bin/henji` exactly once and installer `check` succeeded. The installed
target is a regular non-symlink 0755 file owned by the current user and matches the canonical source
at SHA-256 `0fc6bba0de3d5e6ba7701355b6cf12752b7bfad8e5f31d048f666a4abfb0d95e`. The fixed backup is a
regular non-symlink 0755 file with the prior SHA-256
`33adeae91697778d5c648d948a2df50ff2d6476aa72b9fdf29ac3fe8437f1c12`. The installed launcher was
not executed during that install/readback phase.

The separate acceptance package is
[step-83-full-capability-human-acceptance-gate.md](step-83-full-capability-human-acceptance-gate.md)
and was executed once under the separate final full-capability Human Gate approval.

## Final Human Gate observation

The approved production acceptance was invoked once from
`/tmp/henji-step83-full-capability-acceptance` with the installed bare `henji`. Preflight confirmed
the installed launcher and the fixed workspace. The setup directory initially inherited mode 0775;
this was detected before production launch and corrected to 0700. `request.txt` was a regular 0600
file with the exact three setup lines.

The startup screen showed the expected workspace, default agent, new autosave session, and ready
turn 0. The task-oriented F1 screen was opened and dismissed. Turn 1 was then submitted exactly
once. The UI reported `contract_failure`, exposed the accepted task as recoverable pending input,
and returned to ready at turn 0. No tool progress, tool call/result, assistant final, committed turn,
or `acceptance-note.md` was observed. Turn 2 and Turn 3 were not submitted. No application retry,
fallback, rerun, or additional provider task was attempted.

The TUI was closed without resubmission by confirming pending-input discard with Ctrl-D and exited
0 with terminal restoration. Read-only post-exit inspection found only the exact 0600 `request.txt`
in the preserved 0700 workspace. The repository-owned session list returned schema v1 with zero
sessions because the failed first turn did not commit and the empty session was removed on clean
exit. Its workspace state namespace contains only empty `contexts`, `locks`, and `sessions`
directories plus the normal `.index.lock`; no selected-session artifact or temporary file exists.

The UI does not expose an exact provider-request count for this failed attempt, so none is inferred.
Because the recorded `contract_failure` is only an umbrella outcome and does not identify the
failure phase or whether a provider request occurred, this run cannot support any adoption
decision. Its disposition is `判定不能`; the previously requested three-way human decision is
withdrawn. The workspace is retained for diagnosis; the assertion/delete/cleanup phase was not run.

## Overprotection that invalidated the acceptance

The only concrete secret in this controlled acceptance was the OpenRouter API credential. The
production runtime must read that host-provided value for each request and place the same value in
the HTTP Authorization header. It was correct not to display, log, persist, or independently inspect
that value. The credential file is not a model-generated artifact; it is merely the host-owned
storage form of the same API credential.

The implementation and acceptance policy went materially beyond that requirement:

- hypothetical private data in a future general-purpose provider response or tool argument was
  treated as a current acceptance threat, despite this run using a fixed disposable workspace and
  fixed known task;
- the provider adapter's already-safe typed classification (`missing_credential`,
  `transport_error`, `http_error`, `response_error`, or `limit_exceeded`), request count `0 | 1`,
  and optional HTTP status were not carried to an operator-visible diagnostic;
- fixed response-parser reasons such as invalid JSON, unsupported media type or finish reason,
  invalid tool arguments, and incomplete stream termination were hidden behind the single
  `contract_failure` label even though none contains the credential;
- the TUI converted the failure to a generic recoverable status, then the failed turn was not
  committed and the empty session was removed on clean exit, so the safe diagnostic detail could
  not be inspected afterward;
- the one-shot Human Gate prohibited retry but did not first require durable sanitized failure
  evidence, allowing an authorized provider attempt to be consumed without producing evaluable
  evidence.

This was not a necessary security tradeoff. It protected against speculative, out-of-scope future
data while discarding present-tense non-secret evidence needed to distinguish local credential,
request construction, transport, HTTP, provider-response, and parsing failures. The large offline
gate and review established many mechanical properties but did not establish diagnosability of the
first real failure. No further provider acceptance should be attempted until fixed, credential-free
failure evidence is operator-visible and survives TUI exit.

## Excluded operations

No credential value was displayed, copied, or logged. The one approved production `henji` launch
and Turn 1 attempt occurred as recorded above; the exact provider-request count was not observable.
No tool effect, committed session turn, dependency/lockfile change, `_refs/` change, commit, push,
tag, publish, or release was performed. The acceptance workspace and empty state namespace are
preserved pending separately authorized diagnosis work.
