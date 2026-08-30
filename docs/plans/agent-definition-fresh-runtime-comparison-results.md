# Agent Definition fresh-runtime comparison results

## Authority and status

- Canonical plan: `docs/plans/agent-definition-fresh-runtime-comparison.md`, SHA-256
  `eeb8e9da5116ce34aaeaea045e072d0cbfac1fe88fb65c4ae72b2c2fb2ded414`.
- Planner input: `/tmp/planner-inputs/henji-agent-definition-fresh-runtime-comparison.md`, revision 26.
- The implementation Human Gate was approved on 2026-08-31. This document records the local
  implementation evidence; independent review, residual evidence closure, and owner final
  disposition are complete.

## Implemented contract

`v0/agent/fresh_runtime_comparison.ts` owns one strict, frozen comparison case, two fresh Step 78
evaluations, schema-v1 manifest/envelope pair validation, two run-local scripted runtimes, exact
Step 79 execution-record observation, bounded result correlation, and one sanitized outer failure.
The fixed case uses the default resource sequence, no skills or workspace reads, a four-call
uppercase fixture, and a five-step model script. The current run uses `default`/8 and completes at
step 5; the internal variant uses `default-max-steps-4`/4 and stops at `max_steps` after its fourth
complete tool batch. Model, registry, tool, recorder, clock, counters, commit state, and transcript
working state are fresh per run, with evaluator and abort ownership included in the construction
boundary. The fixture tool is Step-80-local and enforces its exact per-run
ordinal, argument order, reuse, and extra-call boundary.

`v0/agent/loop.ts` has only the opt-in `runAgentTurnObservedForComparison` wrapper and private
observer parameter. It reports model settlement and accepted call/result boundaries exactly once;
normal loop/runtime/session/event paths continue to pass `undefined` and retain their prior
behavior. `fresh_runtime_comparison_report.ts` renders the strict result using explicit bounded
plain-text conversion, with no task body, workspace content/path, raw provider data, progress,
credentials, object stringification, winner, score, recommendation, or promotion judgment.

## Known answers

| Side | Manifest identity | Envelope identity | Result |
| --- | --- | --- | --- |
| current | `henji-agent-resolved-manifest:v1:sha256:bdf0e5c7e70ac5d928aab4681bb3228c642d0af89a498ae9f3f9c2940f7a4a58` | `henji-agent-replay-envelope:v1:sha256:d2100020f44dbb1072d39c3ad83f5adc842f120d6725c26e4188bd61a352a0e8` | completed / final / committed |
| variant | `henji-agent-resolved-manifest:v1:sha256:90121c85e8c3a26f48eeca0ede02667584cd9056d53ba85173b2022812dca389` | `henji-agent-replay-envelope:v1:sha256:09251dd6a3028d50efe09dbe31e2cbc19418556c3c659ee1d5ebd12c9212b633` | stopped / max_steps / uncommitted |

The fixed report is LF-only and ends with exactly one newline. Both sides use 1,250 injected clock
microseconds, token usage and cost are `unsupported`, external/planner requests are zero, and both
causal tool paths contain exactly four successful `uppercase_text` nodes.

## Focused evidence

- `agent:fresh-runtime-comparison:test`: 12/12. Covers fixed case and manifest/envelope identities,
  exact run records/counts/causal path, stateful fixture order/reuse/extra-call boundaries,
  evaluator/model/tool/registry/clock/recorder/abort construction freshness and counts plus
  fault freshness and sanitization in both execution orders, report bytes and
  non-exposure, strict projection/undefined-vs-null and pair mutation rejection, result mutation
  rejection, freezing, and current-first/variant-first invariance. The partial-second fault now
  fires only after the second run's first model settlement is recorded, with an explicit bounded
  progress marker proving the discarded recorder/runtime prefix.
- `agent:test`: 26/26. Existing loop coverage plus exact observer model/call/result order,
  synthetic/unknown results, observer failure precedence, and normal unobserved behavior.
- `v0:offline-gate:topology:test`: 2/2. The new permission-free leaf, direct ownership, check
  inventory, exact composition, and production import isolation pass. The production graph fails
  closed on unresolved local imports and rejects a production-to-new-local-to-comparison mutation.

The remaining focused regression tasks and full owner gate passed locally: definition 12/12,
resolved-manifest 10/10, comparison-variant 6/6, replay-record 13/13, runtime 49/49 plus process
18/18, TUI direct 68/68 plus process 25/25 and topology 4/4, and the direct `v0:test`/`v0:gate`
each covered 578/578 tests. `v0:check`, `v0:fmt` (123 files), `v0:lint` (120 files), and
`git diff --check` passed. No provider, network, credential, production command, persistence,
dependency or lockfile, `_refs/`, commit, push, tag, publish, or release operation was performed.

## Review state and residual risk

No plan delta or stop condition was encountered. The initial implementation review's five P2
findings were addressed in the approved single closure pass: strict field/type-safe Definition
projection, stateful fixture-tool enforcement, bounded test-only construction/fault seams with
both-order evidence, transitive production import topology with a mutation regression, and
byte-stable canonical-plan restoration. The single re-review left two evidence-only P2s; the
approved residual closure now adds second-position model/tool/observer/recorder/clock failures
after first-run settlement, delayed partial-second injection after second-run first model
settlement/recorded progress, and fail-closed unresolved-import coverage. Owner final disposition
is Blocker/P1/P2 zero: the owner independently inspected the exact residual source/tests, reran the
fresh comparison 12/12 and offline topology 2/2, and completed the authoritative full `v0:gate`
578/578 with check, format, lint, and diff check green. The comparison remains internal and
offline-only; the fixed scripted model does not claim provider behavior, and the result is not
persisted or exposed through CLI/TUI/runtime selection.
