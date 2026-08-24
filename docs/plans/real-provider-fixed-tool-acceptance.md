# Henji Harness roadmap step 7 implementation and acceptance plan

## Concept review request

None.

Revision 14 and Human Gate 1 are newer than the repository's accepted step 6 stop-state in
`AGENTS.md` and `.handoff/handoff.md`. That is an expected staged transition, not a product
contradiction. This document plans the local implementation/review gate and the later provider-attempt
gate separately; it authorizes neither.

## Recommended plan and assumptions

Add one production-only composition root around the accepted `OpenRouterAgentModel`, `runAgent`,
`Registry`, and `createFixtureTool`. Keep `OpenRouterAgentModel`, the provider-neutral loop, the fixed
tool, legacy/basic paths, dependencies, and state unchanged. The composition root will enforce the
fixed step 7 contract at each model response and count calls through a host-owned wrapper around the
adapter's `fetch` seam. This prevents an unexpected first response from being dispatched or causing a
second request, and prevents any second-step tool call from causing a third request.

Confirmed repository evidence:

- Step 6 is accepted with permission-free fake-fetch tests, 10 transport tests, 12 existing agent
  tests, 54 full v0 tests, and changed-lines-only review `GO`; H-021 is supported.
- `OpenRouterAgentModel` already fixes `PROFILE.model`, endpoint default, POST, `stream: false`, 1,024
  completion tokens, 30 second default timeout, response/request bounds, one fetch per `generate`,
  credential lookup through exactly `PROFILE.secretEnv`, and sanitized errors with per-call request
  count `0 | 1`.
- `runAgent` accepts `maxSteps`, catches model failures into a terminal contract failure, and issues
  one `Model.generate` per step. Its generic behavior permits multiple tool calls, so the stricter
  one-call acceptance policy belongs in the new composition boundary rather than the shared loop.
- `createFixtureTool` is the required deterministic `uppercase_text` implementation and `Registry`
  exposes stable definitions.
- No production agent CLI or real-provider composition currently exists.

Fixed acceptance constants, copied without alteration from Revision 14:

- Task: `Use the uppercase_text tool exactly once to convert the following ASCII text to uppercase. After receiving the tool result, reply with exactly that result and nothing else: henji harness step seven`
- Tool and exact arguments: `uppercase_text`, `{ "text": "henji harness step seven" }`
- Local tool result and final text: `HENJI HARNESS STEP SEVEN`
- Success tuple: outcome/stop reason `final`, model steps `2`, tool calls `1`, tool results `1`,
  application external requests `2`, retry `0`, fallback `0`.

Reversible implementation assumptions:

- The CLI accepts the task as an explicit `--task` value so the approved command is auditable, but
  also validates byte length and exact equality with the fixed task before credential lookup or fetch.
- A required `--confirm-external-call` flag protects the production entrypoint from accidental use;
  the later provider gate still remains the authority for the one attempt.
- A first response is accepted only when it contains exactly one `uppercase_text` call with exactly
  the fixed JSON value. Initial final text, unknown/multiple calls, or different arguments fail after
  request 1 with no request 2. A second response is accepted only when it is the exact final text;
  another tool call or different text fails after request 2 with no request 3.
- Application request count means invocations of the production composition's counted fetch wrapper.
  It is emitted only as an integer; URL, headers, credential, and response bodies are never retained.
- Success/failure output is one allowlisted JSON object. It omits transcript, wire bodies, headers,
  credential, raw provider body, and arbitrary thrown values. Exact final text is emitted only on
  success; failure emits a stable sanitized code/message and the finite counters.

## Ownership and ordered increments

### 1. Activate local implementation at Human Gate 2

Outcome: current repository instructions authorize this exact plan through implementation, offline
validation, and bounded review, while continuing to prohibit a real provider attempt.

Ownership and files:

- Repository owner/default agent: `AGENTS.md` and the target Record/checkpoint in
  `.handoff/handoff.md` for the gate transition only.
- Record this plan path and SHA-256, the implementation-writer file set below, the local/review stop
  point, and the separate provider-attempt gate. Do not duplicate the fixed requirements into handoff.

