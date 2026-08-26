# Zot-first first TUI implementation results

## Scope and authority

This local increment implements the approved plan
`docs/plans/zot-first-tui.md` (SHA-256
`60ba3fef3b261c754a1b060fa76d2b62086fb4433e179bb285eee97c146f1fd8`). It adds the explicit
zero-argv real-TTY `agent:tui` command, a shared normal-runtime composition, one in-memory
multi-turn session, completed-event terminal UI, strict UTF-8 editor, central terminal escaping,
idempotent restoration, fake-terminal tests, bounded `/usr/bin/script` PTY tests, task wiring, and
README contract documentation.

## Changed files

- `v0/agent/runtime.ts`: extracted `createRuntimeComposition` and `createRuntimeSession`; retained
  `runRuntime` and the existing `agent:run` behavior.
- `v0/agent/tui_cli.ts`: exact invocation/TTY preflight, lazy runtime session setup, crash guard,
  lifecycle and exit/error mapping.
- `v0/tui/terminal.ts`: Deno terminal adapter, one-reader bounded drain, signal registration, and
  idempotent raw/paste/cursor/SGR restoration.
- `v0/tui/input.ts`: stateful strict UTF-8 and bracketed-paste decoder plus bounded editor.
- `v0/tui/render.ts`: main-screen scrollback, live editor/status line, event mapping, and the
  central dynamic terminal escaping/truncation boundary.
- `v0/tui/controller.ts`: idle/busy/exit-after-turn state machine and completed-event handling.
- `tests/v0/tui_input_test.ts`, `tui_render_test.ts`, `tui_controller_test.ts`: direct fake
  terminal/editor/controller coverage.
- `tests/v0/tui_process_test.ts`, `tests/v0/tui_topology_test.ts`,
  `tests/v0/fixtures/tui_process_fixture.ts`: bounded PTY and permission/task topology coverage.
- `deno.v0.json`: production TUI task, three local tasks, check inputs, and offline gate inputs.
- `README.md`: command, authorization, key, terminal, and deferred-boundary documentation.

## Requirement evidence

The direct suite covers split UTF-8, malformed/explicit-overlong rejection, individual CR/LF/CRLF
semantics, Unicode backspace, atomic and bounded paste, exact editor limits, control escaping,
bidi/ANSI neutralization, truncation, size fallback, tool-terminal final/event de-duplication,
closing-gate late writes, busy input discard, double Ctrl-C, Ctrl-D, Esc, event/output/model
failures, preflight ordering, all three pre-controller signals, partial acquire/read/write/restore
failures, and CLI error mapping. The PTY suite covers actual TTY detection, raw keyboard flow,
paste/control ordering, bounded natural completion, same-chunk `task\n` + Ctrl-C busy handling,
failure cleanup, non-TTY rejection, late-input drain, no alternate-screen sequence, and one-shot
cleanup for awaited, detached-error, and unhandled-rejection paths. The local topology suite
asserts the exact production permission literal, unchanged `agent:run` literal, check/gate
inclusion, and local process-task permission bounds.

The PTY harness prefixes its shell command with `stty -isig` so control-byte tests reach the
application rather than the harness foreground shell. Kernel SIGTERM/SIGHUP delivery remains
covered by the injected signal registration path and is not claimed by this fixed PTY harness.

## Verification

All commands use the embedded Deno 2.9.4 binary. The final command counts and outcomes are recorded
below after the complete offline gate. The three TUI local tasks remain in `v0:gate` and are
sequenced immediately before its all-tests `v0:test`; this keeps the installed `/usr/bin/script`
PTY task ahead of the full-suite subprocess fan-out after the opposite order intermittently failed
to launch the Deno executable. No gate coverage or permission was removed.

| Command | Result |
| --- | --- |
| `/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --config deno.v0.json agent:tui:test` | PASS — 26 tests |
| `/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --config deno.v0.json agent:tui:process:test` | PASS — 10 tests |
| `/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --config deno.v0.json agent:tui:topology:test` | PASS — 3 tests |
| `/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno test --no-prompt tests/v0/agent_session_test.ts` | PASS — 14 tests |
| `/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno test --no-prompt tests/v0/agent_loop_test.ts` | PASS — 22 tests |
| `/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno test --no-prompt tests/v0/agent_openrouter_model_test.ts` | PASS — 13 tests |
| `/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --quiet --config deno.v0.json agent:instructions:test` | PASS — 9 tests |
| `/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --quiet --config deno.v0.json agent:instructions:topology:test` | PASS — 1 test |
| `/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --quiet --config deno.v0.json agent:skills:test` | PASS — 12 tests |
| `/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --quiet --config deno.v0.json agent:skills:topology:test` | PASS — 3 tests |
| `/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --quiet --config deno.v0.json agent:work-tools:test` | PASS — 13 tests |
| `/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --quiet --config deno.v0.json agent:runtime:process:test` | PASS — 14 tests |
| `/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --quiet --config deno.v0.json agent:runtime:test` | PASS — 12 tests |
| `/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --config deno.v0.json v0:check` | PASS — 78 files checked |
| `/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --config deno.v0.json v0:fmt` | PASS — 78 files checked |
| `/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --config deno.v0.json v0:lint` | PASS — 75 files checked |
| `/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --config deno.v0.json v0:test` | PASS — 266 tests |
| `/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --config deno.v0.json v0:gate` | PASS — exit 0; 266 full-suite tests plus TUI 26 + 10 + 3 task tests |
| `git diff --check` | PASS — no output |

No production `agent:tui` or `agent:run` invocation, provider/network request, credential read or
probe, sentinel, dependency/lockfile operation, `_refs/` operation, commit, push, tag, publish, or
release was performed.

## Review, deviations, and residual risk

The initial review findings were addressed within the approved scope: signal handlers now register
before raw acquisition and pre-controller SIGINT/SIGTERM/SIGHUP are covered; pending stdin drain
uses the 50 ms idle bound within the 1,000 ms ceiling; same-chunk events after Enter use busy
semantics; and detached error/unhandled-rejection plus partial lifecycle and CLI mapping evidence
is present. The final owner-gate additions directly prove overlong UTF-8 rejection, CR/LF/CRLF
individual semantics, PTY same-chunk `task\n` + Ctrl-C exit-after-turn behavior, and exactly-once
tool-terminal final rendering. The gate task order is the only implementation-level adjustment:
TUI local tasks run before the all-tests task because the reverse order intermittently produced a
nested-Deno EACCES; coverage and permissions are unchanged. Known approved residual risks remain:
SIGKILL/power loss cannot restore a terminal; emulator-specific width/raw behavior is only covered
by fake terminal and util-linux PTY evidence; input already in the kernel after bounded drain
cannot be ruled out; in-flight provider/tool work has no cancellation; Bash remains trusted-local
OS-user execution; aggregate session cost and persistent history are deferred.

The single changed-lines re-review confirmed the production P1 and three original P2 findings were
closed and found no new Blocker/P1. Its remaining test-evidence P2 was closed by the four exact
regressions above and the owner final focused/full gate. Final owner disposition: **GO**, with
Blocker 0, P1 0, and P2 0.
