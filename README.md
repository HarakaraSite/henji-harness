# Henji Harness

Henji Harness is a small trusted-local Deno agent harness. The active pre-alpha implementation is
the `v0` tree; older implementations and stopped experiments are retained under `archive/` only as
historical evidence.

## Current implementation

- Product source: [`v0/`](v0/)
- Tests: [`tests/v0/`](tests/v0/)
- Task configuration: [`deno.v0.json`](deno.v0.json)
- Current plans and results: [`docs/plans/`](docs/plans/)
- Resume state: [`.handoff/handoff.md`](.handoff/handoff.md)

Use the exact Deno 2.9.4 binary embedded in `deno.v0.json`. The main local commands are:

```text
deno task --config deno.v0.json agent:fixture
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --quiet --config deno.v0.json agent:run --task 'ARBITRARY TASK'
printf '%s\n' 'ARBITRARY TASK' | /home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --quiet --config deno.v0.json agent:run
deno task --config deno.v0.json agent:test
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --config deno.v0.json agent:runtime:test
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --config deno.v0.json agent:planner-delegation:test
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --config deno.v0.json agent:work-tools:test
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --config deno.v0.json agent:skills:test
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --config deno.v0.json agent:runtime:process:test
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --config deno.v0.json agent:session-store:test
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --config deno.v0.json agent:session:process:test
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --config deno.v0.json agent:session:tui:test
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --config deno.v0.json agent:sessions:test
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --config deno.v0.json agent:sessions:topology:test
deno task --config deno.v0.json agent:transport:test
deno task --config deno.v0.json agent:acceptance:test
deno task --config deno.v0.json agent:selection:test
deno task --config deno.v0.json v0:check
deno task --config deno.v0.json v0:fmt
deno task --config deno.v0.json v0:lint
deno task --config deno.v0.json v0:test
deno task --config deno.v0.json v0:gate
```

`agent:acceptance` is the production provider task. Run it only on explicit user instruction; it is
not a local test. Local gates use fixtures and require no credential.

## Normal runtime (roadmap step 11)

The agent:run task accepts exactly one nonblank task, from --task TEXT or from non-TTY stdin. The
normal `agent:run` and `agent:tui` paths share one internal startup composition boundary. At startup
it resolves exactly one of two compile-time built-in Agent Definitions: `default` (the omitted
selection) or `planner`. The selected Definition declares the fixed provider profile, discovered
instructions and skills, model capability registry, and eight-request bound. `agent:run` accepts
`--agent NAME` before or after `--task TEXT`, and `agent:tui` accepts `--agent NAME`; selection is
resolved once at startup and cannot change between turns. Unknown, malformed, duplicate, or missing
selector values fail before stdin/workspace/session setup. The `default` Definition preserves the
production registry and advertises exactly six tools without a callable skill (`bash`,
`delegate_to_planner`, `edit`, `read`, `submit_json_result`, and `write`) and seven when `skill` is
available. The `planner` Definition instead advertises exactly `read` and `submit_json_result`,
adding `skill` only when available; it never advertises `bash`, `edit`, or `write`, and its fixed
policy asks for a clear non-mutating implementation plan. This is not an OS/process sandbox:
trusted-local process permissions and the production workspace tools remain unchanged. The selector
is not configuration, environment, alias, or dynamic loading. `delegate_to_planner({task})` is a
synchronous, nonterminal default-only call: one accepted parent turn may admit at most one built-in
planner child. Parent, child, and aggregate model-request limits are fixed at 8, 8, and 16
respectively, with admission checked before model, credential, or fetch work. The child receives
only the explicit task and startup workspace/instruction/skill snapshots, exposes only planner
read/skill/JSON tools, and returns one bounded sanitized result; child events and transcript are not
exposed to the parent. The planner Definition itself cannot delegate. This capability shares the
trusted-local process and workspace user permissions and is not an OS sandbox; background execution,
recursion, persistence, streaming, retries, and multiple children remain deferred.
Supplying both sources, an unknown or positional argument, invalid UTF-8, or input over 65,536 UTF-8
bytes fails before model or credential setup. The versioned corpus/evaluation registry retains the
four toy domain tools separately and they are not advertised by normal `agent:run`. JSON answers
must use `submit_json_result` as the sole tool call in a batch; the host canonicalizes the complete
JSON value and prints it on stdout. Plain-text answers retain the assistant final path.