Dependency: explicit Human Gate 2 approval of this exact plan.

Verification: reread the current-phase section and target handoff Record. They must authorize only the
local files/tests/review in increments 2–5 and must still prohibit credential presence checks, network,
provider calls, dependencies, persistent runtime state, commit, push, release, and step 8.

### 2. Add the fixed production composition root

Outcome: one narrowly callable CLI can run the fixed two-step acceptance flow and report an auditable,
sanitized terminal result.

Ownership and files:

- Implementation writer: new `v0/agent/real_provider_acceptance.ts`.
- Do not modify `v0/agent/openrouter_model.ts`, `loop.ts`, `tools.ts`, `contracts.ts`, `v0/model.ts`, or
  existing CLIs unless implementation evidence requires a plan delta.

Implementation contract:

- Define the fixed task, tool input, expected tool result/final text, and task byte cap as module-owned
  constants. Parse exactly one `--task VALUE` and one `--confirm-external-call`; reject missing,
  duplicate, unknown, oversized, or non-exact task input before constructing the production model.
- Build `Registry([createFixtureTool()])` only. Call `runAgent(fixedTask, guardedModel, registry,
  { maxSteps: 2 })` only once. Add no retry, fallback, continuation, task repair, or attempt persistence.
- Construct the accepted `OpenRouterAgentModel` with production defaults. Wrap its host-owned fetcher
  with a counter that increments immediately before delegating to the global `fetch`; do not accept an
  endpoint/model/credential/timeout/generation option from CLI input, task, tool result, or model output.
  For direct tests only, a typed dependency seam may inject fake fetch, dummy credential/source, and a
  shorter timeout.
- Guard the wrapped model's ordinal responses before returning them to `runAgent`:
  1. ordinal 1 must be exactly one call named `uppercase_text` with exactly
     `{ text: "henji harness step seven" }`;
  2. ordinal 2 must be final text exactly `HENJI HARNESS STEP SEVEN`;
  3. any other result throws a stable sanitized acceptance-contract error.
  This check occurs before registry dispatch, so multiple/unexpected calls cannot trigger request 2.
  The second-result check occurs before loop continuation, so request 3 is impossible.
- After the loop, validate the complete success tuple rather than trusting `outcome.ok` alone:
  `final/final`, steps 2, tool-call/result counts 1/1, request count 2, exact final text, and the
  transcript's one matching successful local result. A mismatch returns exit 1 and never retries.
- Emit one JSON line and return exit 0 only for the complete tuple. The allowlisted fields are:
  `ok`, `profile`, `outcome`, `stopReason`, `steps`, `toolCallCount`, `toolResultCount`,
  `requestCount`, and on success `finalText`; on failure use only `error: { code, message }`.
  Do not serialize the loop transcript or exception object. Normalize adapter/loop/validation failures
  to stable messages that cannot contain a credential, Authorization header, or provider body.
- The production adapter alone reads `PROFILE.secretEnv`. Parsing, confirmation, fixed-task validation,
  registry construction, result validation, and terminal formatting do not read environment values.

Dependency: increment 1. All new logic is additive and state-free.

Verification: increment 3's permission-free direct tests prove the composition seam; increment 4
type-checks and gates the production source without running its production entrypoint.

### 3. Add permission-free local composition tests

Outcome: fake fetch and a dummy credential prove the exact acceptance behavior before any credential
or network gate opens.

Ownership and files:

- Implementation writer: new `tests/v0/real_provider_acceptance_test.ts`.
- Reuse existing test helpers and small local fake-fetch fixtures. Do not start an HTTP server and do
  not grant environment or network permission.

Direct test cases:

1. Exact success E2E: invoke the composition with the fixed task, confirmation, fake fetch, and dummy
   credential. Script the accepted tool call then exact final response. Assert exit 0, one JSON line,
   request count exactly 2, retry/fallback behavior of zero extra calls, steps 2, calls/results 1/1,
   exact final text, and the causal second request containing the one local uppercase result.
