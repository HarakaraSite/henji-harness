# Step 83 implementation results

Plan: [`session-navigation-context-recovery-readme.md`](session-navigation-context-recovery-readme.md)

## Implementation boundary

The approved 83a → 83b → 83c order was followed. 83a adds the bounded causal history index/page
projection, Ctrl-G/Ctrl-T/Ctrl-K decoder events, persistent navigation host, exact target materialize-
then-close switch transaction, current-position projection, and read-only TUI panels. 83b keeps the
canonical schema-v1 session record unchanged, adds a strict sibling `contexts/<session UUID>.json`
checkpoint codec/store, production-wire byte-aware candidate admission, one-shot summary framing,
semantic-before-mechanical parent projection, and checkpoint-aware persistent sessions. 83c
reconstructed the root README around the user flow and correlates commands, keys, limits, and
provider-free boundaries with the current implementation.

No provider, network, credential, production command, dependency/lockfile, persistent product state,
`_refs/`, commit, push, tag, publish, or release operation was performed.

## Single review-finding closure

The approved one-pass closure addressed all nine initial review findings without changing the
plan's requirements, security boundary, permissions, Human Gates, or out-of-scope operations:

1. Picker page movement now keeps the selected row visible and deterministic; the production
   controller test covers nine rows, page markers, full UUIDs, wrapping, and exact resume target
   (`v0/agent/session_navigation.ts`, `v0/tui/controller.ts`,
   `tests/v0/agent_session_navigation_test.ts`, `tests/v0/tui_controller_test.ts`).
2. List/switch operations are explicitly owned by controller settlement. Switches fail fatally on
   old-close, target cleanup, or restored-render errors and cannot publish a stale binding; delayed
   signal and restored-render regressions cover the production path (`v0/agent/tui_cli.ts`,
   `v0/tui/controller.ts`, `v0/tui/render.ts`, `tests/v0/tui_controller_test.ts`).
3. Compaction is tracked and awaited on signal, EOF, output-failure, and crash settlement;
   cancellation cleanup failure poisons the session and takes fatal precedence. Delayed signal and
   cleanup-failure tests cover controller and `AgentSession.compactContext`
   (`v0/tui/controller.ts`, `v0/agent/session.ts`, `tests/v0/tui_controller_test.ts`,
   `tests/v0/agent_session_store_test.ts`).
4. Canonical history messages are split at scalar-safe source and escaped bounds before page
   construction, and a tail-reachability regression traverses every oversized message
   (`v0/agent/session_history.ts`, `tests/v0/agent_session_navigation_test.ts`).
5. History measurement and rendering share the exact escaped projection and framing, including
   controls, bidi markers, and multibyte text (`v0/tui/render.ts`, `v0/agent/session_history.ts`,
   `tests/v0/tui_render_test.ts`).
6. Ephemeral Ctrl-T reads the session's current committed position, so it opens the latest turn
   (`v0/tui/controller.ts`, `tests/v0/tui_controller_test.ts`).
7. Ready status renders bounded agent, checkpoint boundary, retention, and semantic projected-byte
   metadata without summary text (`v0/agent/session.ts`, `v0/tui/controller.ts`,
   `tests/v0/tui_controller_test.ts`).
8. The Deno store validates the known source profile, removes valid-named orphan contexts, counts
   malformed/wrong-profile companions, and enforces the bounded context scan
   (`v0/agent/session_store.ts`, `tests/v0/agent_session_store_test.ts`).
9. Direct production-path controller/session/store regressions and the topology ownership/count
   assertions were added; the README, this record, `AGENTS.md`, and handoff are synchronized.

## Residual review-finding closure

The approved residual pass addressed the subsequent navigation ownership P1, compaction-settlement
P2, and evidence-only P2 without changing the plan's requirements, security boundary, permissions,
Human Gates, or out-of-scope operations:

- Navigation now tracks every admitted picker/list/switch operation with its own abort controller
  and generation. Dismissal and shutdown abort and await the complete set, so a delayed
  Enter→Escape→Ctrl-G→signal sequence cannot overwrite the active binding or redraw after restore.