Each normal model request is derived from the full in-memory transcript through a provider-neutral
context view. The view estimates stable JSON as UTF-8 bytes, triggers at 65,536 estimated message
bytes, and replaces only beneficial older tool-result text with the fixed marker
`[older tool result omitted for context]` until 49,152 estimated message bytes or eligible results
are exhausted. User/assistant text, tool-call arguments and metadata, the newest tool message,
events, outcomes, and committed session history remain complete. This is a conservative local
estimate rather than provider usage or tokenizer output; no summary, retry, extra request,
persistence, or provider window lookup is performed. The TUI reports a committed post-settlement
estimate as `ready · ctx ≤<ceil(bytes / 1024)>K/64K est`, adding the exact omitted-result count when
nonzero. `agent:run` output and non-normal provider wire contracts remain unchanged.

Normal runtime parent and planner model requests use one bounded Chat Completions SSE response per
admitted model step. The CLI remains final-only: streamed partial text is never written to stdout or
stderr, committed history, context metrics, or planner envelopes. The TUI receives only accumulated
assistant snapshots, rendered as one replaceable escaped live line and cleared when a completed
assistant record, tool activity, cancellation, failure, or shutdown takes over. A completed result
alone can create assistant events, execute tools, and update the transcript. Streamed tool-call
fragments are assembled and validated before dispatch; partial calls are never executed. Malformed,
cancelled, timed-out, or failed streams retain no partial assistant result. Provider-side connection
abort does not guarantee cancellation of provider compute or billing. Reasoning/usage display,
retry/fallback, reconnection, steering, and queued follow-up remain deferred.

`read`, `write`, and `edit` use the canonical invocation working directory as a fixed workspace.
Paths may be relative or absolute within that root, are component-checked, reject symlinks and
special files, and accept only well-formed UTF-8 text up to 65,536 bytes. Writes and edits use a
synced sibling temporary file and atomic rename; this gives atomic visibility but does not promise
directory-fsync crash durability or protection from hostile same-user races. `edit` applies up to 32
exact, unique, non-overlapping replacements against one original snapshot.

`bash` always runs `/bin/bash --noprofile --norc -c COMMAND` from the workspace with a clean fixed
environment (`PATH`, `LANG`, and `LC_ALL` only), separate 4,096-byte stdout/stderr capture, and a
30,000 ms default / 120,000 ms maximum timeout. The invocation itself authorizes local work; there
is no per-tool prompt or additional CLI flag. Bash is trusted-local OS-user execution, not a
workspace sandbox: it can access outside files, network, and descendants, and timeout cleanup
guarantees only the direct child is killed and reaped.

During a TUI tool call, `bash` may emit provider-neutral progress as accumulated stdout/stderr
snapshots. Each stream is observed up to 4,000 UTF-8 bytes and each call delivers at most 64
snapshots; progress is live-only, replaceable TUI state and is neither sent to the model nor stored
in session history. Strict live decoding can disable one malformed or incomplete stream while the
final bounded 4,096-byte capture remains authoritative. If event output fails, the active tool is
cancelled and settled before the sanitized failure is surfaced. These observations do not change
the existing trusted-local Bash permissions or direct-child-only descendant limitation.

Before the first normal-runtime model request, the host optionally reads one standing-instruction
file directly under the canonical workspace: `AGENTS.md` is preferred over `AGENTS.MD`, and the
first present candidate wins. Only regular non-symlink files with valid UTF-8 text up to 16 KiB are
accepted; blank, NUL-containing, malformed, oversized, or unreadable files are silently skipped. The
accepted text is sent as one first-class `system` message on every provider request, outside the
user task and loop transcript. Discovery does not inspect ancestors, global/home state, child
directories, or other spelling variants, and does not broaden the existing `agent:run` workspace
read permission.

The same startup pass discovers project-local skills from `./.zot/skills`, then `./.claude/skills`,
then `./.agents/skills`. Only one-level `<location>/<directory>/SKILL.md` regular non-symlink files
are considered. Entries are sorted; the first valid effective name wins, while a valid
`disable-model-invocation: true` entry reserves its name without becoming callable. Discovery is
bounded to 128 entries per location, 24 callable skills, 64 KiB per file and formatted result, 512
KiB aggregate results, and an 8 KiB manifest.

The accepted format is a strict frontmatter subset with optional `name`, required one-line
`description` (160 UTF-8 bytes maximum), and optional `disable-model-invocation`. Unknown or
duplicate keys—including unenforced `allowed-tools`, `allowed_tools`, and `permissions`—make the
candidate invalid. A compact name/description/workspace-relative-source manifest is appended to the
system instruction; bodies are held in an immutable startup snapshot and enter the transcript only
after the model calls nonterminal `skill({name})`. Tool execution never rereads the file. Global or
home skills, recursive discovery, manual slash invocation, reload, and permission enforcement are
not provided.

