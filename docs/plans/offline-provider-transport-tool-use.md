# Henji Harness roadmap step 6 implementation plan

## Concept review request

None.

The delivered Revision 13 planner input is newer than the repository's milestone 5 stop-state in
`AGENTS.md` and `.handoff/handoff.md`. This is an expected gate transition, not a product
contradiction: Human Gate 1 authorizes this plan only, while source work remains blocked until Human
Gate 2. After Human Gate 2, the repository owner must record the approved plan and step 6 ownership
before the implementation writer starts.

## Recommended plan and assumptions

Use an additive, agent-specific OpenRouter adapter under `v0/agent/`. It will implement the existing
provider-neutral `Model` contract and reuse the current `PROFILE` and bounded response reader from
`v0/model.ts`, while leaving the legacy and `basic run` `ModelRequest`, provider functions, CLI
composition, budget/attempt paths, and agent loop unchanged. This avoids a premature migration of two
different request contracts and keeps step 6 offline and reversible.

Confirmed facts:

- `runAgent` already supplies the complete causal transcript and stable registry definitions to one
  `Model.generate` call per step, dispatches tool calls sequentially, and enforces the default
  `maxSteps = 8` bound.
- `v0/model.ts` owns the fixed OpenRouter endpoint/profile, `stream: false`, 1,024 completion-token
  cap, retry value `0`, a 256 KiB provider-request cap, a 1 MiB response cap, and a 30 second
  transport deadline. Its current response decoder only accepts assistant text.
- The pinned Deno example at commit `eb8f78e90dbc72f3b3ab7dcd85609622379b5bca`
  confirms the comparison shape: function tools in request `tools`, assistant `tool_calls` with JSON
  string arguments, and `role: "tool"` messages linked by `tool_call_id`.
- Existing direct agent tests cover the provider-neutral contract, causal transcript, registry,
  finite steps, and fixture CLI. Existing `v0_test.ts` covers the legacy/basic transport and its
  credential, redaction, request-count, timeout, and size boundaries.

Reversible implementation assumptions:

- The new adapter supports the existing contract's one-or-more tool calls, processed sequentially by
  `runAgent`; it does not add parallel tool-call policy or provider options.
- A response choice is valid only when it contains exactly one effective result: non-empty assistant
  text or a non-empty array of supported function tool calls. Mixed text/tool-call results, multiple
  choices, missing results, non-function calls, and other content shapes fail closed.
- Tool arguments may be any finite `JsonValue`, matching the current provider-neutral contract; the
  fixed tool remains responsible for requiring its object schema.
- Tool-result `outcome` and tool name remain internal. The wire tool-result message contains the
  protocol-required `tool_call_id` and text `content`; causality and name are retained by the preceding
  assistant tool-call message and the provider-neutral transcript.
- No production composition root is added. Constructor/factory options may inject a fake `fetch`,
  dummy credential source, endpoint, timeout, and parent signal for direct tests, but model requests
  and tool output cannot select them. Production defaults remain host-owned.

## Ownership and sequence

### 1. Activate the approved slice at Human Gate 2

Outcome: repository instructions and resume state authorize exactly this plan before code changes.

Ownership and files:

- Repository owner/default agent: `AGENTS.md` and `.handoff/handoff.md` only for the gate transition.
- Record this plan's path and SHA-256, step 6 scope, implementation writer ownership, unchanged
  credential/provider boundaries, and the next explicit gate. Do not copy the requirements body into
  handoff.

Dependency: explicit Human Gate 2 approval of this exact plan. Until then, stop after planning.

Verification: reread the current-phase section and the target handoff Record/checkpoint and confirm
that they no longer prohibit the approved local implementation while still prohibiting real provider
calls, credential access, dependencies, persistent state, commit, push, and release.

### 2. Add the bounded agent transport adapter

Outcome: an offline-composable `Model` implementation deterministically maps the existing agent
contract to and from the fixed OpenAI-compatible chat-completions wire shape.

Ownership and files:

- Implementation writer: new `v0/agent/openrouter_model.ts`.
- Reuse `PROFILE` and `readBoundedResponse` from `v0/model.ts`; do not change existing exports or
  behavior unless direct evidence during implementation requires a plan delta.

Implementation contract:

- Encode each transcript item in order:
  - user text as `{ role: "user", content }`;
  - assistant final text as `{ role: "assistant", content }`;
  - assistant tool calls as one assistant message with `content: null` and ordered `tool_calls`, each
    preserving `id`, `type: "function"`, function `name`, and `JSON.stringify(arguments)`;
  - each tool result as an ordered `{ role: "tool", tool_call_id, content }` message.
