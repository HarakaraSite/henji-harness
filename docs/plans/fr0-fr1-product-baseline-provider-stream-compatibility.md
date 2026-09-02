# FR0/FR1 product baseline and OpenRouter stream compatibility

Status: **implementation approval pending**

Planning source:
`/tmp/planner-inputs/henji-fr0-fr1-product-baseline-provider-stream-compatibility.md`,
SHA-256 `847ad555ac85a84306fc266dbee7998c702519093f0a9ff7f382da89bb289c1c`,
concept revision 45.

Recorded product baseline: commit `024071a9e119a4eb76dcdc0e5a3b0189354ea48b`. The input described
the same product work before that user-requested commit, so implementation classifies
`7b8f0d7..024071a` and never resets it.

## 1. User outcome and authority

Repair the repository product path that a later installed `henji` will use:

```text
TUI/session -> runtime -> OpenRouter adapter -> fetch -> HTTP -> SSE -> ModelResult
            -> loop/session -> retained UI and diagnostics
```

The path must accept OpenRouter's documented final accounting chunk as normal completion and must
retain the real provider exchange after both success and failure so a human can identify the exact
event and field involved.

The behavioral authorities are, in order:

1. the current `AGENTS.md` product-first policy;
2. this plan's revision 45 input, except where a later explicit user decision supersedes it;
3. the current official OpenRouter documentation;
4. observed execution evidence and current product behavior that must remain compatible.

Official references to re-read immediately before implementation:

