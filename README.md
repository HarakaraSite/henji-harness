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
to the agent. The first screen keeps a compact two-line welcome. Full F1 startup help is parked as
工事中. When idle, the available slash commands are `/help`, `/sessions`, and `/exit`.

## Read startup orientation

Startup orientation states the workspace, selected agent/profile, session mode, discovered
`AGENTS.md` and project-local skills, request-time credential rule, and trusted-local tool boundary.

The normal runtime selects one Definition once at startup. Omitted `--agent` selects the built-in
`default`, with `bash`, `edit`, `read`, `submit_json_result`, `write`, and bounded planner
delegation. `--agent planner` selects the read-only built-in planner, with `read`, optional `skill`,
and `submit_json_result`. `--definition ./henji.agent.ts` selects a trusted external Definition;
`--agent` and `--definition` are mutually exclusive, and the selection cannot change between turns.

Built-in Definitions and a caller-workspace trusted external Definition selected with
`--definition ./henji.agent.ts` use the same Worker loader, bootstrap, runtime, protocol, and Host
commit path. Existing schema-v1 sessions remain readable; a Worker commit writes schema-v2 with its
Definition revision binding. The provider-free implementation and its boundaries are recorded in
[`agent-worker-foundation-proof-stages-1-3-results.md`](docs/plans/agent-worker-foundation-proof-stages-1-3-results.md).

```text
deno task --quiet --config deno.v0.json agent:tui --agent planner --no-session
deno task --quiet --config deno.v0.json agent:tui --continue
```

The TUI accepts one persistence selector (`--continue`, `--session UUID`, or `--no-session`) and the
optional agent or Definition selector, in either order. Invalid, duplicate, conflicting, or positional arguments
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

Persistent successful parent turns are canonical `session.json` records containing the complete
parent transcript. Existing schema-v1 records remain readable; Worker commits write schema-v2 with
the Definition revision binding. Provider views, progress, credentials, and Manifest data are not
stored. State is repo-external, workspace-partitioned, bounded, locked, and atomically replaced.

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

Admission uses the production wire encoder: serialized `messages` at most 5 MiB (inclusive) and full
body at most 6 MiB (inclusive). It reserves a worst-case 4,096-byte next draft and a 16,384-byte checkpoint-message
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

## Provider-free verification

The current task definitions in `deno.v0.json` provide focused Worker and provider-compatibility
checks plus the repository checks:

```text
deno task --quiet --config deno.v0.json agent:worker-foundation:test
deno task --quiet --config deno.v0.json agent:provider-stream-compatibility:test
deno task --quiet --config deno.v0.json v0:check
deno task --quiet --config deno.v0.json v0:fmt
deno task --quiet --config deno.v0.json v0:lint
deno task --quiet --config deno.v0.json v0:gate
```

`v0:gate` is the authoritative repository gate. It does not run the production provider path,
credential-file launchers, or a real-provider Human Gate.

## Historical detached retained UI evidence

Earlier detached retained-UI fixture checks are historical evidence preserved in
[`detached-three-band-human-ui-results.md`](docs/plans/detached-three-band-human-ui-results.md).
Those old standalone acceptance tasks are not current task definitions. The normal `agent:tui`
production path and the focused tasks above are the current entry points; F1 remains parked as
工事中.

## Full-capability production acceptance (separate Human Gate)

The full-capability acceptance records are historical Human Gates for the installed bare `henji`
from a disposable workspace, with the default agent, real provider, full workspace tools, and
persistent session. The original Step 83 attempt and its separately authorized retry were both
consumed failures before the intended three-turn completion; neither is adoption evidence. See
[`step-83-full-capability-human-acceptance-results.md`](docs/plans/step-83-full-capability-human-acceptance-results.md)
and
[`step-83-full-capability-human-acceptance-retry-results.md`](docs/plans/step-83-full-capability-human-acceptance-retry-results.md).

FR1 and Gate 1 were accepted in later, separate real-provider Human Gates; their results are
[`fr1-real-provider-human-acceptance-results.md`](docs/plans/fr1-real-provider-human-acceptance-results.md)
and
[`gate-1-general-agent-production-acceptance-results.md`](docs/plans/gate-1-general-agent-production-acceptance-results.md).
The Worker real-provider gate remains a separate unexecuted Human Gate after its provider-free
implementation and corrections; see
[`agent-worker-real-provider-gate-corrections-results.md`](docs/plans/agent-worker-real-provider-gate-corrections-results.md).
The Worker acceptance needs its separate execution package and explicit approval.

## Failure diagnostics

When a turn fails, the retained TUI log shows a short fixed `failure>` reason. Detailed failure stage,
safe code, actual provider-request count, applicable HTTP status and parser reason, turn/model step,
and the diagnostic ID are available through the read-only diagnostics commands:

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

## Worker execution readback

Each admitted Worker turn also has a Host-owned execution artifact. It correlates the immutable
Definition revision and evaluated Manifest with the Worker generation, accepted turn command,
ordered bootstrap/protocol trace, provider-evidence ID, Host session-store result, commit
acknowledgement, and final settlement. The artifact is written once after Host settlement under the
workspace's state namespace; it is separate from both `session.json` and provider evidence.

Read-only execution diagnostics are available from the caller workspace:

```text
henji diagnostics executions list
henji diagnostics executions show --id <execution-id>
```

`executions list` projects each record to `executionId`, `settledAt`, `sessionId`, `turn`,
`definitionKind`, `workerGeneration`, `settlement`, and (when present) `providerEvidenceId`.
`executions show` returns the complete execution artifact.

`committed_generation_unavailable` means the canonical session was committed but the Worker
generation could not receive or complete its acknowledgement. Artifact persistence failure is
reported additively and never rolls back or replays the committed session. Effects remain
non-transactional, and normal conversation output does not display artifact contents.

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
The Worker foundation and gate-correction plans and results are
[`docs/plans/agent-worker-foundation-proof-stages-1-3.md`](docs/plans/agent-worker-foundation-proof-stages-1-3.md),
[`agent-worker-foundation-proof-stages-1-3-results.md`](docs/plans/agent-worker-foundation-proof-stages-1-3-results.md),
[`docs/plans/agent-worker-real-provider-gate-corrections.md`](docs/plans/agent-worker-real-provider-gate-corrections.md),
and
[`agent-worker-real-provider-gate-corrections-results.md`](docs/plans/agent-worker-real-provider-gate-corrections-results.md).

Useful checks:

```text
deno task --quiet --config deno.v0.json agent:worker-foundation:test
deno task --quiet --config deno.v0.json agent:provider-stream-compatibility:test
deno task --quiet --config deno.v0.json v0:check
deno task --quiet --config deno.v0.json v0:fmt
deno task --quiet --config deno.v0.json v0:lint
deno task --quiet --config deno.v0.json v0:test
deno task --quiet --config deno.v0.json v0:gate
```

`v0:gate` runs the current configured check, format, lint, and offline test tasks. The task list in
`deno.v0.json` is the authority for current ownership and scope; earlier exact-once leaf and
detached-fixture descriptions remain historical evidence. Production TUI/run, credential launchers,
provider network, dependency/lockfile changes, and `_refs/` are outside this gate. Earlier plans and
archives remain historical evidence; [`archive/`](archive/) is not active source and
[`_refs/`](_refs/) is not a dependency.
