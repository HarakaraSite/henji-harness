# Detached three-band human UI implementation results

Plan: `docs/plans/detached-three-band-human-ui.md`

Plan SHA-256: `17fc9d71afa3c8ba818bd4aa9a65c09736abaed2647e467943b2dfca20bd9568`

Input SHA-256: `e765fd216faa746aae80046408b702dbafd90048e26e5081056a3c04b2925de7`

Base: `39d020c7a2706fbc8686185a31c32f1e7e936aca`

## Implementation

The approved Step 83R increment is implemented without a new dependency or a core/session schema
change.

- `v0/presentation/contract.ts` is a readonly, bounded, immutable data contract for projections,
  events, intents, navigation, history, and context results. Caller-owned values are validated,
  cloned, and deep-frozen before delivery.
- `v0/agent/tui_presentation_adapter.ts` is the core-owned adapter. It validates and sanitizes core
  events/outcomes and maps provider call IDs to presentation-private opaque IDs. Malformed or
  unknown activity cannot stringify raw payloads into the UI.
- `v0/tui/state.ts` is an I/O-free immutable reducer with bounded causal log retention, same-entry
  assistant/tool progress replacement, source anchors, overlays, pending metadata, and resize state.
  `v0/tui/layout.ts` computes the bounded log/input/footer geometry and reflow from state only.
- `v0/tui/render.ts` has a retained production mode with one three-band frame, compact startup and
  F1 help, bounded terminal escaping, cursor-safe multiline input, and no append-only live rows.
  Direct injected test seams retain the historical orientation output for compatibility coverage.
- `v0/tui/controller.ts` consumes neutral presentation values only. Existing navigation, history,
  context, cancellation, steering, follow-up, recovery, and failure settlement remain core-owned.
  `v0/tui/terminal.ts` adds UI-local coalesced resize delivery and unregister-before-restore.
- `v0/agent/session_history.ts` no longer imports the renderer; canonical history framing and UI
  escaping are separate. `v0/agent/tui_cli.ts` is the sole production composition root.
- The decoder adds PageUp/PageDown, Ctrl-L, F1, and the exact legacy/xterm Alt-Enter forms while
  preserving the 50 ms timeout and existing multiline/editor contracts.

The production screen keeps compact welcome facts in the log band only until the first restored or
new user message; the full twelve-line orientation is an F1 overlay. The compact frame is not
ordinary canonical conversation history. Resize, scrolling, overlays, live progress, and pending
lanes remain UI-local and text-free at the boundary.

## Approved finding closure

The initial changed-lines review returned Blocker 0 / P1 5 / P2 4. The approved single closure pass
added direct production-path regressions and the following corrections:

- P1 retained cursor/overlays: `renderFrame()` now retains the layout cursor and all help, picker,
  history, and compaction overlays in the immutable state/frame; direct render coverage verifies
  non-end editing, resize/reflow, overlay round trips, and base-state restoration, and the retained
  acceptance process leaf verifies the cursor and overlay path in a PTY child.
- P1 adapter authority: the neutral contract now has one data-only `PresentationIntentDispatcher`
  and typed result union. The adapter owns validation, cancellation/compaction abort ownership,
  navigation adoption, and authoritative events; the controller's production path sends typed
  intents. `tui_presentation_adapter_test.ts` covers admission/rejection, cancellation, and
  ownership ordering.
- P1 authoritative replacement: irreversible resume adopts the target before emitting
  `session_binding_replaced` and `restored_log`; the reducer clears the prior retained log rather
  than merging it. Adapter and state regressions cover delayed delivery and exact replacement.
- P1 terminal final: retained terminal JSON is reduced to one assistant entry and one frame record,
  with no duplicate tool display; direct render and retained process acceptance cover the path.
- P1 acceptance separation: `agent:ui-retained:acceptance:test` and its bounded
  `agent:ui-retained:acceptance:process:test` use the shipped retained controller/renderer/adapter
  with a deterministic in-memory fake host, exact known answers, and no provider, network,
  credential, production command, or persistent state.
- P2 scrolling: page movement stores source scalar anchors through wrapped multiline reflow, with
  corrected newline offsets (`tui_render_test.ts`).
