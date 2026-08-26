# Zot-first provider-neutral multi-turn and completed-events plan

## Decision summary

Concept **GO, initial Human Gate pending**.

The next normal CLI roadmap increment is an internal prerequisite for the first TUI: one
provider-neutral, in-memory multi-turn session and a synchronous completed-lifecycle event contract.
It does not add a TUI or a new production command. The existing one-shot `agent:run` remains the
public runtime and compatibility baseline.

Provider token streaming is not required for this increment or for a correct first TUI. A later TUI
can render completed assistant messages and completed tool activity first, then add token deltas as
an independent enhancement. Persistent sessions are also deferred; conversation state exists only
for the lifetime of one session object.

Planning base revision: `eb351cc6484a93dd0439452721b15038095d5064`, plus the completed uncommitted
project-local skills increment whose canonical plan SHA-256 is
`9a514adce8932e54daca44f54bf401f647c29a77e64b660c4ab955b94343869c`.

## Why this precedes the TUI

The current `runAgent` owns a new transcript for exactly one user task. There is no reusable
conversation object and no event boundary through which a UI can observe a turn. Building the UI
now would make it own provider-loop state, transcript commit rules, tool lifecycle, and request
limits. Those are agent-core responsibilities and must remain usable without a terminal.

The smallest later result deserving the name “first TUI” is a real-TTY interface that accepts
multiple user turns in one in-memory conversation, shows completed assistant and tool activity,
shows busy/idle state, and restores the terminal on every exit path. Wrapping one one-shot answer in
ANSI output is not that milestone.

## Current verified state

- `runAgent` creates one transcript, runs at most eight model requests, and returns a complete
  immutable-looking `LoopOutcome`.
- The OpenRouter adapter sends `stream: false` and returns only a completed final or completed batch
  of tool calls.
- The normal runtime constructs one fixed model, registry, workspace instruction, and skill catalog
  per one-shot invocation.
- The Registry is immutable after construction; definitions are stable name-sorted snapshots.
- Normal `agent:run` rejects TTY input, accepts one task from `--task` or non-TTY stdin, performs no
  application retry, and has a strict stdout/stderr contract.
- Project-local skill implementation and its full 213-test gate are complete but uncommitted. This
  plan must preserve those changes.

## Zot reference and adoption decisions

The first reference is MIT-licensed Zot commit
`9b7bb6a4f36bc8c8deb2cc5796a8f557f4fb7479`.

| Pinned Zot evidence | Henji decision |
| --- | --- |
| `_refs/zot/packages/core/events.go`: turn, user, assistant, tool, result, and done events are distinct from token deltas | Adopt a smaller completed-event subset |
| `_refs/zot/packages/agent/modes/stream.go`: completed assistant fallback works when no text delta is emitted | Use completed responses; defer provider streaming |
| `_refs/zot/packages/agent/cli.go`: agent owns conversation execution and interactive mode subscribes to it | Adopt the ownership boundary |
| `_refs/zot/packages/agent/modes/interactive.go`: multi-turn input, event handling, and TUI state are separate concerns | Use as the later TUI boundary, not as code to copy now |
| `_refs/zot/packages/tui/terminal.go`: terminal I/O and raw-mode restore are abstracted for tests | Adopt in the later TUI plan |
| `_refs/zot/packages/tui/input.go` and `render.go`: rich input and rendering handle many terminal cases | Defer to the TUI slice; do not import the full design |

Implementation will be independent TypeScript. `_refs/` will not be imported, executed, changed,
refreshed, or treated as a dependency.

## Scope

In scope:

- a provider-neutral primitive that runs one user turn against a supplied committed transcript;
- one in-memory session that owns the committed transcript and serializes `submit` calls;
- completed lifecycle events for turn, user, assistant, tool-call, tool-result, and turn end;
- successful-turn commit and failed-turn rollback semantics;
- preservation of `runAgent` as the existing one-shot compatibility API;
- direct deterministic tests, topology tests, current regression suites, full offline verification,
  acceptance evidence, and bounded review.

Out of scope:

- TUI, ANSI rendering, raw input, PTY execution, or a new production invocation;
- provider token streaming or a `text_delta` event;
- persistent/resumable sessions, transcript import/hydration/export, or migration;
- context compaction, truncation, or context-window policy;
- cancellation, signals, concurrent turn queueing, or background work;
- slash commands, tool confirmation changes, model/provider selection, themes, Markdown, extensions,
  RPC, or subagents;
- changes to AGENTS/skill discovery, work tools, corpus/eval semantics, provider profile, retry, or
  permissions;
- dependencies/lockfiles, credentials, provider/network execution, production commands, `_refs/`,
  archive, siblings, commit, push, tag, publish, or release.