2. Initial final: return even the expected final text on response 1. Assert exit 1, request count 1,
   no tool dispatch/result, no second fetch, and sanitized `acceptance_contract` failure.
3. Unexpected first response table: multiple calls, another tool name, wrong arguments, and duplicate
   fixed calls. Assert failure after exactly one fetch and no local dispatch that can continue the loop.
4. Second-step bound: after one valid tool call, return another tool call, multiple calls, wrong final
   text, or empty/unsupported output. Assert exit 1, request count exactly 2, no third fetch, and no
   successful final tuple. The second tool-call case is the direct `maxSteps: 2`/no-third-request
   evidence.
5. Credential and transport failures: inject a missing credential source and assert zero fetches;
   inject first-request rejection/HTTP/timeout and assert one fetch; inject the same failures on the
   second response and assert two fetches. All terminal errors must use the allowlisted schema.
6. CLI/preflight table: missing confirmation, missing/duplicate/unknown flags, missing task value,
   oversized task, and non-exact task all fail with request count 0 and without invoking the credential
   source.
7. Count/postcondition mismatch: exercise the pure final evaluator or a bounded injected seam with an
   otherwise successful loop outcome and count other than 2. Assert exit 1 and no continuation.
8. Redaction/schema: recursively assert the output keys are allowlisted and serialized output contains
   neither the dummy credential nor injected provider-body/Authorization markers. Assert transcript,
   headers, request/response body, and arbitrary exception properties are absent.

Dependency: increment 2.

Permission-free verification command after implementation:

```sh
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno test --no-prompt tests/v0/real_provider_acceptance_test.ts
```

The direct command is the evidence that local validation does not read production environment values
or connect to a network. Test success alone is insufficient without asserted fetch counts and output
schema.

### 4. Integrate the local gate without opening the provider gate

Outcome: the production source and permission-free direct test are checked by normal local validation;
the provider command exists but is never invoked by any gate.

Ownership and files:

- Implementation writer: `deno.v0.json`.
- Add `agent:acceptance:test` using the exact permission-free command in increment 3.
- Add `v0/agent/real_provider_acceptance.ts` and
  `tests/v0/real_provider_acceptance_test.ts` to the explicit `v0:check` inputs.
- Add `agent:acceptance:test` to `v0:gate` before the existing full-suite invocation. Preserve the
  existing transport/agent direct tests, formatting, lint, full tests, and their current permissions.
- Add a separate `agent:acceptance` task for the production entrypoint with only
  `--allow-env=HENJI_OPENROUTER_API_KEY` and `--allow-net=openrouter.ai`. It must require the task and
  confirmation arguments at invocation. No local test/gate task may depend on or invoke it.

Dependency: increments 2 and 3.

Local verification sequence after implementation:

```sh
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --config deno.v0.json agent:acceptance:test
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --config deno.v0.json agent:transport:test
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --config deno.v0.json agent:test
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --config deno.v0.json v0:gate
git diff --check
```

Record exact counts and pass/fail results. Inspect the diff to confirm no dependency/lockfile,
provider/profile, state, legacy/basic, adapter, loop, registry, fixed-tool, or unrelated source changes.
Do not run `agent:acceptance`, inspect the credential environment, or make any network request during
this increment.

### 5. Produce local evidence and obtain bounded independent review

Outcome: a self-contained local/review package establishes whether the separate real-provider gate may
be presented, without opening it.

Ownership and files:

- Implementation writer/default agent: new
  `docs/plans/real-provider-fixed-tool-acceptance-results.md`; repository owner updates the target
  handoff Record/checkpoint only when state changes.
- Independent reviewer: read-only review of the exact approved plan and implementation diff.

The local section of the results document records the plan SHA-256, changed-file list, fake-fetch
request counts and causal payload observations, all failure/no-extra-request cases, output-schema and
redaction evidence, verification commands/counts, deviations, and review disposition. It must clearly
state `provider acceptance not run` and contain no credential presence/value observation or raw
provider data.

Bounded review request (30 minutes; stop after 10 minutes without new evidence):