- P2 tool identity: call, progress, and result share one opaque retained entry identity while causal
  multi-tool ordering remains intact (`tui_state_test.ts`, adapter coverage).
- P2 retention: active entries are never evicted and all-active pressure is compacted in place
  without exceeding the 256 KiB aggregate bound (`tui_state_test.ts`).
- P2 topology: supplied-source mutation tests reject every required reverse edge, adapter or
  composition bypass, and inventory escape (`ui_boundary_topology_test.ts`).

The closure did not alter the canonical plan, external contracts, permissions, or operation scope.

## Repository-owned acceptance launcher local fix

The Human Gate command is now the executable repository-owned launcher
`./v0/agent/ui_retained_acceptance_launcher.sh`. It resolves the repository root relative to its
own location, works from an arbitrary current directory, rejects all arguments, validates the fixed
Deno 2.9.4 executable, and executes only `run --no-prompt --no-remote` for the provider-free fake
fixture. Missing, wrong-version, and non-executable Deno cases return the same bounded sanitized
startup failure. The launcher task has no Deno permission flags; only its process-test leaf grants
the test-only `/bin/sh` and `/tmp` permissions needed to exercise copied launcher variants.

Launcher process coverage is **4/4**, TUI topology is **6/6**, offline topology is **2/2**, and
`v0:check`, `v0:fmt`, `v0:lint`, and `git diff --check` are green after the fix. The previous
authoritative `v0:gate` result (**699/699**) predates this launcher/task-inventory addition; a new
the coordinating owner subsequently ran the expanded full gate successfully. The real-screen Human
Gate was attempted later but did not establish usability and is not replaced by process evidence.

## Requirement-to-evidence

| Success condition                        | Evidence in this increment                                                              |
| ---------------------------------------- | --------------------------------------------------------------------------------------- |
| 1. Three stable bands                    | `tui_layout_test.ts`, retained `renderFrame()`, existing TUI/process suites             |
| 2. Causal task/stream/tool/final display | adapter identity tests, reducer coalescing, existing streaming/TUI suites               |
| 3. Bounded editor/no loss                | existing scalar editor/paste/history/pending suites plus layout tests                   |
| 4. Predictable scroll/resize             | source-anchor reducer/layout, terminal resize lifecycle, TUI controller/process suites  |
| 5. Overlay restoration/no submit         | typed modal controller paths, existing navigation/history/context suites, F1 state path |
| 6. Compact discoverable startup          | retained compact startup and F1 help paths; portable TUI process regression             |
| 7. Detached typed boundary               | `presentation_contract_test.ts`, adapter tests, `ui_boundary_topology_test.ts`          |
| 8. Shared unchanged core                 | headless import-closure topology and full legacy/runtime/session gate                   |
| 9. Security/persistence/restore          | bounded sanitization, exact permissions, existing cancellation/session/PTY regressions  |
| 10. Daily-use human acceptance           | **Pending** one explicit final real-screen Human Gate; not run here                     |

## Verification

Focused new leaves:

- `agent:ui-presentation:test`: **22/22** (contract 4, adapter 8, state 8, layout 2).
- `agent:ui-retained:acceptance:test`: **1/1**.
- `agent:ui-retained:acceptance:process:test`: **1/1**.
- `agent:ui-retained:acceptance:launcher:process:test`: **4/4**.
- `agent:ui-boundary:topology:test`: **3/3**.

Related focused checks:

- `agent:tui:test`: **112/112**.
- `agent:tui:process:test`: **33/33**.
- `agent:portable-tui:process:test`: **2/2**.
- `agent:tui:topology:test`: **6/6**.
- `agent:session:tui:test`: **9/9**.
- `agent:session:navigation:test`: **6/6**.
- `agent:semantic-context:test`: **15/15**.
- `agent:cancellation:test`: **18/18**.
- `agent:streaming:test`: **17/17**.
- `agent:tool-progress:test`: **7/7**.
- `v0:offline-gate:topology:test`: **2/2**.

Repository gates:

- `v0:check`: pass.
- `v0:fmt --check`: pass.
- `v0:lint`: pass.
- `git diff --check`: pass.
- `v0:test`: **703/703** tests across **58** leaf summaries, exit 0.
- authoritative `v0:gate`: exit 0; topology **2/2**, check/format/lint/diff green, and the full
  **703/703** offline test phase green.

