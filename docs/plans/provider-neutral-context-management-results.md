# Provider-neutral context management results

## Contract and implementation

- Plan: [`provider-neutral-context-management.md`](provider-neutral-context-management.md)
- Plan SHA-256: `46eaf7a396e8add4dbd080414d854a8cbc579ce0999c43738d1b444335916e83`
- Baseline: `7c3888f` (provider-neutral cancellation)
- Implementation revision: working tree based on `7c3888f` (no commit was created)
- Constants: trigger `65,536`, target `49,152`, marker
  `[older tool result omitted for context]` (39 UTF-8 bytes)

`v0/agent/context.ts` provides the pure defensive request view. It measures the fixed provider-
neutral envelopes as stable JSON UTF-8 bytes and replaces only beneficial result text in older tool
messages, oldest-first, while protecting the newest ToolMessage. The loop derives a fresh view for
each model request after cancellation preflight and before request admission. The session retains
full committed transcripts and exposes only a defensive `contextSnapshot()` metrics object. The TUI
reads that accessor only when a settled turn returns to idle and renders the bounded `ready · ctx`
status; `agent:run` output, events, outcomes, and provider wire contracts remain unchanged.

Changed files:

- `v0/agent/context.ts`
- `v0/agent/loop.ts`
- `v0/agent/session.ts`
- `v0/agent/tui_cli.ts`
- `v0/tui/controller.ts`
- `tests/v0/agent_context_test.ts`
- `tests/v0/tui_controller_test.ts`
- `deno.v0.json`
- `README.md`
- `docs/plans/provider-neutral-context-management-results.md`
- `AGENTS.md` and `.handoff/handoff.md` lifecycle evidence

## Evidence matrix

| Contract | Evidence |
| --- | --- |
| UTF-8 byte envelopes and JSON escaping | `agent_context_test.ts`, envelope and multibyte case |
| 65,535/65,536 trigger boundary | exact boundary test |
| 49,152 target and delta accounting | target/order, exact-stop, and reserialization-oracle tests |
| Oldest eligible results and newest protection | ordering, batch, marker-size tests |
| Metadata and causal shape retention | metadata/terminal/error preservation test |
| Full transcript and per-step source regeneration | loop integration test and existing loop/session suite |
| Session commit/rollback snapshot | same-session toggleable-sink rollback plus success/failure/defensive tests |
| Parent/child and admission compatibility | independent marker views, exact 3/0/3 → 3/3/6 → 4/3/7 snapshots, and existing suites |
| Cancellation/preparation admission | pre-preparation cancellation and JSON-serialization failure both show zero model calls/claims |
| Adapter boundary compatibility | fake OpenRouter accepts irreducible 70 KiB and rejects 77 KiB before fetch |
| TUI settlement/status formatting | delayed fake-terminal cancellation proves zero busy/cancelling reads, one settled read, and exact status cases |
| Normal process/transport compatibility | existing runtime process, transport, and full gate suites |

## Offline verification

The focused context task is permission-free and is included once in `v0:gate`:

```text
agent:context:test
```

The following repository-defined checks were run without provider, network, credential, production,
or `_refs/` activity:

- `agent:context:test`: 15 passed
- `agent:test`: 22 passed
- `agent:session:test`: 14 passed
- `agent:planner-delegation:test`: 16 passed
- `agent:cancellation:test`: 18 passed
- `agent:tui:test`: 34 passed (including delayed, rejected/fatal, and exit-intent context-read evidence)
- `v0:check`: passed
- `v0:fmt`: passed
- `v0:lint`: passed
- `v0:test`: 396 passed
- `v0:gate`: passed; 396 tests in the full v0 run and focused context task once
- `git diff --check`: passed

## Review and deviations

No plan deviation, dependency/lockfile change, public CLI argument/output change, provider/profile
change, or persistence change was introduced. Initial changed-lines review recorded four P2
evidence gaps; the single re-review recorded two remaining evidence P2s. All six are now closed by
narrow permission-free regressions: exact target stop and full metric oracles including exact 49,152
landing, same-session event rollback, independent parent/child marker and budget views with
zero-effect cancellation/preparation failures plus fake-adapter wire bounds, delayed TUI
settlement/status evidence, and zero context reads for rejected/fatal or busy exit-intent
settlement. Final owner disposition is Blocker/P1/P2 zero.

## Activity boundary and remaining risk

Provider/network/credential/production command activity: zero. Dependency/lockfile activity: zero.
`_refs/` activity: zero. Commit/push/tag/publish/release activity: zero.

The estimate is intentionally conservative and is not tokenizer usage or provider capacity. The
provider adapter's existing wire limits remain authoritative. Noncompressible user/assistant/tool-
definition/newest-result content can still exceed those limits; persistent history and semantic
summary remain later roadmap work.
