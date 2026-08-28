# Provider-neutral assistant streaming implementation results

## Scope and authority

This evidence record covers the implementation of
[`provider-neutral-streaming.md`](provider-neutral-streaming.md), SHA-256
`694cb7cc08f0e06b333acf6acc61a1f6992f538730b5d63f9577931bef061732`. The plan baseline is
`ea3b506ee8a58091e7605afdca4362d42a8edc99`; the implementation was committed after the final
owner gate. All fixtures are local and disposable.

## Implemented contracts

| Contract | Evidence |
|---|---|
| Optional synchronous assistant reporter and `assistant_progress` event | `v0/agent/contracts.ts`, `v0/agent/events.ts`, `v0/agent/loop.ts` |
| 65,536 UTF-8-byte / 256 accepted-update bounds with per-request lifetime | `v0/agent/loop.ts`, `tests/v0/agent_streaming_test.ts` |
| Sink failure latch, cancellation request, and completed-result authority | `v0/agent/loop.ts`, focused streaming test |
| Internal JSON/SSE mode; omitted mode remains JSON | `v0/agent/openrouter_model.ts`, existing transport tests and focused streaming test |
| Incremental UTF-8 SSE framing, BOM/comments/fields, CR/LF variants, byte and event bounds | `v0/agent/openrouter_model.ts`, focused stream fixture |
| Completion-ID and choice-index ownership before text/tool accumulation | `v0/agent/openrouter_model.ts`, sanitized ownership regressions |
| Accumulated text, terminal/usage handling, and completed streamed tool-call assembly | `v0/agent/openrouter_model.ts`, focused final/tool tests |
| No partial dispatch/transcript/CLI output; planner child receives no progress sink | existing loop/runtime/session boundaries and runtime SSE fixtures |
| Normal parent/planner materialization selects SSE while other adapters remain JSON | `v0/agent/runtime.ts`, runtime and process fixture tests |
| Replaceable escaped live assistant line and lifecycle clearing | `v0/tui/render.ts`, `v0/tui/controller.ts`, existing renderer/controller tests |
| No persistence/schema changes and final-only CLI | existing session/store/CLI contracts plus runtime process fixtures |

## Wire and error matrix

- SSE requests retain the existing endpoint, model, messages, tools, token bound, headers,
  redirect policy, timeout, credential timing, and one-request admission; only `stream:true` is
  selected by the normal runtime.
- The default adapter mode continues to send the byte-equivalent `stream:false` JSON body.
- Successful SSE responses require a body and `text/event-stream` media type. Non-2xx responses use
  the existing sanitized HTTP classification. Invalid frames, top-level provider errors,
  unsupported terminal reasons, ownership mismatches, malformed tools, and incomplete streams are
  sanitized `response_error` failures. Raw frames, provider bodies, credentials, and tool
  arguments are not retained in outward errors.
- Reader cancellation/release failures are classified as sanitized transport or cleanup failures;
  turn cancellation and sink failure retain their existing precedence. Timeout remains armed until
  stream processing and cleanup finish.

## Runtime, TUI, persistence, and compatibility evidence

Normal runtime fixtures now emit deterministic SSE with a terminal usage frame and `[DONE]`. The
runtime process fixture still proves final-only stdout/stderr and unchanged production task
literals. The session TUI fixture uses SSE without changing session-v1 bytes; progress is not a
message, metric, persistence value, or replay event. The shared profile, definitions, registries,
request budgets (8 parent / 8 child / 16 aggregate), planner envelope, corpus/eval adapters,
acceptance paths, dependencies, permissions, and `_refs/` are unchanged. The planner-delegation
sentinel helper passes the explicit test-only `responseMode:'json'` seam so its existing guarded
`stream:false` wire remains unchanged while normal runtime materialization selects SSE.

## Verification

The focused streaming suite passed 15 tests. Affected direct suites passed: transport 16, loop 22,
TUI input/render/controller 10/8/26, runtime 35, runtime process 18, session store 13, and
session TUI 1. The full `v0:test` run passed 460 tests with zero failures. `v0:check`, `v0:fmt`,
`v0:lint`, `git diff --check`, and the final owner `v0:gate` passed; the gate included the full
460-test offline suite. No provider,
network, credential, production command, persistent product state, dependency or lockfile
operation, `_refs/` operation, push, tag, publish, or release was performed. The reviewed
increment was committed after the final gate.

## Review and residual risk

The initial changed-lines review found Blocker 0/P1 0/P2 4. One plan-scoped finding-closure pass
added the bounded documented usage-frame shape and duplicate-frame regressions, exact AgentSession
and TurnCancellationOwner gated-SSE sink-failure/cleanup regressions, and delayed multi-chunk
controller/PTY settlement evidence. Re-review P1 closure now permits provider-added usage metadata
while retaining the required counters, with an exact `cost:0` success regression. Changed-lines
final re-review is `GO` with Blocker/P1/P2 zero. The plan's known residual risks remain: providers may send undocumented SSE variants,
high-frequency deltas can reach the live update bound, a final answer can exceed the live display
bound while remaining below the raw 1-MiB bound, aborting a connection does not guarantee
provider-side compute/billing cancellation, and an abort-ignoring reader may delay ready/exit
until owned settlement. No real-provider compatibility claim is made by these local fixtures.
