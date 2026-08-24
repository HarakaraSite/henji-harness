# Henji Harness roadmap step 7 local results

## Scope and authorization

- Approved plan: `docs/plans/real-provider-fixed-tool-acceptance.md`
- Approved plan SHA-256 after the plan-authorized invocation-syntax local-fix:
  `4e09b0cd0c31df242dbd2bef9c3687e66a31e1f0c4a723d4cbb465d8bfd9cd9d`
- Superseded pre-fix local-slice plan SHA-256: `5fac961d90e1442b93237b53e5f92e9624777749784923011caa503f6e1459f7`
- Slice: Revision 14 / roadmap step 7 fixed real-provider composition and local evidence only
- Human Gate 2: approved for local implementation, permission-free tests, local gates, and bounded
  independent review
- Provider acceptance: one successful bounded attempt recorded and accepted by the user; H-022 is supported.
- The credential came from the existing 0600 guest file; its value was not displayed or recorded.
  No credential presence/value observation was recorded beyond that supplied source fact. No raw
  provider data, request headers, or response body was recorded; no retry or follow-up occurred.
- No dependency, lockfile, persistent state, commit, push, release, or roadmap step 8 work was performed.
  The local regression suite used only its existing local test fixtures.

## Changed files owned by this slice

- `v0/agent/real_provider_acceptance.ts` (new fixed composition root)
- `tests/v0/real_provider_acceptance_test.ts` (new permission-free direct tests)
- `deno.v0.json` (local test/check/gate tasks and separate production task)
- `docs/plans/real-provider-fixed-tool-acceptance.md` (reviewer P1 invocation-syntax local-fix)
- `docs/plans/real-provider-fixed-tool-acceptance-results.md` (this package)
- `AGENTS.md` and `.handoff/handoff.md` (Human Gate 2 local-slice transition/checkpoint)

The accepted adapter, provider-neutral loop, registry, fixture tool, existing CLIs, profile, and
legacy paths were not changed. Existing dirty worktree content was preserved.

## Local implementation evidence

The new composition is additive and state-free. It fixes the approved task, `uppercase_text` tool,
input text, expected local result, expected final text, and a 1,024-byte task cap. It requires exactly
one `--task VALUE` and `--confirm-external-call`, rejects malformed or non-exact input before model
construction, builds only the fixed fixture registry, and calls `runAgent` once with `maxSteps: 2`.

The guarded model accepts only one exact tool call on response 1 and only the exact final text on
response 2. The fetch wrapper counts starts immediately before delegation. Complete success requires
the final outcome tuple, one successful matching tool result in the four-message transcript, and
exactly two counted requests. There is no retry, fallback, task repair, continuation, or third request.

Terminal JSON is one line with an allowlisted schema. Failures use only stable sanitized
`acceptance_input` or `acceptance_contract` errors; transcript, headers, request/response bodies,
credential values, Authorization data, and arbitrary exception properties are not serialized.
The production adapter is the only environment credential reader. Direct tests inject only a dummy
credential and fake fetch.

## Permission-free direct evidence

`agent:acceptance:test` runs without `--allow-env` or `--allow-net` and passed 10 tests:

1. Exact fixed acceptance: two fake-fetch requests, one tool call/result, two model steps, exact final
   text, and the second request observes the causal local tool result.
2. Initial final response: one request, no dispatch/result, no second request.
3. Unexpected or multiple first calls: one request and no second request.
4. Unexpected second tool/multiple call/wrong or empty final: two requests and no third request.
5. Missing credential: zero fetches; first transport rejection: one request.
6. Second transport rejection and HTTP failure: two requests.
7. First/second HTTP and body-deadline failures: one/two requests, bounded without extras.
8. Missing, duplicate, unknown, oversized, non-exact, and malformed CLI input: zero requests and no
   credential-source read.
9. Complete-tuple evaluator rejects a request-count mismatch.
10. Output keys are recursively allowlisted and injected credential/provider-body/header/transcript
    markers are absent.