## First terminal UI

The explicit TUI command is real-TTY-only and accepts `--agent NAME` plus at most one persistence
selector (`--continue`, `--session UUID`, or `--no-session`), in either order:

```text
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --quiet --config deno.v0.json agent:tui
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --quiet --config deno.v0.json agent:tui --agent planner --no-session
```

The omitted selector uses `default`; `--agent planner` selects the built-in planner capability. It
uses the same fixed trusted-local workspace, skills, model profile, and trusted-local process
permission envelope as `agent:run`; the selected Definition controls model tools. `default` includes
OS-user `bash` execution with no per-tool confirmation, while `planner` exposes only `read`,
optional `skill`, and `submit_json_result`. Each Enter starts one exact task in an in-memory
sequential conversation (at most eight provider requests per turn); input received while a turn is
busy is consumed and discarded. The command never implicitly changes `agent:run` into a TUI and does
not read credentials until a submitted task reaches the lazy provider adapter.

The editor supports printable UTF-8, Backspace, Enter, and bracketed paste. Empty Enter only updates
status. While idle, the first Ctrl-C clears the editor and arms a 500 ms second-press exit; a second
Ctrl-C exits. Ctrl-D exits only with an empty editor. While busy, Escape requests cooperative
cancellation and returns the same session to ready after model/tool cleanup; Ctrl-C and SIGINT
request cancellation and exit 0 after settlement, while SIGTERM/SIGHUP settle and exit 143/129.
Cancellation is per accepted turn, never commits its draft, and does not roll back completed local
effects. Cleanup failure is a fatal sanitized agent failure and makes the session unavailable.
Terminal output uses main-screen scrollback with a small live line; dynamic model, tool, and task
text is escaped at one terminal boundary. Raw mode, bracketed paste, cursor state, and the input
reader are restored on every handled exit or failure. Provider streaming is visible only as the
bounded live assistant line described above; confirmation, alternate-screen rendering, and queued
follow-up input remain deferred.

## Persistent TUI sessions

The production TUI launcher autosaves each successful turn in a new session by default. Use
`--continue` to resume the newest session for the selected built-in agent, `--session UUID` for an
exact session, or `--no-session` for an ephemeral run. The flags may appear in either order with
`--agent default|planner`; malformed, duplicated, conflicting, or positional arguments fail before
workspace, state, terminal, provider, or credential setup.

Session management is metadata-only and does not materialize a provider or runtime:

```text
deno task --config deno.v0.json agent:sessions list
deno task --config deno.v0.json agent:sessions delete --session UUID --yes
```

State is repo-external under `$XDG_STATE_HOME/henji-harness`, or
`$HOME/.local/state/henji-harness` when XDG state is unset. A workspace SHA-256 partition keeps
sessions from different workspaces separate. Session files are canonical version-1 UTF-8 JSON and
contain only the selected agent, identity/timestamps, next turn, and the complete successful parent
transcript; current AGENTS.md and skills are rediscovered on resume. Planner child turns, model
views, markers, metrics, events, credentials, and terminal display history are never persisted.

The store accepts at most 256 valid or active sessions per workspace, scans at most 512 direct
entries in each namespace, and refuses a session file over 8 MiB. It uses nonblocking index/session
locks and a synced sibling temporary file followed by atomic rename. There is no directory-fsync,
repair, migration, truncation, pruning, or automatic deletion guarantee. Corrupt or unsupported
records remain untouched and are rejected or counted as skipped by the management list operation.
The ephemeral `--no-session` mode performs no state-root access, and `agent:run` remains entirely
nonpersistent.

Local TUI tests use only fake sessions/terminals and bounded `/usr/bin/script` PTY fixtures; they do
not run `agent:tui`, `agent:run`, a provider, or credential commands.

Success writes only the final assistant text to stdout (adding one newline when needed), with an
empty stderr. Failure writes one compact sanitized JSON record to stderr, with empty stdout. The
fixed profile may make up to eight provider requests and performs no application retry. agent:run is
therefore a production provider command: do not invoke it without explicit user instruction and do
not provide credentials to local tests or gates.

## Fixed local work-tools sentinel

The Gate L sentinel is a fixed five-call acceptance child using the production model, loop, and
work-tool registry: `write`, `read`, `edit`, `bash`, then the sole terminal `submit_json_result`
call. It runs only in the dedicated dummy/fake-provider local tasks:

```text
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --config deno.v0.json agent:work-tools:sentinel:test
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --config deno.v0.json agent:work-tools:sentinel:process:test
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --config deno.v0.json agent:work-tools:sentinel:topology:test
```