- The production switch transaction checks cancellation before materialization and again after old
  session close, and its target factory/persistence cleanup retains fatal precedence. Direct
  controller evidence covers materialize→old close→swap ownership and old-close/target-cleanup
  failures.
- Controller EOF, input, output, and crash settlement aborts active compaction before awaiting it;
  delayed regressions prove restoration waits for settlement and cleanup failure remains fatal.
- Store evidence now rejects a wrong-permission context companion during read/list and preserves
  profile/orphan correlation.

## Focused offline evidence

- `agent:session:navigation:test`: 6/6
- `agent:semantic-context:test`: 5/5
- `agent:session-store:test`: 19/19
- `agent:session:tui:test`: 9/9
- `agent:tui:test`: 99/99
- `v0:offline-gate:topology:test`: 2/2
- `v0:check`, `v0:fmt`, `v0:lint`, and `git diff --check`: pass

The authoritative full `v0:gate` passes 653/653 tests. There are 53 unique offline leaves; the
gate executes the topology leaf as both the outer and inner edge, resulting in 54 leaf
invocations. The first gate attempt had one isolated pre-existing PTY process flake; the immediate
isolated rerun and final full gate both passed, and no source change was made for that observation.
Provider-free representative acceptance was run only after its separate Human Gate. Initial
changed-lines review found P1 4/P2 5; its single narrow re-review closed the first closure's
findings except for navigation ownership P1 1, compaction settlement P2 1, and evidence-only P2 1.
Because the re-review identified a residual P1, the owner authorized the exact residual closure
above. The owner independently reran the focused suites and authoritative 653/653 gate and closed
the residual source-to-impact paths and direct evidence at final disposition Blocker/P1/P2 zero.

## Provider-free representative acceptance

The user approved the separate Human Gate. A repo-external disposable fixture used the injected
fake transport, two sessions in one disposable workspace/state root, and output-driven key
admission rather than timing-bound input. The accepted run observed:

- Ctrl-G selected and resumed the exact second full UUID; Ctrl-T opened its latest causal turn.
- Ctrl-K preview/cancel issued zero fake requests; confirmed compaction issued one fake-summary
  request, installed one checkpoint, displayed it read-only, and retained the canonical record.
- Exact-session restart loaded the same checkpoint. One subsequent fake successful turn committed
  once while the prior canonical transcript remained an exact prefix.
- Two sessions remained valid, both per-session locks were immediately reacquirable, no temporary
  artifact remained, terminal restoration occurred for both TUI runs, and the disposable root was
  removed.
- External/provider requests, credential reads, and production commands were zero.

Two earlier fixture observations were invalid and were not accepted: the first waited for a
nonexistent `status> ready` string instead of the renderer's `[ready]` suffix; the second treated
the intentionally persistent lock-file inode as an active lock instead of probing `tryLock`
ownership. Static startup diagnostics and source inspection established both driver causes. The
corrected output-driven fixture then passed without a product-source change.

## Known boundary

The production TUI remains provider/credential gated at request time. The README and local tests do
not claim provider behavior, billing outcomes, or persistent product acceptance. Existing
schema-v1 canonical history remains the sole durable history authority; context is one derived
checkpoint companion and is never merged into `session.json`.

## Comprehensive validated-finding closure

The subsequent approved closure addressed the six validated findings against the accepted Step 83
tree without changing the product contract, schema, provider wire, permissions, dependencies, or
Human Gates:

1. `openExisting` now hydrates the canonical record, checkpoint, and rollback baseline from one
   per-session locked snapshot; a deterministic pre-lock barrier holds a pending opener across a
   newer owner's record/checkpoint commit and release, then proves that the opener sees the latest
   correlated pair.
2. Navigation switch ownership crosses an irreversible boundary only after the old binding closes;
   after that point the resolved target is adopted even when cancellation is observed, and target
   cleanup remains fatal. A direct old-close/target-ownership regression covers the boundary.