The full gate includes the existing permission-free fake, session, context, cancellation, streaming,
runtime, work-tool, navigation, and PTY coverage. No real-provider or credential-file task was
invoked. The presentation and retained-acceptance direct leaves are permission-free; the retained
acceptance process leaf grants only `/usr/bin/script`; and the boundary leaf reads only
`deno.v0.json`, `v0/agent`, `v0/presentation`, `v0/tui`, `v0/domain.ts`, and `v0/model.ts`.
Production permissions were not widened. An initial gate attempt exposed task-inventory drift; the
task/topology inventory was corrected within scope, and the final gate above is green.

## Residual correction closure and final review

The two correction-caused P1s are directly covered. P1
adapter-owned navigation cancellation is closed by adapter-integrated controller regressions for
Escape before old-close, EOF, SIGTERM, and output failure; delayed list/switch hosts observe abort,
settle before terminal restoration, and retain the old binding/projection. P1 acceptance separation
is closed by an explicit interactive provider-free fake-host task and real-PTY known-answer leaf:
`agent:ui-retained:acceptance` launches the shipped retained controller/renderer/adapter with no
permissions, while its process test grants only `/usr/bin/script`.

The human command is intentionally listed but not executed:

```text
./v0/agent/ui_retained_acceptance_launcher.sh
```

The PTY known-answer sequence drives fake stream/tool/final, PageUp/PageDown/Ctrl-L, F1, Ctrl-G/T/K
picker/history/compaction, multiline, resize, cancellation, and clean terminal restore. At the
pending Human Gate, use this one command in a real disposable terminal; do not enter a task that
would contact a provider unless separately approved. This package does not claim that the mechanical
PTY check replaces that human screen decision.

The narrow re-review closed both correction-caused P1s and returned `GO`, Blocker/P1/P2 zero. The
owner independently reran presentation 22/22, retained acceptance direct/process 1/1 and 1/1, TUI
112/112, PTY 33/33, TUI topology 6/6, boundary topology 3/3, `git diff --check`, and the
authoritative `v0:gate`; all passed, including the full 699/699 offline phase. After the local
launcher was added and narrowly reviewed GO, the owner reran the expanded authoritative gate;
launcher process 4/4 and the full 703/703 offline phase passed. Final owner disposition is
Blocker/P1/P2 zero. No plan delta or plan-external bug was found. Known
implementation limitation remains the plan's deliberate absence of Kitty keyboard negotiation and
the trusted-local Bash boundary.

## Human observation

The provider-free real-screen run reached the F1 overlay. The user judged the displayed startup
facts and compressed key list to be wholly incomprehensible and not usable as human help. Help
redesign is explicitly deferred; no wording, layout, behavior, requirement, or implementation fix
is selected by this record. Success condition 10 therefore remains unresolved, and the observation
must not be replaced by the mechanical PTY result.

The user then entered a natural task asking for a README summary. The fixture ignored its meaning
and displayed a predetermined acceptance object and fake-tool success while retaining a turn-zero
footer. The user could not determine whether this represented the intended product UI. This proves
that the free-form fake fixture is suitable only for mechanical wiring checks, not for judging the
intended daily-use experience. The Human Gate is therefore not passed; further interaction with the
same fixture has no acceptance value. A future Human Gate requires either an explicitly guided
scenario with observable expected results or a separately authorized realistic runtime. Neither is
selected or implemented here.

## Scope and operation record

No provider request, network operation, credential read, production provider command, real
persistent product-state operation, dependency or lockfile change, `_refs/*` operation, commit,
push, tag, publish, or release operation was performed. Existing `.handoff/handoff.md` changes and
user-owned `_refs/*` trees were preserved. The only workspace changes are the Step 83R source,
tests, task/topology inventory, README, and this result record, alongside pre-existing coordinator
handoff changes.

Rollback is one bounded increment: remove the contract/adapter/retained UI files and their task,
topology, test, README, and result changes, restoring the prior append-oriented TUI wiring without
touching canonical session/context data.