The production-only `agent:work-tools:sentinel:credential-file` task is excluded from every local
gate. It reads the repo-external credential once, creates one mode-0700 disposable workspace, and
removes it after the bounded child run. Gate L never reads credential metadata or content, opens a
provider connection, or runs this production task; Gate S requires a separate explicit approval.

## Fixed planner-delegation sentinel

The planner-delegation sentinel composes the normal default runtime and proves one synchronous
`delegate_to_planner` child between two parent requests. Its fixed local tests use only dummy
credentials and a guarded fake provider:

```text
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --config deno.v0.json agent:planner-delegation:sentinel:test
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --config deno.v0.json agent:planner-delegation:sentinel:process:test
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --config deno.v0.json agent:planner-delegation:sentinel:topology:test
```

The production-only `agent:planner-delegation:sentinel:credential-file` task is excluded from every
local gate. It reads the repo-external credential once, creates one mode-0700 empty workspace, and
removes it after the bounded child run. Gate L does not access credentials or provider/network; Gate
S requires a separate explicit approval.

## Current baseline

Roadmap steps 8–10 are complete. Step 8 added deterministic `character_count` beside
`uppercase_text` and enforces selection of the task-matching tool. Before the cleanup, selection
direct tests passed 8 cases, the full v0 suite passed 72 tests, and check, format, lint, gate, and
diff check passed. The post-implementation review found no Blocker or P1 and one P2 for a missing
negative test. The later local-fix added a well-typed but incorrect fixed `text` value to the
negative table; direct selection and full offline gates pass with the regression covered.

Roadmap step 9 adds `list_json_object_keys` and completed one real task against `deno.v0.json`: the
model selected the tool once and returned the 12 task names. The first result differed from the
compact tool JSON only by whitespace, so completion now compares the parsed string arrays. No retry
or second provider attempt was made; the current full local suite passes 78 tests.

Roadmap step 10 combines `list_json_object_keys` with `count_json_array_items`. A real model used
the two tools in order over three requests and returned `{"count":12}`. The first attempt stopped
after the list because character counting was not a natural continuation; the task was corrected to
count JSON-array items, then completed without further changes.

The active step 5–10 evidence is retained in `docs/plans/`. Roadmap step 11's normal CLI runtime is
specified in
[`docs/plans/zot-first-cli-agent-runtime.md`](docs/plans/zot-first-cli-agent-runtime.md), with the
Zot-first local work-tool increment recorded in
[`docs/plans/zot-local-work-tools-results.md`](docs/plans/zot-local-work-tools-results.md). It
accepts one task from argv or stdin, allows at most eight model requests, and performs no
application retry. The provider-neutral in-memory session and completed lifecycle events are
implemented for the next TUI prerequisite; `agent:run` still uses the unchanged one-shot wrapper.
Persistence/history, global/manual skill management, extensions, RPC, subagents, self-revision,
and dynamic provider/model selection remain later roadmap work. See the
[`multi-turn/events results`](docs/plans/zot-provider-neutral-multi-turn-events-results.md) for the
local evidence and verification boundary.

## Versioned small task corpus

The current offline corpus is [`v0/corpus/task-corpus.v1.json`](v0/corpus/task-corpus.v1.json),
schema version 1 and corpus ID `henji-normal-cli-small-v1`. It contains exactly 24 canonical cases:
four final-only cases, four cases for each of the four single-tool categories, and four multi-tool
cases. The strict loader and case-local scorer are in
[`v0/corpus/task_corpus.ts`](v0/corpus/task_corpus.ts).

Run its focused validation with:

```text
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --config deno.v0.json agent:corpus:test
```

The corpus validates only the literal `deno.v0.json` `fmt` and `lint` fixtures. This increment is
offline data validation and mechanical scoring only; it does not include an evaluation runner,
provider/model invocation, production command, score aggregation, or credential access.

## Archive

[`archive/`](archive/) is not active product source and is excluded from normal v0 commands:

- `archive/legacy-two-plugin/`: stopped source-direct two-plugin implementation and tests.
- `archive/safety-spikes/`: Spike 0–2 source, tests, configs, scripts, and evidence.
- `archive/history/`: superseded pre-alpha plans and results.

The archived implementations, spikes, and superseded plans are historical evidence that can be
reconsidered intentionally as future decisions are made. See
[`archive/README.md`](archive/README.md) for the retention boundary.

## Reference snapshots

[`_refs/`](_refs/) contains upstream snapshots used for comparison. It is reference material, not
product source or a dependency. A useful refresh records the upstream URL, pinned commit, license,
and comparison of adopted behavior in [`_refs/README.md`](_refs/README.md).
