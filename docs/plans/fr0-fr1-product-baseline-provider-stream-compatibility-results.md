# FR0/FR1 product baseline and OpenRouter stream compatibility results

Status: **local implementation verified; real-provider and human acceptance pending**

Date: 2026-09-02

## Baseline and scope

The recorded product baseline is commit `024071a9e119a4eb76dcdc0e5a3b0189354ea48b`. The current
governance correction in `AGENTS.md`, `.handoff/handoff.md`, and the approved plan remains preserved
by the coordinating owner. The current repository smoke suite remains the six checks in
`tests/v0/current_code_test.ts`; its count is not used as a completeness measure. The old reset
suite remains recoverable at `/tmp/henji-tests-v0-pre-minimal-reset-20260902` and was not restored.

| Area | Disposition |
| --- | --- |
| Product source | Keep request accounting, planner failure propagation, session commit, max-step, and retained UI behavior; add only the evidence seam and stream compatibility needed by FR1. |
| Parser/transport | Change the final OpenRouter usage-frame classification and retain HTTP/SSE/parser evidence. |
| Tests | Keep the six current smoke behaviors and add function-derived HTTP/SSE confirmations only. |
| Governance/docs | Preserve current policy and add this implementation readback plus the README evidence boundary. |
| Launcher | No installed launcher or machine state was read or changed; repository dispatch already routes `diagnostics evidence` through the existing diagnostic launcher. |
| Failed acceptance | Historical HTTP-200 `data_after_terminal` diagnostic remains untouched; no raw payload was fabricated. |
| References | `_refs/*` was not read, executed, modified, staged, or deleted. |

## Official contract and compatibility result

The official OpenRouter streaming, usage-accounting, and tool-calling documentation was checked on
2026-09-02:

- [Streaming](https://openrouter.ai/docs/api_reference/streaming) documents a final usage chunk
  immediately before `[DONE]`, with one content-free delta repeating the terminal finish reason;
  the usage chunk is an accounting frame rather than a second terminal event.
- [Usage accounting](https://openrouter.ai/docs/cookbook/administration/usage-accounting) documents
  usage counters and provider-added cost/token details in the final streaming response.
- [Tool calling](https://openrouter.ai/docs/guides/features/tool-calling) documents normal client
  dispatch of `tool_calls` and the subsequent tool-result request shape.

Before the fix, the current parser treated the documented `delta.content: ""` and
`delta.role: "assistant"` usage frame as `data_after_terminal`; the prior human run therefore
ended after one HTTP-200 provider request with `response_parse/response_error/data_after_terminal`.
The local known answer now passes the full fake `fetch -> Response -> SSE framing -> parser ->
ModelResult` path and reaches the existing terminal text result. Actual non-empty content or tool
calls after the terminal still produce `data_after_terminal`; provider error events remain errors.

## Evidence boundary and readback

`v0/agent/provider_evidence.ts` provides one recorder per accepted parent turn, shared by parent and
planner lanes. It retains request ordinal/lane/model step, endpoint/method/body and non-Authorization
metadata, response status/headers/raw body byte count, ordered SSE data/raw frames and parsed provider
fields, parser transitions including mismatch field and reason, model/tool/result order, outcome,
and turn/runtime request counts. The recorder API has no credential, credential-source,
Authorization, or complete request-header input. Exact response bytes are also retained as base64 so
invalid UTF-8 does not silently replace the evidence text.

`v0/agent/provider_evidence_store.ts` retains artifacts under the existing workspace partition:

```text
<state-root>/<workspace-digest>/provider-evidence/<evidence-id>.json
<state-root>/<workspace-digest>/provider-evidence-links/<diagnostic-id>.json
```

Successful and failed artifacts are retained without a quota, automatic eviction, or cleanup
command. The diagnostics surface is read-only for evidence:

```text
henji diagnostics evidence list
henji diagnostics evidence show --id <evidence-id>
henji diagnostics evidence show --id <diagnostic-id>
```

The last form resolves a parser failure's diagnostic ID to its retained evidence artifact. The
retained TUI displays the evidence ID and readback command without placing raw provider data in the
transcript. Credential values and the private request Authorization header are structurally absent
from evidence request types, serialized artifacts, and the presentation readback; response headers
and provider metadata are retained completely.

## Bounded functional review closure

The bounded review admitted exactly two Product P2 findings. P2-1 was that a failed evidence write
still exposed a readback command in the deferred `turn_end` path; the closure carries evidence
durability and persistence error through the event, presentation, retained state, and live render,
and shows the failure without advertising a command when no artifact is durable. The valid provider
result remains unchanged. P2-2 was that evidence CLI failures were collapsed into the diagnostic
I/O code; the closure preserves typed provider-evidence errors, including `provider_evidence_not_found`
for a historical/no-link show. The focused confirmation covers both closures. The single narrow
re-review confirmed both findings Closed and returned GO with Blocker/P1/P2 zero.

## Local confirmation and remaining boundary

The focused product confirmation is
`tests/v0/provider_stream_compatibility_test.ts`. It confirms text accounting through the real
transport/parser, tool accounting and terminal dispatch through the same transport, exact
post-terminal mismatch evidence and diagnostic linking, request/response/SSE/parser/runtime
correlation, and request credential/Authorization exclusion. `deno.v0.json` exposes the focused
task and includes it in `v0:test`.

Focused `v0:check`, `agent:provider-stream-compatibility:test`, `v0:fmt`, and `v0:lint` passed after
the P2 closure, including the disposable Deno store/readback confirmation. The coordinating owner
then ran the authoritative `v0:gate` exactly once: check, formatting of 83 files, lint of 80 files,
the six current smoke behaviors, and the seven function-derived provider confirmations all passed.
The counts describe what ran and are not completeness criteria. No provider request, credential
read, production command, installed launcher/state operation, retained acceptance-state cleanup,
dependency/lockfile change, `_refs/*` operation, commit, push, tag, publication, or release was
performed.

Real-provider field shape, real tool completion, installed integration, human acceptance, retention
policy, and D0/FR2+ work remain unverified or deferred. This document records local implementation
verification, not production compatibility or human acceptance.