3. Fragmented assistant SSE text and progress accounting now use incremental UTF-8 byte tracking
   and bounded fragments while preserving final response, usage, event, and progress limits. A
   deterministic near-cap single-body fragmentation regression consumes 2,048 bounded fragments
   and verifies the exact 65,536-byte result and progress count; a direct-test observation bounds
   fragment and code-point accounting and contrasts it with the former growing-prefix scan.
4. History body, context preview, and post-install status delivery failures now propagate
   `EventDeliveryError` through fatal controller settlement, while store/provider availability
   failures remain sanitized and installed-checkpoint truth is preserved. Direct regressions cover
   all three modal paths and terminal restoration.
5. Semantic candidate selection builds one causal range index and evaluates summary-fitting
   boundaries in descending reference order, preserving the same-wire measurement, strict
   reduction, reserve, refusal rules, and mechanical-omission discontinuities. Known-answer and
   exact threshold regressions verify both the largest useful boundary and the indexed parser path.
6. History page loads now own an abort controller, generation, and settlement slot. Dismissal,
   reverse-page completion, EOF, and SIGTERM regressions prove stale results cannot redraw or
   outlive controller shutdown.

## Comprehensive closure verification

- `agent:session:navigation:test`: 6/6
- `agent:semantic-context:test`: 7/7
- `agent:session-store:test`: 20/20
- `agent:streaming:test`: 17/17
- `agent:tui:test`: 105/105
- `agent:session:test`: 15/15
- `agent:transport:test`: 16/16
- authoritative `v0:gate`: 664/664 (topology 2/2)
- `v0:check`, `v0:fmt`, `v0:lint`, and `git diff --check`: pass

The first full-gate attempt observed one isolated PTY process exit 137 in an existing cancellation
cleanup case. Three immediate isolated repetitions passed, and the complete authoritative rerun
passed 664/664; no source change was made for that harness observation. No plan delta or unrelated
bug was found. Provider/network/credential/production commands, real persistent product state,
dependency/lockfile, `_refs/`, push, tag, publish, release, and commit operations remained out of
scope. Independent changed-lines review and final owner disposition remain pending.

## Independent review finding closure

The approved single bounded review pass closed the semantic non-monotonic correctness P2 and the
two evidence P2s without changing the Step 83 contract, schema, provider wire, permissions,
dependencies, or Human Gates:

- Semantic candidate selection now descends from the largest summary-fitting boundary whenever a
  prepared projected request fails, because mechanical omission can make prepared wire size
  discontinuous. The exact four-turn threshold regression proves boundary 3 fails strict reduction
  while boundary 2 omits the older 20,000-byte result and retains the protected newest 1,000-byte
  result.
- The session-store test-only pre-lock barrier deterministically holds a pending opener while an
  active owner commits a newer record and correlated checkpoint, releases, and then permits the
  opener's lock/read phase. Assertions cover the latest next-turn, canonical transcript, and
  checkpoint boundary/summary.
- The SSE test-only accounting observer records one fragment-byte measurement per 2,048 deltas
  and one progress code-point step per bounded visible scalar. The test verifies 65,536 input and
  progress bytes and a deterministic lower bound showing the former growing-prefix scan would
  exceed the observed one-pass work by more than three orders of magnitude.

The closure focused suites and authoritative gate were rerun after these changes; independent
changed-lines re-review is limited to these three findings and any correction-caused Blocker/P1.

## Final comprehensive disposition

The single narrow re-review closed the semantic discontinuity, locked-snapshot race evidence, and
SSE structural-work findings, with no correction-caused Blocker or P1. It returned `GO`,
Blocker/P1/P2 zero. The representative 6 MiB/1,000-turn semantic shape completed in 193 ms on the
review VM versus the original approximately 6.9-second observation. The coordinating owner then
independently reran the authoritative `v0:gate`; all 664/664 tests passed with topology 2/2,
`v0:check`, 135-file format check, 132-file lint, and `git diff --check` green. Final owner
disposition is Blocker/P1/P2 zero. The user subsequently authorized one final integration commit
for this reviewed closure; no other excluded operation occurred.
