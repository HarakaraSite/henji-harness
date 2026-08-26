# Zot-first provider-neutral multi-turn/events results

## Acceptance package

- Plan: [`zot-provider-neutral-multi-turn-events.md`](zot-provider-neutral-multi-turn-events.md)
- Approved plan SHA-256: `663a1bd6634e1503978d0af3f24aecc899dd3b3acd64819fbfcd416cd71bdf0e`
- Scope: provider-neutral one-turn extraction, completed lifecycle events, private sequential
  in-memory sessions, successful-turn commit, failed-turn transcript rollback, and offline tests.
- Excluded: TUI/raw terminal, new production command, streaming, persistence, cancellation,
  provider/network/credential execution, dependencies, `_refs/`, archive, and external writes.

## Implemented evidence

- `v0/agent/loop.ts` now exposes `runAgentTurn(task, committedTranscript, model, registry,
  options)` and keeps `runAgent` as the empty-transcript compatibility wrapper. Requests, tool
  definitions, tool calls, outcomes, and returned transcripts are defensively snapshotted.
- `v0/agent/events.ts` defines the synchronous `turn_start`, `user_message`,
  `assistant_message`, `tool_call`, `tool_result`, and `turn_end` union, `structuredClone`-based
  deep snapshots that preserve all valid JsonValue values including nested `-0`, and the stable
  `EventDeliveryError` / `agent event delivery failed` boundary.
- `v0/agent/session.ts` owns private committed transcript state, positive turn numbering,
  nonqueueing concurrency rejection, per-turn max-step reset, success-only commit, and
  failure/event-delivery rollback. A successful session draft is committed before the normal
  `turn_end` sink observes it; if that sink fails, the prior transcript is restored. Tool side
  effects from a failed turn are intentionally not claimed to roll back.
- `tests/v0/agent_session_test.ts`: 14 deterministic permission-free tests cover two-turn context,
  continuing and terminal tools, contract/max-step outcomes, event order and payload isolation,
  nested `-0` preservation, sink stop-before-next-effect behavior at each single- and multi-call
  position, invalid mixed/duplicate terminal batches, rollback, blank/concurrent preflight, request
  reset, stable system/tools, and one-turn prior-transcript isolation.
- `deno.v0.json` includes the focused `agent:session:test` task and the new sources/test in
  `v0:check` and `v0:gate`. `README.md` records the in-memory completed-events prerequisite while
  retaining the one-shot runtime boundary.

## Verification

All commands used the repository-pinned Deno 2.9.4 binary. No provider, credential, network,
production, or sentinel command was run.

| Command | Result |
| --- | --- |
| `deno task --config deno.v0.json agent:session:test` | 14 passed |
| `deno task --config deno.v0.json agent:test` | 22 passed |
| `deno task --config deno.v0.json agent:runtime:test` | 12 passed |
| `deno task --config deno.v0.json agent:runtime:process:test` | 14 passed |
| `deno task --config deno.v0.json agent:transport:test` | 13 passed |
| `deno task --config deno.v0.json agent:skills:test` | 12 passed |
| `deno task --config deno.v0.json agent:skills:topology:test` | 3 passed |
| `deno task --config deno.v0.json agent:corpus:test` | 9 passed |
| `deno task --config deno.v0.json agent:corpus:eval:test` | 14 passed |
| `deno task --config deno.v0.json v0:check` | passed |
| `deno task --config deno.v0.json v0:fmt` | passed; 67 files checked |
| `deno task --config deno.v0.json v0:lint` | passed; 64 files checked |
| `deno task --config deno.v0.json v0:gate` | passed; 227 tests |
| `git diff --check` | passed |

The full gate also reran the repository's instruction, work-tool, process, transport, corpus/eval,
acceptance-fixture, and extension suites. The acceptance-fixture suites use local fakes; no real
provider request was made.

## Deviations and residual risk

- Initial bounded review reported three P2s: JSON snapshots changed `-0`, turn-end commit
  visibility lagged session state, and the stop-before-next-effect matrix lacked multi-call and
  invalid-terminal coverage. The local fixes use `structuredClone`, a session-owned commit hook
  with catch/restore around turn-end delivery, and expanded deterministic tests; no requirement,
  safety boundary, dependency, permission, or verification-level deviation was needed.
- `runAgentTurn` has no commit owner by default, so a standalone successful turn reports
  `turn_end.committed: false` while returning its draft. `AgentSession` supplies the owner and
  reports true only after its committed transcript has been updated; this boundary is tested.
- The single allowed re-review closed the value-preservation and commit-order P2s and left one P2
  for missing early invalid-terminal-batch failure evidence. The owner final fix adds that exact
  regression: failure on the first synthetic result permits no second call/result, `turn_end`,
  additional model request, or tool dispatch, and leaves the session transcript rolled back.
- Session state is memory-only and tools remain trusted-local. Filesystem/Bash side effects already
  performed before a failed turn are not reversible through transcript rollback.
- Provider streaming, event deltas, TUI rendering, cancellation, persistence, and broader session
  lifecycle behavior remain deferred to later Human-Gated increments.

Independent initial review reported Blocker 0/P1 0/P2 3. The single changed-lines re-review closed
two P2s and retained only the early invalid-terminal-batch evidence gap. The owner final regression
and full 227-test gate directly close that remaining gap; final disposition is Blocker/P1/P2 zero.
