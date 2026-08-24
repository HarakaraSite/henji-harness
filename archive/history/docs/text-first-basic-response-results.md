# H-017 text-first basic response results

## Scope and status

Revision 10 / H-017 Slice 1 implementation, offline local gate, and separately approved H-017 real-provider acceptance are complete. The user judged the single response usable as-is and requiring zero parse-derived corrective action.

## Contract evidence

- Basic success now emits exactly `responseText`, `requestCount`, `durationMs`, and `outcome: { ok: true }`.
- The raw response string is returned byte-for-byte for JSON-looking, Markdown, plain, and invalid structured-looking text.
- Basic success no longer calls `parseModelPlan` or emits `parse`, `plan`, or validation-derived fields.
- Basic failure keeps the existing bounded error shape and request count.
- Basic remains one-shot, passive, state-free, and repeatable. Tool-shaped text is not dispatched, persisted, or re-submitted.
- Legacy `run` / `acceptance run` Plan parsing and stateful behavior remain unchanged.

## Direct tests and commands

- Scoped basic tests: `/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno test --no-prompt --allow-read --allow-write --allow-run --allow-env --allow-net tests/v0/v0_test.ts --filter "basic run"` — 5 passed, 0 failed.
- Local gate: `/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --config deno.v0.json v0:gate` — check, format, lint, and 32 tests passed.
- The gate used only repository fixtures and loopback HTTP tests; no real provider endpoint or credential was accessed.
- Separately approved acceptance evidence: one request, retry 0, 7252 ms, success/exit 0.
- The acceptance terminal had no `parse`, `plan`, or `validation` fields and displayed no credential.
- The user judged the JSON-looking raw response usable as-is; no parse-derived corrective action, extra call, state, or attempt was observed.
- The raw response itself is intentionally not copied into this repository.

## H-017 mapping

| Condition | Direct evidence |
| --- | --- |
| Raw text is the only formal response | `basic run returns exact raw text for representative response forms`; repeatability test |
| Parse execution and display are zero | `v0/cli/main.ts` basic success readback; key-absence assertions; legacy parse remains at `run` |
| Failure is not confused with success | Existing basic failure, limits, confirmation, transport, response, timeout, and request-boundary tests |
| Exactly one request and no retry | Basic model invocation counters and provider boundary tests |
| Host-only secret boundary | Fixed endpoint, redirect rejection, and dummy credential non-serialization tests |
| Passive, state-free, repeatable | Tool-shaped passive response, no state directory, and failure-then-recovery tests |
| Legacy compatibility | Existing legacy CLI, runner, and Plan parser tests pass in the 32-test gate |

## Changed files

- `AGENTS.md` — synchronized current phase and allowed boundary.
- `v0/cli/main.ts` — removed only basic success Plan parsing/display.
- `tests/v0/v0_test.ts` — updated basic contract assertions and added four representative text cases.
- `README.md` — documented raw text-only basic response and legacy separation.
- `docs/text-first-basic-response-results.md` — this evidence package.
- `.handoff/handoff.md` — updated the current Record and H-017 checkpoint after verification.

## Deviations and remaining risks

- The repository's earlier Revision 8 wording was synchronized to Revision 10 / H-017; no provider/model, dependency, legacy, or state redesign was made.
- The acceptance record above contains the supplied metrics and user judgment, without copying the raw response or credential.
- Consumers outside this repository that depend on the removed basic `parse` field are not observable in this test suite.
- Stop point: the next Human Gate decides whether to begin Slice 2; Slice 2 implementation is not opened here.
