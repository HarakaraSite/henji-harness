# Henji Harness

## Start here

Henji Harness is a pre-alpha, trusted-local Deno agent harness. The active implementation is in
[`v0/`](v0/); archives are historical evidence only. Run from the repository root with Deno 2.9.4 on
`PATH`, a POSIX shell, and a real stdin/stdout TTY for the TUI:

```text
deno task --quiet --config deno.v0.json agent:tui
```

The default starts a new autosaved session. The selected OpenRouter profile is contacted only after
a submitted task reaches the provider adapter. Work tools run as the current OS user; there is no
hard sandbox or per-tool confirmation.

The human screen is a retained three-band view: a scrollable work/conversation log, a bounded
multiline input band, and one status/footer row. It reflows on resize without sending resize events
to the agent. The first screen keeps a compact two-line welcome; press F1 for the full startup facts
and press F1 or Esc to return without submitting the draft.

## Read startup orientation

Startup orientation states the workspace, selected agent/profile, session mode, discovered
`AGENTS.md` and project-local skills, request-time credential rule, and trusted-local tool boundary.

The normal runtime selects one built-in Definition once at startup. Omitted `--agent` selects
`default`, with `bash`, `edit`, `read`, `submit_json_result`, `write`, and bounded planner
delegation. `--agent planner` selects the read-only planner, with `read`, optional `skill`, and
`submit_json_result`. Selection cannot change between turns.

```text
deno task --quiet --config deno.v0.json agent:tui --agent planner --no-session
deno task --quiet --config deno.v0.json agent:tui --continue
```

The TUI accepts one persistence selector (`--continue`, `--session UUID`, or `--no-session`) and the
optional agent selector, in either order. Invalid, duplicate, conflicting, or positional arguments
fail before workspace, terminal, session, provider, or credential setup. `--no-session` is ephemeral
and does not access the session state root. `agent:run` is the non-interactive production provider
command; do not invoke either production path without explicit approval.

PageUp/PageDown scroll the retained log; repeated PageDown reaches the latest output. Anchors use
source positions, so a resize or live progress update does not unexpectedly jump the viewport. Live
assistant/tool activity replaces one bounded row and completed causal records remain in the log.

## Daily editing

The editor accepts bounded multiline UTF-8 input up to 65,536 bytes. Enter submits a nonblank idle
task; Alt+Return inserts a newline (Shift/Ctrl+Return where the terminal sends them); readline
editing (Ctrl-A/E/B/F, Alt-B/F, Ctrl-K/U/W, Alt-D); arrows/Home/End move the cursor (Up/Down walk
input history at empty input or the top edge); Tab completes workspace-relative paths; and empty
Enter only updates status.

`read`, `write`, and `edit` operate within the invocation workspace, reject symlinks/special files,
and use synchronized sibling temporaries with atomic rename. `bash` runs
`/bin/bash --noprofile --norc -c COMMAND` with bounded output and timeout. These tools can reach
outside the workspace, the network, and child processes as the current OS user.

## While work is running

The TUI renders bounded live assistant and Bash progress snapshots as replaceable display state.
Partial output is never committed, sent back to the model, or persisted; a completed model result is
authoritative.

While busy, Enter admits at most one NUL-free steering message up to 65,536 bytes, consumed only
between complete nonterminal tool batches. Alt-Enter admits one ordinary follow-up slot, started
only after durable success of the current turn. Cancellation, failure, exit, EOF, and shutdown drop
pending text without silent resubmission.

Escape requests cooperative cancellation. Ctrl-C requests cancellation; a second Ctrl-C within the
confirmation window discards pending input and exits after settlement. SIGTERM/SIGHUP settle and
exit 143/129. Cancellation does not roll back completed local effects. Cleanup failure is fatal and
poisons the session. Raw mode, cursor state, bracketed paste, and the single input reader are
restored on handled exits and failures.

## Sessions and history

Persistent successful parent turns are canonical schema-v1 `session.json` records containing the
complete parent transcript. Provider views, progress, credentials, Definition/manifest data, and
display history are not stored. State is repo-external, workspace-partitioned, bounded, locked, and
atomically replaced.

Metadata-only list and confirmed delete:

```text
deno task --quiet --config deno.v0.json agent:sessions list
deno task --quiet --config deno.v0.json agent:sessions delete --session UUID --yes
```

When idle with an empty editor and all pending lanes empty:

- `/sessions` opens the current-workspace session picker, at most eight metadata rows per page, with
  short/full UUID, agent, updated time, turn/message counts, and current/resumed/mismatch state.
  Enter resumes the exact selected UUID only after opening and materializing its target. The old
  binding closes before current binding changes; failures retain the old session and never fall
  back.
- The committed canonical history is read-only in the session store and currently has no TUI entry
  point. Causal `user`, `steer`, `assistant`, `tool>`, and `tool<` records are preserved with at
  most 8 KiB source text, 32 KiB escaped terminal output, and 16 content rows per page.

The main status shows short session ID, agent, and latest committed turn; picker/history headers
show the full UUID. An empty new reservation appears as one synthetic current row; listing alone
does not create state.

## Context recovery