## Exact conversation contract

### One-turn primitive

Extract the existing loop into a provider-neutral one-turn primitive that accepts:

- one nonblank user text;
- a read-only snapshot of previously committed messages;
- one model and Registry;
- fixed `maxSteps` and optional system instruction;
- an optional synchronous event sink.

It creates a private draft transcript by copying the committed messages, appends the new user
message, and performs the existing loop without changing model request encoding, tool dispatch,
terminal-tool rules, error text, counters, or stop reasons. `maxSteps` applies to this user turn and
resets for the next submitted turn.

The primitive returns the existing `LoopOutcome` shape with the full draft transcript. It never
mutates the caller's prior-message array. No public API accepts a mutable transcript reference.

`runAgent(task, model, registry, options)` remains a wrapper that calls this primitive with an empty
committed transcript. Existing callers and one-shot outcomes must not change.

### In-memory session

Add an `AgentSession` (final name may follow existing naming conventions) constructed once with:

- one model;
- one Registry;
- one fixed positive `maxSteps`, defaulting to the existing value;
- one fixed optional system instruction;
- one optional synchronous event sink.

The session owns a private committed transcript, initially empty. `submit(userText)`:

1. rejects blank input before emitting an event or calling the model;
2. rejects immediately if another submit is active; it does not queue;
3. runs exactly one turn from a snapshot of the last committed transcript;
4. commits the returned full transcript only for `final` or `tool_terminal` success;
5. rolls back the whole draft transcript for `contract_failure`, `max_steps`, event-delivery failure,
   or an unexpected thrown failure;
6. clears its busy flag in `finally` and may then accept another submit.

Rollback cannot undo filesystem or Bash side effects from tools already executed during the failed
turn. It only prevents partial conversation messages from becoming future model context. This is a
trusted-local execution limitation and must be documented and tested.

A read-only transcript snapshot accessor may return a deep-enough defensive copy of messages,
content arrays, tool-call arguments, and result content. External mutation of any returned value
must not change later model requests. No transcript replacement, import, or hydration API is added.

`submit_json_result` terminates only the current turn. Its successful assistant tool-call and tool
result messages are committed, and the session accepts the next user turn.

## Exact completed-event contract

Add a discriminated provider-neutral union with at least:

```text
turn_start       { turn: positive integer }
user_message     { turn, message }
assistant_message{ turn, message }
tool_call        { turn, call }
tool_result      { turn, result }
turn_end         { turn, outcome, committed }
```

- Turn numbers begin at 1 and increase once for every submit that passes input/concurrency
  preflight, including failed turns. Rejected blank or concurrent submits consume no turn number.
- `turn_start` is first, then one `user_message`.
- Every completed model result emits one `assistant_message`. A tool-call assistant message is
  emitted before its individual `tool_call` events.
- Each `tool_call` is emitted immediately before dispatch. Its matching `tool_result` is emitted
  immediately after dispatch and before the next call or model request.
- Exactly one `turn_end` is emitted for ordinary final, tool-terminal, max-steps, and model-contract
  outcomes. It is last and reports whether the draft was committed.
- Events contain defensive snapshots. Sink mutation cannot affect dispatch or transcript state.
- There is no token delta, usage, progress, retry, provider-specific, renderer, or persistence event.

The sink is synchronous and returns `void`. If it throws:

- the session stops before the next model request or tool dispatch;
- no further event is delivered to that failing sink;
- the current turn is not committed and `submit` rejects with one stable event-delivery error;
- already completed model requests and tool side effects are not rolled back;
- if failure occurs on `tool_call`, that tool is not dispatched; if it occurs on `tool_result`, that
  tool has completed but no later call is dispatched.

The core one-turn primitive must implement the stop-before-next-effect property rather than having
the session infer it after completion.

## Compatibility requirements

- `agent:run` argv/stdin rules, TTY rejection, output, sanitized failure JSON, exit codes, request
  counting, fixed profile, no retry, and permission topology remain byte-for-byte compatible.
- One-shot `runAgent` request transcripts and `LoopOutcome` values remain compatible for final,
  tool, terminal-tool, invalid result, provider throw, and max-step cases.
- The normal runtime continues to construct its model/registry/instructions/skills once per one-shot
  call. It does not instantiate the new session yet.
- Corpus/eval and all production/sentinel commands are unchanged and not executed by this increment.

## File ownership

Planned product/test changes:

- new `v0/agent/events.ts`: event union, snapshot helpers, stable delivery error;
- new `v0/agent/session.ts`: fixed-context sequential in-memory session;
- `v0/agent/loop.ts`: extract prior-transcript one-turn primitive and preserve `runAgent` wrapper;
- `v0/agent/contracts.ts`: only the minimum public types needed by the primitive/session;
- new `tests/v0/agent_session_test.ts`: conversation, commit, event, isolation, and concurrency tests;
- optional new `tests/v0/agent_session_topology_test.ts` only if the same assertion cannot fit the
  focused test cleanly;
