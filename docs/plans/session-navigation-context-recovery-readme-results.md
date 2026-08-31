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