Long sessions compact automatically before a turn starts (see above); the manual panel currently has
no TUI entry point. The panel shows committed turns, current checkpoint state, proposed
covered/retained range, and byte-aware provider-view estimate. It states that the operation uses one
provider request and leaves canonical history unchanged.

Enter confirms one semantic summary request. The selected profile receives the exact summary prompt,
one compact user envelope containing canonical parent turns, and `tools: []`; accepted output is
strict JSON `{"schemaVersion":1,"summary":"..."}`. One checkpoint is stored beside (not inside)
`session.json` as `contexts/<session UUID>.json`, bounded to 16 KiB file bytes and 12,288-byte
summary bytes.

Admission uses the production wire encoder: serialized `messages` below 77,824 bytes and full body
below 256 KiB. It reserves a worst-case 4,096-byte next draft and a 16,384-byte checkpoint-message
contribution, retains at least the latest complete turn, and selects the largest useful strict
reduction. Semantic projection precedes mechanical old-tool-result omission. No useful boundary,
generation/validation/cancellation/timeout failure, or durable replacement failure leaves canonical
history or the previous checkpoint changed. Escape cancels before write; `v` shows a checkpoint
summary read-only. Checkpoints rehydrate on restart; canonical history remains the sole authority.

## Exit and recovery

Empty Ctrl-D exits only when editor, active task, steering, follow-up, recovery, and discard lanes
are empty. Successful turns commit before queued follow-up starts; failed/cancelled drafts do not
commit. Restart restores the complete successful transcript and latest valid checkpoint, but not
in-flight provider work, pending editor text, or uncommitted tool effects.

## Security and stored data

Session/context files are plaintext repo-external state protected by partitioning, validation,
mode-0600 files, and locks. `AGENTS.md` and project-local skills are rediscovered on startup/resume
and sent as first-class instructions, not copied into canonical history. Credentials are resolved
only at request time; offline tests do not read credential files or access the provider. `bash`
remains trusted-local OS-user execution without hard sandbox, network isolation, or full descendant
containment.

There is no branch/fork, rewind, history edit, search, export/import, rename/tagging, summary chain,
multiple checkpoint, login/model picker, pending-restart recovery, or tool-effect rollback. Before a
turn starts, an estimated provider view at or above 64K est triggers one automatic semantic
compaction: the largest useful strict reduction is summarized with a single provider request and
stored as a checkpoint beside (not inside) `session.json`, and the turn starts only after a
successful install. A failed or cancelled compaction stops the submit with recoverable input; the
normal log keeps one `system>` row for each automatic install. Context recovery may refuse when
original history plus the 4 KiB draft reserve cannot fit a useful projection under live adapter
ceilings.

## Provider-free guided confirmation

These local fake-session checks exercise navigation/context contracts without provider requests,
network, credentials, production commands, or persistent product state:

```text
deno task --quiet --config deno.v0.json agent:session:navigation:test
deno task --quiet --config deno.v0.json agent:semantic-context:test
deno task --quiet --config deno.v0.json agent:session-store:test
deno task --quiet --config deno.v0.json agent:tui:test
deno task --quiet --config deno.v0.json v0:gate
```

The last command is the authoritative offline gate. Real provider acceptance and credential-file
launchers are separate explicit Human Gates and are excluded from the offline gate.

## Provider-free retained UI acceptance

The detached retained UI has a separate deterministic acceptance package. It uses the shipped
controller, renderer, and presentation adapter with an in-memory fake host, and does not contact a
provider, use the network or credentials, run a production command, or create persistent product
state:

```text
deno task --quiet --config deno.v0.json agent:ui-retained:acceptance:test
deno task --quiet --config deno.v0.json agent:ui-retained:acceptance:process:test
```

The direct leaf checks retained stream/tool/final, overlays, resize, cursor restoration, and
sanitized opaque identity. The process leaf runs the same known-answer fixture in a bounded PTY. The
explicit provider-free human task is the retained controller/renderer/adapter fake host under a real
terminal:

```text
./v0/agent/ui_retained_acceptance_launcher.sh
```

The repository-owned launcher resolves the repository root and executes the fixed Deno
`--no-prompt --no-remote` fixture from any working directory. It accepts ordinary fake
stream/tool/final work and the actual F1, Ctrl-G/T/K, PageUp/PageDown, Ctrl-L, multiline, resize,
cancellation, and clean-exit keys. It has no provider, network, environment, read, write, run, or
persistent-state permission. The normal `agent:tui` production path is not this acceptance command
and remains outside the pending Human Gate.

## Full-capability production acceptance (separate Human Gate)

The full acceptance uses the installed bare `henji` from a disposable workspace, with the default
agent, real provider, full workspace tools, and persistent session. It is a trusted-local command:
tools and Bash run as the OS user and may reach outside the workspace or network. Follow the exact
three-turn task, bounds, stop conditions, and cleanup in
[`docs/plans/step-83-full-capability-human-acceptance-gate.md`](docs/plans/step-83-full-capability-human-acceptance-gate.md).
The offline test gate does not run this acceptance. The separately approved one-shot production
acceptance was consumed on 2026-09-01 and stopped at Turn 1 `contract_failure` without retry; see
the linked gate and results. The run is non-evaluable because safe cause and request-count evidence
were not exposed or retained; do not use it for an adoption decision or repeat it unchanged.