- Trace the fixed task/tool/arguments/result/final invariants through CLI parsing, guarded model,
  registry dispatch, loop call, complete-tuple validation, exit code, and JSON output.
- Verify `maxSteps: 2`, first/second response guards, exact aggregate request count, and absence of
  retry, fallback, automatic continuation, third request, task repair, or caller-selected profile.
- Trace credential/endpoint ownership and redaction; verify local tests need no env/net and the
  production task is not reachable from a gate.
- Verify existing adapter/agent/basic/legacy behavior, dependencies, lockfile, and persistent state are
  unchanged.
- Report evidence-backed Blocker, P1, or P2 only, with file/line and source-to-impact. Return `GO` only
  with zero remaining. One changed-lines-only re-review is limited to 15 minutes; expand only for a new
  Blocker/P1 source-to-impact.

Dependency: increment 4 passes. Any unresolved review finding blocks the provider gate.

### 6. Prepare the separate provider-attempt gate

Outcome: default presents a current, bounded one-attempt package for explicit user approval. This is a
read-only preparation stage except for recording the gate decision after it occurs.

Preconditions: local gate passes, independent review is `GO` with Blocker/P1/P2 zero, results document
is complete, and no provider attempt has occurred.

Immediately before asking for approval, default must:

1. Verify from current official OpenRouter metadata that `PROFILE.model` is available through the fixed
   `https://openrouter.ai/api/v1/chat/completions` endpoint and supports the required chat-completions
   function/tool-call wire shape. Do not change the profile if the evidence disagrees; stop and return
   the mismatch for user/concept review.
2. Verify current official input/output pricing and calculate a conservative maximum for exactly two
   requests using the fixed request bounds and `max_completion_tokens: 1024` per request. Present the
   source time, calculation, currency, and maximum to the user. Do not rely on the older
   `PROFILE.worstCaseUsd` without refreshing official prices.
3. Perform a non-echoing presence-only check for `HENJI_OPENROUTER_API_KEY` in the exact process
   environment. Record only `present` or `missing`; never print, copy, hash, compare, log, or persist the
   value. Missing stops before the command and makes zero requests.
4. Reconfirm the exact model/profile ID, endpoint, task, allowed tool, expected tuple, maximum two
   requests, 30 second timeout per request, 1,024-token cap per request, retry/fallback zero, maximum
   cost, production command, success conditions, and stop conditions.
5. Ask for explicit approval of one attempt. Approval of implementation/review, metadata lookup, or
   credential presence check is not approval to run the command.

The exact production command to present is:

```sh
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --quiet --config deno.v0.json agent:acceptance --confirm-external-call --task 'Use the uppercase_text tool exactly once to convert the following ASCII text to uppercase. After receiving the tool result, reply with exactly that result and nothing else: henji harness step seven'
```

Before the provider gate, verify locally that Deno 2.9.4 passes the task and confirmation arguments
as written after the task name, without a post-task literal `--`. The permission-safe regression probe
must invoke the task-runner layer with an invalid preflight-only argument, capture exit status/stdout/
stderr, and prove exit 1, one sanitized input error, and empty stderr before model construction or
fetch. This probe does not read credentials or contact a provider.

Gate stop conditions before any request: official model/endpoint/tool capability cannot be confirmed,
price/maximum cost cannot be established, credential is missing, local/review evidence has regressed,
the command or fixed constants differ, or user approval is absent.

### 7. Execute once and perform bounded readback

Outcome: after the separate explicit approval, one command yields either the exact H-022 success tuple
or one terminal failure with no follow-up call.

Execution owner: default agent in `ai-dev`, using the exact approved command once. Do not enable shell
tracing, redirect environment, add flags, retry, repair the task, switch model/profile, or run a second
diagnostic provider command.

Readback procedure:

1. Capture only exit status, stdout's one allowlisted JSON line, and whether stderr is empty. Do not
   record environment, request headers/bodies, raw response, or network trace.