The successful fake-fetch observation was exactly two requests. The second request contained the
causal message roles `user`, `assistant`, `tool`, with the fixed local result
`HENJI HARNESS STEP SEVEN`; the emitted success tuple was `final` / `final`, steps `2`, tool calls
`1`, tool results `1`, requests `2`, and final text `HENJI HARNESS STEP SEVEN`.

## Reviewer P1 invocation-syntax local-fix

The pre-fix acceptance command placed a literal `--` after the task name. The plan-authorized fix
changed it to the exact task-runner command below, adding `--quiet` and removing that post-task
literal:

```text
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --quiet --config deno.v0.json agent:acceptance --confirm-external-call --task 'Use the uppercase_text tool exactly once to convert the following ASCII text to uppercase. After receiving the tool result, reply with exactly that result and nothing else: henji harness step seven'
```

The permission-safe task-runner probe used the corrected command shape with the invalid preflight-only
argument `--probe-invalid`:

```text
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --quiet --config deno.v0.json agent:acceptance --probe-invalid
```

Captured evidence: exit `1`; stdout was exactly one sanitized JSON line with
`outcome: "contract_failure"`, `error.code: "acceptance_input"`, `steps: 0`, and
`requestCount: 0`; stderr was empty. The invalid argument is rejected before model construction,
credential resolution, or fetch, so this probe used no credential and made no provider/external
network request. The production task itself was not run with valid task input.

## Verification

Runtime: Deno 2.9.4 at
`/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno` in `ai-dev`.

```text
deno task --config deno.v0.json agent:acceptance:test
10 passed, 0 failed

deno task --config deno.v0.json agent:transport:test
10 passed, 0 failed

deno task --config deno.v0.json agent:test
12 passed, 0 failed

deno task --config deno.v0.json v0:gate
check: passed (23 files)
fmt: passed (21 files)
lint: passed (21 files)
acceptance direct tests: 10 passed, 0 failed
transport direct tests: 10 passed, 0 failed
agent direct tests: 12 passed, 0 failed
full tests/v0: 64 passed, 0 failed

git diff --check
passed
```

The complete sequence above was rerun after the P1 invocation-syntax fix and passed unchanged. The
corrected task-runner preflight probe was also captured separately with exit `1`, one sanitized
stdout JSON line, `requestCount: 0`, and empty stderr; it did not construct the model or start fetch.

The final local gate sequence did not invoke the separate `agent:acceptance` production task. An
initial gate run found one unused import and a subsequent formatter-only difference in the new test;
both were corrected within the owned test file, and the final sequence above passed. No plan delta was
required; the later plan-authorized P1 fix changed only the documented task invocation syntax and
was verified by the preflight-only probe above.

## Production and acceptance boundary

`agent:acceptance` was run exactly once with the approved fixed task and confirmation. The sanitized
readback was:

```text
exit 0
stdout: {ok:true, profile:openrouter-google-gemini-3.7-flash-vertex-v0, outcome:final, stopReason:final, steps:2, toolCallCount:1, toolResultCount:1, requestCount:2, finalText:HENJI HARNESS STEP SEVEN}
stderr: empty
```

The attempt made exactly one command, exactly two application requests, and no retry or follow-up.
The credential came from the existing 0600 guest file but its value was not displayed or recorded.
The provider attempt succeeded and the user accepted H-022/roadmap step 7. No further provider
attempt is authorized by this record.

## Review disposition and remaining risks

- Local implementation and offline evidence: complete.
- Reviewer P1 invocation-syntax local-fix: applied and verified.
- Final changed-lines-only reviewer disposition: `GO`; Blocker/P1/P2 findings remaining: 0.
- Provider acceptance: one successful attempt recorded; no retry/follow-up.
- User acceptance: complete; H-022 is supported and roadmap step 7 is completed.
- Credential value and raw provider data: not displayed or recorded; no further diagnostic call is permitted.
