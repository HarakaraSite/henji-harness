# Trusted-local Deno vertical slice: local implementation results

Date: 2026-08-24

## Scope and disposition

The approved v0 slice is implemented only in `v0/`, `tests/v0/`, `deno.v0.json`, and the bundled
trusted-local task-planner revisions. Existing `src/`, `plugins/`, `tests/` outside `tests/v0/`,
Spike 0/1/2, and `_refs/` were not changed or executed. No dependency was added, no commit or push
was made. The implementation/local-fix pass made no OpenRouter request or credential-value read;
the separately gated acceptance attempt is recorded below and in the handoff.

## Revision 7 pre-alpha raw-response implementation

The approved minimal slice changes only the CLI terminal readback and direct v0 tests. When a
`planText` response reaches the CLI, the same exact `responseText` is emitted with `parse`,
`requestCount`, `durationMs`, and `outcome`; parse failure exits nonzero after printing the readback.
Model/transport failures keep the existing sanitized error path. Response text is not written to state
or trace, and no provider, credential, retry, or request boundary changed.

The three direct regression focuses are: successful fixture response plus parse result; exact non-Plan
response plus parse error and exit 1; and local HTTP/readback serialization with no dummy credential,
Authorization header, or extra request. No provider endpoint was used.

## Approved plan-delta after two failed acceptance attempts

The first acceptance attempt (`3DF08279-18A6-43DF-904B-730978BC0FDC`, run
`run-ead3f975-0a97-4626-8dde-66e19a7a7264`) and second attempt
(`FB2D0628-B7E9-4B7F-AF42-92A9DD5D7980`, run
`run-5781ae82-8c4e-404c-b546-b4f453eef887`) each made exactly one request and failed after the same
OpenRouter HTTP 404 with sanitized `protocol_violation`. No retry was made. The user-approved
plan-delta keeps the exact model, single model/no model fallback, `stream: false`,
`max_completion_tokens: 1024`, temperature absent, retry 0, and request count 1/attempt, while
removing the entire provider object from the serialized request. OpenRouter standard provider routing
and failover are now allowed. The current default price ceiling is `$0.75/M` input and `$3.75/M`
output; the conservative worst-case is `$0.062208` and the attempt budget is `$0.064`. Existing two
attempts plus one new attempt have a `$0.128` upper bound within the user-approved cumulative `$1.00`.
The local HTTP test asserts no provider field, no models list, exact model, temperature absence, and
the remaining fixed request fields.

## Direct evidence

- `v0/` contains bounded domain/protocol validation, manifest and conservative self-contained source
  scanning, digest calculation, install copy, atomic state replacement, and an exclusive state/run
  lock.
- `extension install`, `activate`, `switch`, and `rollback` are separate human commands. Install
  does not activate; run, output, failure, status, and placement do not mutate the active pointer.
- The extension process is short-lived and uses the exact Deno 2.9.4 binary with
  `--no-config --no-lock --cached-only --no-npm --no-remote` plus all deny flags. The child inherits
  no environment and has one host method, `host.model.generate`; the runner requires exactly one
  successful host call, so a zero-call final response is rejected.
- The host fixture model makes exactly one bounded request and returns a strict structured Plan.
  The run trace profile is supplied by the host and cannot be spoofed by extension output. The
  host-only OpenRouter profile is fixed to `google/gemini-3.7-flash`, standard provider routing with
  no model fallback, `max_completion_tokens: 1024`, retry 0, and USD 0.064 per attempt. The authorized
  amount is bound before request start; the USD 0.062208 profile worst-case is rejected when the
  attempt has only USD 0.032. External acceptance attempts are separately gated and both failures are
  recorded above; no new attempt is authorized by this local-fix pass.
- Provider responses are read through a bounded stream and cancelled on the first byte beyond 1
  MiB. The HTTP deadline remains armed through body completion, so a headers-after-body stall
  fails closed. A package directory left by a crash before the state commit is adopted only when
  its exact manifest and source bytes match the expected digest; mismatches fail closed.
- Run traces contain extension identity, model profile, duration, bounded output counts, call count,
  outcome, and result digest; task, credential, model body, Plan body, and stderr text are not stored.

## Local gates

The following four v0-only gates were run twice on ai-dev with Deno 2.9.4. Both final rounds passed:

1. `deno check` for the v0 CLI, tests, and bundled revisions
2. `deno fmt --check`
3. `deno lint`
4. `deno test` with 23 tests passed and 0 failed

The test matrix directly covers deterministic digest, source token rejection, bounded JSONL and
Plan parsing, explicit management and rollback, CLI transitions, orphan/fault paths, invalid state,
same-process and separate-Deno-process lock serialization, offline separate-process E2E, exact spawn
deny flags, zero-call and spoofed-profile rejection, local HTTP request/profile/redaction, bounded
response cancellation, body-stall deadline, fixture model redaction, budget binding at USD
0.032/0.064, one-shot and terminal attempt transitions, timeout/output overflow/kill-reap,
pending-host-handler session cancellation, permission denial, and XDG/user-local default state.
`git diff --check` also passed.

Additional command-specific gates were run successfully with the same local Deno permissions:
separate-process lock, denied-process E2E, runner zero-call/profile spoof, timeout/output
kill-reap, permission probe, three local HTTP cases (including body stall), pending host-handler
session timeout, orphan package fault, invalid-state fault, and terminal-attempt fault (all selected
tests passed; no provider endpoint was used).

## Remaining risk and next gate

This is not a complete untrusted-code sandbox. Same-user or local-process source/dependency
replacement, signatures, immutable artifacts, run-time rehash, Admission, public distribution, and
automatic promotion remain intentionally out of scope. H-014 (本人 task usefulness) and H-015
(human management usability) still require a user judgment. Independent review was GO before the two
failed acceptance calls, which are recorded above. The next step is confirmation that the OpenRouter
account-wide Privacy provider allowlist permits Google Vertex; no retry or new attempt occurs until
that user confirmation.
