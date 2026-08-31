# Step 82 implementation results: daily editor and no-lost-input

Plan: [`daily-editor-no-lost-input.md`](daily-editor-no-lost-input.md), SHA-256
`a0be3aedc6e3612b123cdf92073dd3e4febf4da61d21323d4d7d113a9614d0fa`.

## Implemented surface

- `TuiEditor` now owns a bounded scalar cursor, multiline insertion/deletion, logical-line
  movement, atomic paste/overflow rejection, and `TuiEditorHistory` (32 entries / 256 KiB).
- `InputDecoder` recognizes Ctrl-O/W/P/N/R, Tab, the declared cursor/Home/End CSI forms, and
  consumes unsupported SS3 sequences as bounded unknown events while retaining strict UTF-8, paste,
  CRLF, and legacy/xterm Alt+Enter behavior.
- `PendingInputCore` owns one active-task, steering, follow-up, and each recovery lane. Its frozen
  projection contains only lane kind, lifecycle, presence, and byte count.
- `WorkspacePathIndex` performs bounded root-relative regular-file indexing without file-content
  reads, enforces its entry budget while iterating, snapshots/revalidates traversed directories,
  follows no symlinks, excludes root `.git`/`_refs`, and emits quoted escaped exact matches.
- TUI controller/runtime wiring is opt-in for direct fake seams and enabled for the production
  runtime; steering events cross a synchronous consume bridge. Terminal restore exposes a sanitized
  latched status and cleanup failure wins the exit result. The production path carries the
  canonical prepared workspace root separately from display projection for indexing.
- Renderer has pure bounded multiline layout, cursor placement, and fixed two-row pending metadata
  projection helpers.
- `AgentSession.isAvailable()` is a read-only structural post-settlement seam.

## Success criteria evidence

| Criterion | Evidence |
| --- | --- |
| 1. multiline exact submit | `agent:tui:test` editor/controller cases, 25/25 |
| 2. bounded history | `agent:tui:test` history bounds, duplicate, cursor-draft, and detach cases, 25/25 |
| 3. workspace path reference | `agent:tui:file-reference:test`, 6/6; bounded iterator, drift, and escaping |
| 4. distinct fixed lanes | `agent:tui:pending:test`, 3/3; frozen seven-lane metadata projection |
| 5. explicit recovery | `agent:tui:test` modern fixed-lane cancellation/recovery cases, 47/47 |
| 6. no duplicate/consumed recovery | synchronous bridge, active commit, follow-up detach, and PTY causal paths; 47/47 |
| 7. discard confirmation | typed modern Ctrl-C/Ctrl-D, timeout/cross-key, and signal cases; 47/47 |
| 8. 80x24/render priority | `agent:tui:test` multiline layout/metadata case, 11/11 render tests |
| 9. compatibility | PTY 33/33, portable 2/2, persistent-session 9/9, steering 7/7, full gate 624/624 |

## Verification

Focused permission-free new leaves:

```text
deno test --no-prompt tests/v0/tui_pending_input_test.ts   # 3/3
deno test --no-prompt tests/v0/tui_file_reference_test.ts   # 6/6
```

Focused editor/render/controller suites pass 25/25, 11/11, and 47/47. New pending/file-reference
leaves pass 3/3 and 6/6. Focused PTY, portable, persistent-session, and steering tasks pass 33/33,
2/2, 9/9, and 7/7. `v0:offline-gate:topology:test` passes 2/2; `v0:check`, `v0:fmt`,
`v0:lint`, and `git diff --check` pass; authoritative `v0:gate` passes 624/624.

The single approved closure pass closed the initial P1-1 history-detach and P1-2 typed-signal
transition findings with direct and PTY evidence. It also closes P2-1 restore-failure propagation,
P2-2 bounded SS3 consumption, P2-3 iterator/drift bounds, and P2-4 process/race evidence. The
single narrow changed-lines re-review is `GO`, Blocker/P1/P2 zero. The coordinating owner independently
reran TUI 83/83, pending 3/3, file-reference 6/6, PTY 33/33, and authoritative `v0:gate` 624/624;
final owner disposition is Blocker/P1/P2 zero.

Credential reads, provider/network requests, production task execution, actual persistent product
state, dependency/lockfile changes, `_refs/` access, and representative human acceptance: 0 / not
performed. The separate provider-free representative human acceptance remains an unconsumed Human Gate.

## Changed files

```text
v0/tui/input.ts
v0/tui/pending_input.ts
v0/tui/file_reference.ts
v0/tui/render.ts
v0/tui/controller.ts
v0/tui/terminal.ts
v0/agent/session.ts
v0/agent/tui_cli.ts
tests/v0/tui_pending_input_test.ts
tests/v0/tui_file_reference_test.ts
tests/v0/tui_input_test.ts
tests/v0/tui_render_test.ts
tests/v0/tui_controller_test.ts
tests/v0/tui_process_test.ts
tests/v0/fixtures/tui_process_fixture.ts
tests/v0/agent_startup_orientation_test.ts
tests/v0/agent_session_tui_test.ts
tests/v0/portable_tui_launch_process_test.ts
tests/v0/tui_topology_test.ts
tests/v0/offline_gate_topology_test.ts
deno.v0.json
README.md
docs/plans/daily-editor-no-lost-input-results.md
AGENTS.md
.handoff/handoff.md
```

Permission topology remains unchanged for production (`--allow-read=<repo-root>` already covers the
startup index), and the two new leaves are permission-free fake-core tasks. Credential reads,
provider/network requests, production task execution, actual persistent product state,
dependency/lockfile changes, `_refs/` access, and representative acceptance are zero/not run.
The implementation deliberately does not add persistence, session-schema/manifest/replay fields,
provider behavior, a general queue, or external editor/picker features. Fatal crash/kill/restart
does not promise pending-input recovery, and completed local tool effects are not rolled back.