- [OpenRouter streaming](https://openrouter.ai/docs/api_reference/streaming)
- [OpenRouter usage accounting](https://openrouter.ai/docs/cookbook/administration/usage-accounting)
- [OpenRouter tool calling](https://openrouter.ai/docs/guides/features/tool-calling)

If the official contract has changed materially, stop and report that fact. Do not preserve a stale
fixture.

Local completion is not production compatibility or human acceptance. Provider requests and an
installed launcher update remain separate Human Gates.

## 2. Later decisions overriding the input

The user-approved product-first correction changes these planning mechanics:

- no test-count target, cap, coverage matrix, or count-based completion condition;
- no unobserved provider-field permutation contract;
- no general security review or implementation hardening; only credential and Authorization
  exposure prevention is in scope;
- no Evidence-gap severity or closure queue;
- no ungrounded artifact quota, capacity cap, automatic eviction, or cleanup implementation;
- reviewer findings require an authoritative basis, a current source-to-user-impact trace, and a
  product correctness issue rather than a request for another test.

The input's bounded initial review and one narrow re-review remain. Both use the corrected functional
review contract above.

## 3. FR0 baseline readback

Implementation first creates
`docs/plans/fr0-fr1-product-baseline-provider-stream-compatibility-results.md` and records this state
before product changes:

| Area | Current state | Disposition |
| --- | --- | --- |
| Product source | Request accounting, failure diagnostics, immediate planner-failure propagation, session commit behavior, and retained request-count UI are committed at `024071a` | Keep; change only the seams needed to connect FR1 evidence |
| Parser/transport | `openrouter_model.ts` rejects the documented post-terminal accounting frame because normal `delta.content`/`delta.role` keys are present | Change |
| Tests | Current suite is six smoke checks and does not exercise fetch/HTTP/SSE; the old suite remains recoverable at `/tmp/henji-tests-v0-pre-minimal-reset-20260902` | Keep the reset; recover only a still-current product contract, never old files or matrices |
| Governance/docs | `AGENTS.md` and handoff contain the later product-first correction; the earlier draft plan is replaced by this document | Keep current policy and record its relationship to the baseline |
| Launcher | The last recorded readback says the failed-run installed launcher matched repository source | Historical fact only; do not read or change machine state in this slice |
| Failed acceptance | One HTTP-200 request ended in `data_after_terminal`; diagnostic `85d43242-4af7-4b2c-9bf7-6e71d47ab8ae` exists but raw provider payload does not | Keep untouched; do not fabricate a raw artifact or link |
| References | User-owned `_refs/*` | Do not read, execute, modify, stage, or delete |

The results readback also classifies the current tracked governance changes and the new plan/history
files as user-approved work to preserve. It explains the meaning of the current smoke checks and all
FR1 confirmations without using their count as evidence of completeness.

## 4. Product behavior to implement

| Required behavior | Authority |
| --- | --- |
| The documented final accounting chunk reaches the already-established terminal `ModelResult` | Official OpenRouter streaming contract |
| Existing content-free usage behavior remains accepted | Current product compatibility |
| Actual new post-terminal assistant content, tool-call data, or provider error is not treated as accounting | Revision 45 and current parser behavior |
| Request, HTTP status/headers, raw response, SSE ordering, parser transitions, runtime result, and request count are readable after success or failure | Revision 45 and `AGENTS.md` |
| API credential and Authorization never enter the evidence capture structure | Explicit current safety requirement |
| Existing request accounting, planner propagation, session commit, max-step, and retained UI behavior remain unchanged | `024071a` product baseline |

Unknown provider variants remain unknown. They are not converted into rejection rules or fixtures.

## 5. Source ownership and implementation

### 5.1 Provider evidence boundary

Add `v0/agent/provider_evidence.ts`. Split storage into
`v0/agent/provider_evidence_store.ts` only if that keeps the runtime boundary clearer.

One accepted parent turn owns one evidence ID and recorder. Parent and planner requests share it but
retain lane, model-step, and request-ordinal identity. Record:

- endpoint, method, exact serialized JSON request body, and explicitly non-Authorization request
  metadata;
- HTTP status, response headers, exact raw response bytes, and byte count;
- SSE event order, decoded `data`, raw-byte relationship, and provider-added fields;
- parser transitions, terminal result or exact failure event/field/reason;
- model/tool/result order, final turn outcome, and turn/runtime provider request counts.

The capture API does not accept a credential, credential source, Authorization, or complete
`RequestInit.headers`. The request evidence is constructed before the private fetch header is
assembled. Response and event data are otherwise preserved rather than sanitized.

Evidence recording must not change provider input, transcript, tool dispatch, or a valid
`ModelResult`. A persistence failure is reported separately and does not replace the actual provider
or parser outcome.

### 5.2 Runtime correlation

Use the minimum necessary changes in:

- `v0/agent/contracts.ts` and `execution_context.ts` for the provider-neutral recorder seam;
- `v0/agent/openrouter_model.ts` for actual request/HTTP/SSE/parser capture;
- `v0/agent/loop.ts` and `planner_delegation.ts` for model/tool causal order;
- `v0/agent/runtime.ts` and `session.ts` for one recorder per accepted turn and settlement;
- `v0/agent/events.ts` and the current TUI presentation only as needed to expose a retained evidence
  ID without placing raw evidence in the transcript.

On failure, write a small link from the existing diagnostic ID to the evidence ID. On success, expose
the evidence ID in retained UI and list output. Do not change the FailureDiagnostic v1 schema merely
to carry raw data.

### 5.3 Artifact lifecycle and readback

Use the existing workspace-partitioned state root:

```text
<state-root>/<workspace-digest>/provider-evidence/<evidence-id>.json
<state-root>/<workspace-digest>/provider-evidence-links/<diagnostic-id>.json
```

Retain successful and failed-turn artifacts after session noncommit, empty-session cleanup, and
normal exit. Do not add a quota, capacity ceiling, automatic eviction, or cleanup command. Long-term
retention and explicit cleanup are deferred until real operation establishes the need.

Extend the current diagnostics surface:

```text
henji diagnostics evidence list
henji diagnostics evidence show --id <evidence-id>
henji diagnostics evidence show --id <diagnostic-id>
```

Use `failure_diagnostic_cli.ts` and its existing launcher. Change `henji_machine_launcher.sh` only if
repository dispatch actually requires it; do not update the installed launcher. Historical diagnostic
`85d...` has no raw artifact and must remain an honest no-link result.

### 5.4 OpenRouter compatibility

Change `openrouter_model.ts` to classify the final usage frame by meaning rather than exact key
absence.

Preserve the already accepted content-free usage form and accept the documented OpenRouter form:

- content-free assistant delta;
- repeated established terminal and native finish reasons;
- usage counters immediately before `[DONE]`;
- additional provider metadata that does not add assistant content, tool calls, or a provider error.

Continue rejecting actual new post-terminal assistant content, actual tool-call data, a provider
error event, or a changed terminal result. Preserve existing unrelated malformed JSON, media,
finish-reason, tool-argument, and missing-terminal behavior; do not redesign or build a matrix around
them in this increment.

Do not enumerate unobserved role values, empty-field permutations, or alternate ordering as a new
contract.

## 6. Implementation order

1. Re-read official references and write the FR0 results skeleton/readback.
2. Express the documented `fetch -> Response -> SSE` known answer and record the current
   `data_after_terminal` result. Do not retain the old failure expectation as the final contract.
3. Implement the credential-free evidence types and in-memory turn recorder.
4. Connect evidence storage, retained evidence ID, diagnostic link, and list/show readback.
5. Instrument the actual OpenRouter request, response, SSE, and parser path.
6. Repair final accounting-frame classification without changing real post-terminal-data rejection.
7. Add only the functional confirmations derived below.
8. Update results, user-facing README for evidence readback, concise `AGENTS.md` current work, and
   handoff.

## 7. Function-derived local confirmation

Use a real streamed `Response` from fake fetch; never bypass the provider boundary with a completed
`ModelResult`. Add one focused file, `tests/v0/provider_stream_compatibility_test.ts`, unless source
separation makes a second evidence-store file materially clearer.

Confirm these distinct product behaviors:

- documented text-final accounting reaches terminal `ModelResult` through fake fetch, HTTP 200,
  SSE framing, and the real parser with the correct request count;
- documented tool-call accounting preserves normal tool dispatch through the same transport;
- actual post-terminal content or tool-call data fails and identifies the exact saved event/field;
- success and failure artifacts correlate request, response bytes, SSE order, parser outcome,
  runtime result, and request counts;
- a parser failure's diagnostic ID resolves to the same retained artifact;
- dummy credential and Authorization values are structurally absent from evidence types, serialized
  artifact, and UI/readback while observed provider data remains intact;
- the current six smoke behaviors remain unchanged.

These are product behaviors, not a required number of `Deno.test` blocks. Do not add unobserved
provider permutations, unrelated parser tables, permission/filesystem matrices, or capacity tests.

Add a focused task such as `agent:provider-stream-compatibility:test` to `deno.v0.json` and include
the functional confirmation in `v0:test`.

During implementation run only:

```sh
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --quiet \
  --config deno.v0.json agent:provider-stream-compatibility:test
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --quiet \
  --config deno.v0.json v0:check
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --quiet \
  --config deno.v0.json v0:fmt
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --quiet \
  --config deno.v0.json v0:lint
git diff --check
```

Do not run `v0:test` or `v0:gate` as an intermediate check. Local confirmation uses no credential,
network, production command, retained acceptance state, machine state, or `_refs/*`.

## 8. Bounded functional review

After focused checks are green, perform one read-only review of changed lines for:

- functional correctness and the official OpenRouter accounting contract;
- regressions along the current text/tool/runtime/session path;
- complete diagnostic correlation from actual exchange to retained readback;
- concrete missing confirmation for a product behavior changed by this increment;
- credential/Authorization structural exclusion as the sole explicit safety requirement.

Do not request general safety hardening, filesystem/permission/adversarial/crash/quota/cleanup
analysis, coverage matrices, test-count targets, or Evidence-gap closure.

Accept a finding only when it has an authoritative basis, a current source-to-user-impact trace, and
a product correctness problem rather than merely a request for another test. Fix accepted findings,
then perform at most one narrow re-review of those changes and findings. Do not expand its scope.

## 9. One authoritative local gate

After the narrow re-review, the coordinating owner runs once:

```sh
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --quiet \
  --config deno.v0.json v0:gate
```

If it fails, use the corresponding focused command to identify the cause. A further full-gate run
requires a concrete stable-candidate change and a recorded reason; it is not automatic. The gate is
local evidence only.

## 10. Completion readback

The results document maps:

- baseline and current governance/document changes;
- each FR0 keep/change/remove/defer decision;
- official contract and documentation check date;
- pre-fix failure to post-fix full HTTP/SSE success;
- normal accounting versus actual post-terminal work;
- success/failure artifact and diagnostic correlation;
- credential/Authorization structural exclusion;
- source, focused confirmation, bounded review, and local gate results;
- current source/tests/docs and last documented repository/installed-launcher relationship;
- still-unverified real-provider shape and human tool use.

Complete locally only when the documented accounting frame succeeds through the full local
transport, actual mismatches are readable, current smoke behavior has no concrete regression,
focused checks/review/gate are complete, and the result is labelled `local implementation verified`
rather than `production compatible` or `human accepted`.

## 11. Deferred work and hard stops

Deferred:

- the failed real run's exact payload, until a later approved request creates new raw evidence;
- retention quota and cleanup policy, until actual operation establishes requirements;
- D0, FR2+, installed integration, real tool completion, and daily-use suitability.

This plan stops before implementation approval. Even after local implementation approval it does
not authorize:

- credential access or provider/network requests;
- production `henji`;
- installed launcher/state read, update, or rollback;
- retained acceptance workspace/session/diagnostic/evidence cleanup;
- `_refs/*` access;
- dependency/lockfile changes;
- D0 or FR2+ work;
- commit, push, tag, publish, or release.