The revision-42 retry has a separate, still-unapproved implementation package at
[`docs/plans/step-83-full-capability-human-acceptance-retry-gate.md`](docs/plans/step-83-full-capability-human-acceptance-retry-gate.md).
It is not authorized by the consumed acceptance and must not be executed until the repository
implementation review and a separate final execution Human Gate are complete.

```text
cd /tmp/henji-step83-full-capability-acceptance
henji
```

## Failure diagnostics

When a turn fails, the retained TUI log shows a bounded `failure>` line with the failure stage, safe
code, actual provider-request count, applicable HTTP status and parser reason, turn/model step, and
one diagnostic ID. The same ID is printed in the readback command:

```text
henji diagnostics list
henji diagnostics latest
henji diagnostics show --id <UUID>
```

These commands are read-only: they inspect only the caller workspace's diagnostic namespace and do
not start a provider, credential, tool, session, or context operation. A record is workspace-
partitioned and bounded to 16 records and 16 KiB of canonical data. To remove one record after
inspection, use the exact separately authorized command:

```text
henji diagnostics delete --id <UUID> --yes
```

Diagnostic records contain only fixed allowlisted enums, counts, timestamps, and bounded status.
They never contain credential values, Authorization headers, raw request/response or model data,
tool/session content, paths, or arbitrary error text. Successful turns remain diagnostic-free. Clean
cancellation after an accepted turn creates one bounded `turn_control/turn_cancelled` diagnostic;
cleanup failure retains precedence, and failed-turn/session cleanup does not remove an existing
record.

## Provider evidence readback

Each accepted provider turn in the normal retained session keeps one workspace-partitioned
provider-evidence artifact. It correlates the serialized request body, non-credential request
metadata, HTTP response status/headers and raw bytes, ordered SSE frames, parser transitions,
model/tool events, outcome, and actual request counts. Successful and failed turns are retained;
there is no automatic cleanup or quota in this pre-alpha slice.

The read-only diagnostics surface lists or opens an artifact directly:

```text
henji diagnostics evidence list
henji diagnostics evidence show --id <evidence-id>
```

When a parser failure has a diagnostic ID, the same `show` command accepts that diagnostic ID and
resolves its evidence link. The capture boundary does not receive credential values or request
headers, so the private request Authorization header is absent from stored evidence; response
headers and provider metadata remain available for diagnosis. The repository-local HTTP/SSE fixture
confirms OpenRouter's documented final usage chunk (content-free assistant delta, repeated terminal
finish reason, usage before `[DONE]`); real-provider shape and human acceptance remain separate
gates.

## Developer/reference appendix

Product source is [`v0/`](v0/), tests [`tests/v0/`](tests/v0/), task configuration
[`deno.v0.json`](deno.v0.json), plans/results [`docs/plans/`](docs/plans/), and continuation state
[`.handoff/handoff.md`](.handoff/handoff.md). The Step 83 plan is
[`docs/plans/session-navigation-context-recovery-readme.md`](docs/plans/session-navigation-context-recovery-readme.md).
The detached three-band UI plan and implementation results are
[`docs/plans/detached-three-band-human-ui.md`](docs/plans/detached-three-band-human-ui.md) and
[`docs/plans/detached-three-band-human-ui-results.md`](docs/plans/detached-three-band-human-ui-results.md).
The full-capability acceptance package and implementation results are
[`docs/plans/step-83-full-capability-human-acceptance-gate.md`](docs/plans/step-83-full-capability-human-acceptance-gate.md)
and
[`docs/plans/step-83-full-capability-human-acceptance-results.md`](docs/plans/step-83-full-capability-human-acceptance-results.md).
The revision-42 retry plan and results are
[`docs/plans/step-83-full-capability-human-acceptance-retry.md`](docs/plans/step-83-full-capability-human-acceptance-retry.md)
and
[`docs/plans/step-83-full-capability-human-acceptance-retry-results.md`](docs/plans/step-83-full-capability-human-acceptance-retry-results.md).

Useful checks:

```text
deno task --quiet --config deno.v0.json agent:session:navigation:test
deno task --quiet --config deno.v0.json agent:semantic-context:test
deno task --quiet --config deno.v0.json v0:offline-gate:topology:test
deno task --quiet --config deno.v0.json v0:check
deno task --quiet --config deno.v0.json v0:fmt
deno task --quiet --config deno.v0.json v0:lint
deno task --quiet --config deno.v0.json v0:test
deno task --quiet --config deno.v0.json v0:gate
```

`v0:gate` runs topology, check, format, lint, and full offline composition. Every direct test file
is owned by exactly one bounded leaf, with only declared minimum permissions. Production TUI/run,
credential launchers, provider network, dependency/lockfile changes, and `_refs/` are outside this
gate. Earlier plans and archives remain historical evidence; [`archive/`](archive/) is not active
source and [`_refs/`](_refs/) is not a dependency.