2. Accept the attempt as H-022 evidence only when exit status is 0 and the parsed JSON is exactly
   compatible with: `ok: true`, fixed `PROFILE.id`, `outcome: "final"`,
   `stopReason: "final"`, `steps: 2`, `toolCallCount: 1`, `toolResultCount: 1`,
   `requestCount: 2`, and `finalText: "HENJI HARNESS STEP SEVEN"`.
3. Confirm the output key allowlist and absence of credential/header/body/transcript fields without
   reading the credential value. Record the current official metadata/pricing citations, approved cost
   ceiling, command, exit status, sanitized JSON, and pass/fail interpretation in the results document.
4. Any nonzero exit, malformed output, stderr, request count other than 2, initial final, wrong/multiple
   tool behavior, timeout/transport/HTTP/contract failure, or final mismatch is one failed attempt.
   Stop. Do not retry or issue a diagnostic provider request. Return the sanitized evidence and the
   next decision to the user.
5. User acceptance is the final gate. Only the user may mark H-022 supported and step 7 accepted from
   an exact success. A failed attempt does not authorize changes or another attempt.

Dependency: a distinct explicit provider-attempt approval after increment 6.

## Failure handling, compatibility, and rollback

- Input/confirmation/credential preflight failures are request 0. First-response failures are request
  1. Second-response failures are request 2. Every path is terminal; no path may automatically retry,
  fallback, repair, or continue.
- Implementation is additive and stateless. It adds no schema, attempt record, budget ledger, account
  change, dependency, lockfile, or data migration. The only external side effect, if separately
  approved, is at most two billed provider requests in one attempt.
- Existing `OpenRouterAgentModel`, `runAgent`, `Registry`, fixed fixture CLI, legacy/basic paths, and
  step 6 direct tests retain their public behavior. The production composition is reached only through
  its explicit task and confirmation gate.
- Before a provider attempt, rollback removes the new composition source/test/results entries and only
  their `deno.v0.json` task/check/gate changes, then restores the prior AGENTS/handoff stop-state. No
  data or provider cleanup is needed.
- After a provider attempt, local code rollback is the same, but the provider calls and cost cannot be
  undone. Preserve only sanitized attempt evidence and do not claim monetary rollback.
- A need to change the fixed task/tool/expected tuple, profile/model/endpoint, dependency, shared loop or
  adapter semantics, persistent state, or step 8 scope is a plan delta or concept review. Stop rather
  than substituting a new design.

## Completion conditions

Local/review completion, before the provider gate, requires all of:

- The new composition reuses the accepted adapter/loop/registry/tool, fixes `maxSteps: 2`, validates
  the complete tuple, counts fetch starts, and emits only sanitized allowlisted output.
- Permission-free fake-fetch tests directly prove success requests 1→2 and every required
  zero/one/two-request failure without an extra call.
- New direct tests, accepted transport tests, existing agent tests, full `v0:gate`, and
  `git diff --check` pass; dependencies, lockfile, state, profile, endpoint, shared adapter/loop/tool,
  and unrelated files are unchanged.
- Independent review returns `GO` with no Blocker/P1/P2 remaining, and results explicitly say provider
  acceptance has not run.

H-022/step 7 can be presented for user acceptance only when, additionally:

- Current official metadata/pricing, non-echoing credential presence, exact command/constants, maximum
  cost, and stop rules were presented and separately approved.
- Exactly one production command ran, made exactly two application requests, returned the exact
  steps/tool counts/final text tuple with exit 0, emitted no credential-sensitive fields, and caused no
  retry, fallback, task/profile change, or follow-up provider call.
- The results document contains only sanitized readback and the user makes the final acceptance
  decision.

## Deferred risks and decisions

- Current model availability, pricing, account routing, and real OpenRouter tool-call behavior remain
  deliberately unverified during planning/local work and must be refreshed at the separate gate.
- Provider nondeterminism can make the one allowed attempt fail despite correct local behavior. The
  fixed task, no-retry rule, and separate user decision are retained rather than hidden by repair.
- Streaming, usage/reasoning/image shapes, parallel tool policy, long conversations, other tools,
  provider abstraction/Responses API, sessions, extensions, self-revision, and roadmap step 8 remain
  outside this plan.
