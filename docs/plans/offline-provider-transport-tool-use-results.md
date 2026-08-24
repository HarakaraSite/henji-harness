# Henji Harness roadmap step 6 results

## Scope and authorization

- Approved plan: `docs/plans/offline-provider-transport-tool-use.md`
- Approved plan SHA-256: `6ef53e33031c0895e5a977fbd9dab6e11345b6a9fe9310cc9aacd2857fa3bf2c`
- Slice: offline OpenAI-compatible provider transport tool use (roadmap step 6 only)
- Human Gate 2: approved before implementation
- Provider acceptance, roadmap step 7, commit, push, release, dependency changes, credential
  inspection, and persistent state changes remain out of scope.

## Changed files owned by this slice

- `v0/agent/openrouter_model.ts`
- `tests/v0/agent_openrouter_model_test.ts`
- `deno.v0.json`
- `docs/plans/offline-provider-transport-tool-use-results.md`
- Gate-state documents (`AGENTS.md` and `.handoff/handoff.md`) are maintained by the repository
  owner when the step 6 state transition is recorded.

No existing source, legacy transport, agent loop, registry, dependency, or lockfile was changed.
The pre-existing dirty worktree was preserved.

## Direct offline evidence

The adapter implements the existing provider-neutral `Model` contract and uses only an injected
fake `fetch` and dummy credential in the direct test. The process runs without `--allow-env` or
`--allow-net`.

The text-only case made exactly one request and observed:

- fixed endpoint, `POST`, `redirect: "error"`, `content-type`, and Bearer authorization headers;
- fixed `PROFILE.model`, `stream: false`, and `max_completion_tokens: 1024`;
- the user message and the `uppercase_text` function definition with its JSON input schema;
- a final assistant text result.

The composed tool-round case made exactly two requests. The second parsed body preserved this
causal order:

1. `{ role: "user", content: "hello" }`
2. assistant `tool_calls` with ID `call-1`, function `uppercase_text`, and JSON arguments
   `{"text":"hello"}`;
3. `{ role: "tool", tool_call_id: "call-1", content: "HELLO" }`.

The loop then returned final text `HELLO` with two model steps, one tool call, and one tool result.
The adapter sends no retry or fallback request.

Direct negative coverage includes invalid JSON arguments, missing call ID/name, non-function calls,
multiple choices, mixed text/tool calls, missing message/result, empty result, oversized response
body cancellation, response-body deadline, transport rejection, non-OK HTTP response, missing
credential, invalid preflight, the 76 KiB message bound, and the 256 KiB request bound. Every
negative case asserts the expected zero-or-one request count and sanitized error surface. Error
messages do not contain the injected credential or provider-body marker.

## Verification

Runtime: Deno 2.9.4 at `/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno` in `ai-dev`.

Commands and results:

```text
deno task --config deno.v0.json agent:transport:test
10 passed, 0 failed

deno task --config deno.v0.json agent:test
12 passed, 0 failed

deno task --config deno.v0.json v0:gate
check: passed (21 files)
fmt: passed (19 files)
lint: passed (19 files)
agent transport direct tests: 10 passed, 0 failed
existing agent tests: 12 passed, 0 failed
full tests/v0: 54 passed, 0 failed (10 direct + 12 agent + 32 existing)

git diff --check
passed
```

The full gate's existing `tests/v0` invocation retains its historical permissions for regression
coverage. The new transport task is the permission-free isolation evidence for this slice.

## Review and disposition

Implementation-side verification is complete. The bounded independent review found one P2:
OpenAI-compatible responses may include `tool_calls: null` alongside non-empty assistant text, and
the adapter previously rejected that valid text-only shape. Local-fix disposition: resolved by
treating only `undefined`/`null` `tool_calls` as absent for a non-empty final text while continuing
to reject non-empty or empty-array mixed tool-call shapes; a direct regression test now covers the
null form. The updated direct and full gates pass as recorded above. Changed-lines-only re-review:
`GO`, with Blocker/P1/P2 findings remaining at zero. The reviewer confirmed the null-tool-calls fix
and the unchanged mixed-shape rejection, and found no further evidence-backed issue in the changed
lines. Local evidence is complete. User acceptance: accepted by the user (`はい`) on 2026-08-24;
H-021 is supported and roadmap step 6 is complete. The review scope covered the
exact implementation diff: wire mapping and causal order, credential/endpoint ownership and
redaction, zero-request preflight, one request per model step, finite bounds and deadline, existing
contract compatibility, and unchanged legacy paths/dependencies/state.

## Deviations and remaining risks

- No plan delta was required. The adapter is additive and does not change `runAgent`, `Registry`,
  the legacy `v0/model.ts` contract, CLI composition, dependency files, or state.
- Real OpenRouter/model compatibility, provider account behavior, streaming, parallel calls,
  provider-specific content, and the step 7本人 task remain unobserved by design.
- The old legacy and new agent request contracts remain separate as approved; a shared transport
  core is deferred until a demonstrated maintenance or correctness issue exists.
- No real provider call, production credential read, network connection, persistent state operation,
  commit, push, release, or step 7 work was performed.

## Acceptance

- H-021: supported by the permission-free fake-fetch evidence and causal two-request tool-round
  observation.
- Roadmap step 6: complete and accepted by the user (`はい`) on 2026-08-24.
- Next: a separate Human Gate must decide whether roadmap step 7 should be opened.
- Boundary retained: this acceptance authorizes no provider call, credential access, step 7 work,
  dependency or persistent-state change, commit, push, or release.
