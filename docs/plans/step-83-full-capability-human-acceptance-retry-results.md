# Step 83 full-capability Human Gate retry — implementation results

Status: **repository implementation and owner evidence closure complete; Product
Blocker/P1/P2/E1/E2 zero; authoritative gate attempt 2 exposed one stale
cancellation expectation, no third gate planned, final execution Human Gate
pending**

Owner-evidence checkpoint: `2026-09-02 11:14 JST`

Plan:
[`step-83-full-capability-human-acceptance-retry.md`](step-83-full-capability-human-acceptance-retry.md)

Planning source:
`/tmp/planner-inputs/henji-step-83-full-capability-human-acceptance-retry.md`

Approved plan SHA-256 at dispatch:
`1b4eca0c63a54a0f3e14019b038260d8c58be8fea49964674a1b87b25be98e6a`

Planning source SHA-256:
`ed6989b955337954e10e5e51f71c8980e4a7a219c7f796534119dd8a4e945319`

## Scope completed

- Terminal `turnProviderRequestCount` and runtime-cumulative request counts are
  carried through production session outcomes/events, presentation, and retained
  UI without entering transcript, session/context schema, provider wire, or
  diagnostic record shape.
- `turn_control` diagnostics with `turn_cancelled` and `model_step_limit` are
  bounded by the existing immutable diagnostic owner and retain cleanup
  precedence.
- Planner child failures, invalid/oversized results, and admission failures now
  propagate as a typed parent-turn terminal signal. The parent emits bounded
  tool failure evidence and performs no later model fetch; an existing child
  diagnostic is reused without collision.
- Repository-only `update-retry` and `rollback-retry` installer lifecycles
  preserve the original continuation backup and retain retry recovery evidence.
- The bounded closure distinguishes initial `cmp` status 1 (required
  source/target difference) from indeterminate status >1, reuses one terminal
  request-count snapshot on commit failure, and documents clean-cancellation
  diagnostics without changing cleanup precedence.
- The execution package now contains literal guarded, read-only
  session/diagnostic metadata assertions, strict one-session UUID selection,
  same-session turn-count correlation, selected lock/temp checks, and a
  provider-free mismatch/state-preservation regression.
- The production session correlation boundary has two negative known answers: a
  diagnostic `providerRequestCount` mismatch and a diagnostic `turnNumber`
  mismatch are each rejected as non-evaluable without reconciliation.
- At this earlier checkpoint the retry execution package was unapproved. The
  later consumed Human Gate result is recorded below and supersedes that status.

## Focused verification

All commands used the repository-pinned Deno binary and remained provider-,
network-, credential-, production-, and machine-state-free:

- `v0:check` passed.
- `agent:planner-delegation:test` passed (16/16).
- `agent:failure-diagnostic:test` passed (17/17), including the bounded
  terminal-failure matrix.
- `agent:session:test` passed (19/19), including exact commit-failure
  outcome/event correlation and the two non-evaluable correlation mismatches.
- `agent:session-store:test` passed (21/21), including process-reset counts and
  byte-identical canonical session persistence.
- `agent:failure-diagnostic-store:test` passed (16/16), including immediate
  planner-failure contract failure, diagnostic
  identity/durability/no-collision/noncommit, and zero later parent
  exception/cancellation execution.
- `agent:cancellation:test` passed (18/18), including bounded clean-cancellation
  diagnostic, noncommit, zero-request correlation, event/outcome identity, and
  fresh next-turn signal.
- `agent:runtime:test` passed (52/52), including planner-child aggregation and
  per-turn/runtime cumulative counts.
- `agent:ui-presentation:test` passed (26/26).
- Retry launcher/package process suite passed (13/13), including cmp status-1
  refusal, all atomic retry failure positions, precondition refusal matrix, and
  provider-free assertion mismatch guard.
- Installer shell syntax, `v0:check`, `deno fmt --check`, `deno lint`, and
  `git diff --check` passed.

## Coordinating-owner gate observation