- Encode registry definitions in stable input order as
  `{ type: "function", function: { name, description, parameters } }`, preserving the supplied JSON
  input schema. Send the fixed `model`, `stream: false`, and `max_completion_tokens: 1024`; do not add
  provider routing, fallback, retry, or caller-selected model fields.
- Validate the agent request before `fetch`: supported roles/content, non-empty call IDs/names,
  JSON-serializable finite values, the existing 76 KiB serialized-message bound, and the 256 KiB full
  body bound. A preflight failure performs zero requests.
- Resolve the credential only through a host-owned credential source. The production default reads
  exactly `PROFILE.secretEnv`; tests inject either a dummy value or a source returning missing. Missing
  credentials fail before `fetch`. Never place the credential in the body, result, error, or trace.
- Perform at most one injected `fetch` per `generate` call with the fixed POST endpoint, only
  `content-type` and Bearer authorization headers, `redirect: "error"`, no application retry, and a
  deadline covering headers plus the complete bounded body read. Preserve parent abort behavior.
- Decode only the first and sole choice's assistant message. Convert a non-empty string `content` to
  `{ kind: "final" }`. Convert a non-empty supported `tool_calls` array to
  `{ kind: "tool_calls" }`, validating every call ID, function name, `type: "function"`, arguments
  string, JSON parse, and finite `JsonValue` before returning any call.
- Convert transport, HTTP, bounded-body, JSON, and unsupported-shape failures to one sanitized adapter
  error surface. It may retain a safe status/provider code and request count for direct observation,
  but must not retain the Authorization header, credential, or full provider body. `runAgent` will
  normalize a thrown adapter failure to its existing `contract_failure` terminal result.

Dependency: increment 1. This increment does not modify `runAgent`, `Registry`, either CLI, state, or
the old transport contract.

Verification: type-checking in increment 4 plus the direct tests in increment 3. The key observable is
that the adapter makes zero or one request for each call to `generate` and returns only current
`ModelResult` variants.

### 3. Lock the wire contract with offline direct tests

Outcome: injected fake-fetch tests prove H-021 without environment access, network, credentials, or
persistent state.

Ownership and files:

- Implementation writer: new `tests/v0/agent_openrouter_model_test.ts`.
- Do not modify `tests/v0/agent_loop_test.ts` or `tests/v0/v0_test.ts`; they remain independent
  regression evidence for the existing contracts and paths.

Direct test cases:

1. A one-response text-only fake returns a valid assistant string. Assert one fetch, exact fixed
   endpoint/method/headers/body controls, deterministic user message and tool definition encoding, a
   final `ModelResult`, and absence of credential/body leakage from the result.
2. Compose the adapter with `runAgent`, `Registry`, and `createFixtureTool`. A scripted fake fetch
   returns one assistant function tool call and then final text. Assert exactly two requests; request
   one contains the fixed tool definition; request two contains the original user message, assistant
   `tool_calls` with the same call ID/name/JSON arguments, then the matching tool result with
   `tool_call_id` and uppercase text. Assert the loop reaches final text with two steps and one tool
   call/result.
3. Decode valid JSON arguments directly, then table-test invalid JSON, missing/blank call ID,
   missing/blank function name, non-function call, multiple choices, mixed text/tool calls, missing
   message/result, and empty effective result. Each case makes one request, fails safely, returns no
   partial calls, and does not expose an injected credential or marker provider body.
4. Return a body larger than 1 MiB from fake fetch and assert bounded failure and stream cancellation;
   separately stall or abort a fake body under a short injected timeout and assert the deadline remains
   active through body consumption.
5. Make fake fetch reject and return a non-OK response in separate cases. Assert exactly one request
   per `generate`, no retry/fallback, and sanitized failure text without response body or authorization.
6. Inject a credential source returning missing and a fetch spy. Assert request count zero and a safe
   missing-credential failure. The test process itself runs without `--allow-env` and `--allow-net`, so
   all successful transport cases must use only a dummy injected credential and fake fetch.
7. Exercise oversized/invalid request preflight and assert request count zero, preserving the 76 KiB
   message and 256 KiB full-body limits.

Dependency: increment 2. Prefer small fixtures local to this test file; add no server, SDK, snapshot,
or dependency.

Verification command after implementation:

```sh
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno test --no-prompt tests/v0/agent_openrouter_model_test.ts
```

The command must pass without environment or network permissions. Fake fetch request counts and parsed
bodies are the direct evidence; a test merely reaching final text is insufficient.

### 4. Integrate the direct test into the local gate

Outcome: the new adapter and direct test participate in repeatable checks while all existing gates stay
intact.

Ownership and files:

- Implementation writer: `deno.v0.json`.
- Add an `agent:transport:test` task using the exact permission-free command from increment 3.
- Add `v0/agent/openrouter_model.ts` and `tests/v0/agent_openrouter_model_test.ts` to the explicit
  `v0:check` inputs.