- `deno.v0.json`: focused local task plus check/gate inclusion only;
- `README.md`, `AGENTS.md`, `.handoff/handoff.md`, and new results document after implementation.

Do not functionally change `runtime.ts`, `runtime_cli.ts`, `openrouter_model.ts`, registries, tools,
skills, corpus/eval, process fixtures, dependencies, lockfiles, archive, or `_refs/`. A mechanical
type/import adjustment in an existing test is allowed only when required by the extracted API and
must not change its assertions.

## Ordered implementation and verification

1. Add exact event types, defensive snapshot behavior, and delivery error.
2. Extract one-turn execution from `runAgent`, including stop-before-next-effect event delivery.
3. Restore `runAgent` as an empty-transcript compatibility wrapper and run its focused suite.
4. Add the private-transcript, nonqueueing session with successful commit and failed rollback.
5. Add permission-free deterministic session/event tests and topology assertion.
6. Add the focused task to repository check/gate configuration.
7. Run focused agent/session, runtime, process, transport, skills, corpus/eval regressions and the
   repository-defined check/fmt/lint/full offline gate.
8. Write requirement-to-evidence results and update lifecycle documents.
9. Run one read-only review, at most 30 minutes and stopping after 10 minutes without new evidence.
   If fixes are needed, perform one changed-lines/finding-closure re-review, at most 15 minutes.

No provider, credential, production runtime, sentinel, or real-TTY test is part of this increment.

## Required deterministic tests

- Two successful user turns: the second request contains the first complete user/assistant turn and
  the second user message in exact order.
- A successful tool turn commits assistant tool calls and correlated results into the next turn.
- Successful `submit_json_result` ends only its turn and permits the next submit.
- Eight-request ceiling resets per turn; neither turn starts a ninth request.
- System instruction and sorted tool definitions remain identical across requests and turns.
- Exact event order/count/payload isolation for plain final, continuing tool, terminal tool, model
  failure, invalid result, and max steps.
- Nonstreaming models are fully observable through completed events; no delta is expected.
- Sink failure at every event position stops before the next model call/tool dispatch; tool-call
  failure executes zero calls, tool-result failure executes only the already completed call.
- Concurrent submit rejects without a model call, event, turn-number change, or transcript change.
- A failed turn rolls back its draft; the next successful turn starts from the last successful
  transcript. Already executed tool side effects are explicitly not claimed to roll back.
- Transcript/event snapshots cannot be mutated to change later model input or dispatch arguments.
- Existing `runAgent` request/outcome table and normal runtime/process output remain unchanged.
- Focused/gate commands do not invoke provider/credential/production/sentinel tasks.

## Stop conditions

Stop and return with cause, evidence, impact, proposed plan delta, and verification method if:

- the compatibility wrapper cannot preserve existing request/outcome behavior;
- safe event delivery requires provider streaming, async queueing, cancellation, or a public API
  change outside this plan;
- session construction requires a provider/profile, permission, dependency, credential, network,
  or production-command change;
- completed skills work conflicts with the planned ownership;
- an existing normal CLI safety or output contract must change;
- tool confirmation, persistent state, or TUI behavior must be decided to complete this increment.

## Later first-TUI decisions and acceptance boundary

After this prerequisite is complete, a separate TUI plan must obtain a Human Gate for:

1. invocation — recommended: explicit `agent:tui`, not implicit TTY switching in `agent:run`;
2. tool authorization — preserve invocation-level authorization or add interactive per-call
   confirmation;
3. busy interruption — define Ctrl-C/Esc as input clearing, turn cancellation, or process exit.

The later first TUI should require a real TTY, use the in-memory session, render completed assistant
and tool activity plus busy state, handle printable UTF-8/Enter/Backspace/exit/bracketed paste, and
restore raw mode, cursor, SGR, paste mode, and scroll region on every exit path. Its tests should use
a fake terminal plus a local PTY process test. Streaming, persistence, compaction, rich Markdown,
themes, slash commands, dynamic model/provider selection, and extensions remain separable later
increments.

## Human Gate

Approval of this plan authorizes only the provider-neutral one-turn extraction, completed events,
in-memory sequential session, successful-turn commit, failed-turn transcript rollback, local tests,
full offline verification, evidence, and bounded review described above.

It does not authorize TUI implementation, a new production command, real TTY/provider/network
execution, credential access, tool-confirmation changes, cancellation, persistence, dependency or
lockfile changes, `_refs/` changes, commit, push, tag, publish, or release.