Authoritative gate attempt 1 stopped at `agent:failure-diagnostic-store:test`
with 13/16 cases passing. The three failures were stale compatibility
expectations that allowed a planner child failure to return to a later parent
final, exception, or cancellation path. The focused suite now passes 16/16 with
the approved immediate `contract_failure` and zero-post-failure-fetch contract;
no product source defect was exposed or changed. The coordinating owner then
used the single planned exceptional authoritative gate attempt 2.

The exceptional authoritative `v0:gate` attempt 2 was run by the coordinating
owner; `v0:test` and `v0:gate` were not run in this correction slice.

The final authorized full-gate attempt 2 stopped at `agent:cancellation:test`
with 17/18 cases passing. Its sole failure was the first test's stale exact
event expectation, which omitted the approved `turn_control/turn_cancelled`
diagnostic. The focused suite now passes 18/18 with noncommit, zero-request
diagnostic correlation, event/outcome identity, and fresh next-turn signal. No
third full-gate attempt is planned; authoritative verification remains
incomplete.

## Boundaries and remaining gates

Human Gate 2 repository authorization is consumed. Product Blocker/P1/P2
findings and the listed Evidence E1/E2 gaps are closed locally. Both authorized
full-gate attempts are consumed and authoritative verification remains
incomplete; no third attempt is planned. No provider/network/credential access,
production `henji`, real acceptance workspace/state, machine launcher target,
cleanup, dependency or lockfile change, `_refs/*` access, commit, push, tag,
publish, or release occurred. A separate final execution approval is required
before any machine update or real three-turn acceptance.

## Repository-wide minimal test reset

By explicit user direction, the legacy `tests/v0/` matrix was removed from the
repository gate and preserved recoverably at
`/tmp/henji-tests-v0-pre-minimal-reset-20260902`. The replacement is one
permission-free six-case current-code suite. It checks only the main execution
and Step 83 retry paths: public CLI API exposure, plain and terminal-tool agent
completion, committed multi-turn session/request accounting, max-step
diagnostic noncommit, planner success plus immediate failure propagation, and
retained UI request counts.

`deno.v0.json` now runs this suite directly. Full source type checking, lint,
the six tests, and `git diff --check` pass. The first invocation of the new
minimal gate stopped in type checking on the new test helper's missing explicit
assertion annotation; the annotation was corrected and the component checks
then passed. No legacy test, independent review, provider, credential, network,
production command, or machine-state operation was run.

## Consumed real Human Gate result

The user explicitly authorized installation and human-use acceptance on
2026-09-02. Official OpenRouter readback still showed model
`google/gemini-3.7-flash`, endpoint
`POST https://openrouter.ai/api/v1/chat/completions`, and USD 0.75/M input plus
USD 3.75/M output. `update-retry` ran exactly once and `check` passed. The
installed launcher now matches canonical SHA-256
`2e45157491bdac8c0de52ab56116111d00077152665021135324e1602a69dcf6`;
the retry backup preserves pre-update SHA-256
`0fc6bba0de3d5e6ba7701355b6cf12752b7bfad8e5f31d048f666a4abfb0d95e`.

The fresh workspace and diagnostic baseline passed preflight. F1 was opened and
dismissed once. Exact Turn 1 was accepted once and consumed the gate. It stopped
before any tool activity with `contract_failure` and the following evaluable
diagnostic:

- diagnostic ID `85d43242-4af7-4b2c-9bf7-6e71d47ab8ae`;
- `response_parse` / `response_error` / `data_after_terminal`;
- HTTP 200, parent lane, turn 1, model step 1;
- diagnostic provider request count 1;
- terminal actual/runtime request counts 1/1;
- durable readback matched the retained live record.

Turns 2 and 3, retry, fallback, rerun, and follow-up were zero. Confirmed Ctrl-D
discard exited 0. Read-only inspection found unchanged `request.txt`, no
`acceptance-note.md`, no committed session, and one durable diagnostic record.
The workspace, state namespace, diagnostic, installed launcher, and retry backup
remain preserved. The current human-use acceptance result is failure; no code
fix or another provider attempt was performed.