- Add the new direct task to `v0:gate` before the existing full `tests/v0` invocation. Preserve
  `agent:test`, formatting, linting, and all existing test invocations and permissions.

Dependency: increments 2 and 3.

Verification, in order:

```sh
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --config deno.v0.json agent:transport:test
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --config deno.v0.json agent:test
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --config deno.v0.json v0:gate
```

Record test counts and exact pass/fail output. Do not make a real provider call, inspect environment
credentials, or treat the existing `--allow-net` full-suite permission as evidence for this slice; the
permission-free direct task is the isolation evidence.

### 5. Produce the acceptance evidence and bounded independent review

Outcome: Human Gate evidence maps every step 6 acceptance condition to observable offline results and
an independent review decision.

Ownership and files:

- Implementation writer/default agent: new
  `docs/plans/offline-provider-transport-tool-use-results.md` and the target Record/checkpoint in
  `.handoff/handoff.md` when state changes.
- Independent reviewer: read-only review of the approved plan and exact implementation diff. The
  reviewer must not modify files or expand into step 7/provider acceptance.

Acceptance evidence must include the approved plan SHA-256, changed-file list, direct fake-fetch body
observations for both requests, request counts for success and failure paths, finite-limit outcomes,
credential/network isolation, direct-test and full-gate results, deviations, review findings and their
disposition, and remaining risks. Do not include Authorization values, provider bodies, or environment
credential observations.

Bounded review request (30 minutes; stop after 10 minutes without new evidence):

- Verify provider-neutral-to-wire mapping for tools, assistant calls, tool results, final text, and
  causal order against the pinned snapshot only.
- Trace credential and endpoint ownership, redaction, zero-request preflight, one-request-per-step,
  retry/fallback zero, 76 KiB/256 KiB/1 MiB bounds, and deadline-through-body behavior.
- Verify the adapter satisfies the existing `Model` without reimplementing `runAgent`/`Registry`, and
  that basic, legacy `run`/`acceptance`, fixture CLI, dependencies, lockfile, and persistent state remain
  unchanged.
- Report only evidence-backed Blocker, P1, or P2 findings with file/line and source-to-impact. Return
  `GO` only when none remain. One changed-lines-only re-review is limited to 15 minutes; new scope is
  allowed only for a new Blocker/P1 source-to-impact.

Dependency: increment 4 passes. Human Gate 2 authorizes implementation, local validation, and this
bounded review only; it does not authorize provider acceptance.

## Migration, compatibility, and rollback

- Migration is additive and stateless. No schema, dependency, lockfile, credential, account, endpoint,
  attempt, session, or persisted-data migration occurs.
- The legacy `v0/model.ts` request types/functions and `basic run`, legacy `run`/`acceptance`, fixture
  agent CLI, `runAgent`, and `Registry` retain their public behavior. The new adapter has no CLI or
  production composition root in step 6.
- If the adapter or gate regresses before acceptance, rollback consists of removing the new adapter and
  direct test, removing only their task/check entries from `deno.v0.json`, and restoring the prior
  current-phase/handoff state. No data recovery or provider cleanup is required because the slice writes
  no state and performs no real request.
- A discovered need to change the old transport contract, loop semantics, provider/model, dependency,
  real credential/network path, or persistent state is a `plan-delta` or `concept-review`; stop rather
  than folding it into this slice.

## Completion conditions

Step 6 is ready for its next human gate only when all of the following are true:

- The permission-free text-only and two-request tool-round direct tests pass and expose the required
  wire payloads and causal IDs.
- Valid arguments and every required invalid/unsupported/bounded response case have direct assertions,
  with no credential, Authorization, or full provider-body leakage.
- Missing credential and invalid/oversized preflight perform zero requests; each started model step
  performs exactly one request and no retry or fallback.
- Existing agent direct tests and the complete `v0:gate` pass unchanged.
- The changed-file set contains only the gate-state documents, new adapter/test/results document, and
  `deno.v0.json`; dependency and lockfile diffs are absent.
- Independent review returns `GO` with no unresolved Blocker, P1, or P2 finding, and the acceptance
  evidence records deviations and remaining risks.
- No real provider call, credential inspection, production agent CLI, persistent state change, commit,
  push, release, or roadmap step 7 work has occurred.

## Deferred risks and decisions

- Real OpenRouter/model compatibility, account behavior, provider-specific quirks, and the本人task remain
  unobserved until a separately authorized step 7 acceptance gate.
- Streaming, usage/reasoning/image content, provider routing, multiple providers, Responses API,
  parallel tool-call policy, sessions, and practical tools remain outside this plan.
- The old and agent request contracts remain deliberately separate. Reconsidering a shared transport
  core is deferred until duplication causes a demonstrated maintenance or correctness problem.
