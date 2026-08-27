# Provider-neutral context management implementation and verification plan

## Decision summary

Concept **GO, initial Human Gate pending**.

This increment adds a deterministic provider-neutral request-context view. The session continues to
own the full in-memory transcript, while each model request receives a freshly derived defensive
view. When the estimated serialized message context reaches a fixed local threshold, older tool
result text is replaced oldest-first by one fixed marker. No user or assistant text, tool-call
arguments, causal metadata, committed history, or outcome evidence is removed.

This is deliberately the small first context-management step previously selected by the user:

- token/context estimation is a conservative local UTF-8-byte heuristic, not tokenizer accuracy;
- only older tool-result text is eligible for automatic omission;
- there is no model-generated summary, summary prompt, extra request, provider retry, persistence,
  provider usage dependency, or provider context-window lookup;
- normal `agent:run` channels and below-threshold ModelRequest structure remain unchanged;
- TUI shows a bounded post-settlement estimate for the current committed session without adding a
  progress or streaming event.

Planning baseline is commit `7c3888f` (`feat(v0): add provider-neutral cancellation`). The full v0
gate passes 377 tests with final Blocker/P1/P2 zero. The only worktree entries are existing
user-owned untracked `_refs/` snapshots.

## Authority and prerequisites

User-approved roadmap order:

1. provider-neutral cancellation — complete;
2. context management — this increment;
3. persistent session/history;
4. tool progress events;
5. provider streaming;
6. bounded mid-turn steering;
7. optional next-turn queue.

The user also decided not to introduce `@std/cli`, Cliffy, or another CLI/TUI library at this stage.

Canonical prerequisites:

- `docs/plans/zot-provider-neutral-multi-turn-events.md`, SHA-256
  `663a1bd6634e1503978d0af3f24aecc899dd3b3acd64819fbfcd416cd71bdf0e`;
- `docs/plans/bounded-planner-delegation-tool.md`, SHA-256
  `5f8da680dabc7223d6320c5129c0350ed64fe7b0f7d613a4a44a7a9f5d26570d`;
- `docs/plans/zot-first-tui.md`, SHA-256
  `60ba3fef3b261c754a1b060fa76d2b62086fb4433e179bb285eee97c146f1fd8`;
- `docs/plans/provider-neutral-cancellation.md`, SHA-256
  `2e7de535ce3979f79b0d46515e076a67e9e76da6654c2cd0788e688e755bdfab`.

## Pinned reference decisions

Pi reference is MIT-licensed commit
`a69bef789bc95abf0acee16f7b4660b70b650bb9`.

- `_refs/pi/packages/agent/src/types.ts` and `agent-loop.ts`: adopt the separation between retained
  transcript and a transform applied immediately before provider execution.
- `_refs/pi/packages/agent/src/harness/compaction/compaction.ts`: adopt a clearly labelled estimate
  and a pure context-preparation boundary.
- Do not adopt provider-usage accounting, provider model metadata, summary generation, compaction
  records, persistence, retry, or branch navigation.

Zot reference is MIT-licensed commit
`9b7bb6a4f36bc8c8deb2cc5796a8f557f4fb7479`.

- `_refs/zot/packages/core/compact.go` is comparison evidence that a context estimate and retained
  transcript policy belong above provider transport.
- Do not adopt its model-generated transcript summary or persistent compaction metadata.

Pi/Zot code is not imported or copied. `_refs/` remains unchanged reference evidence and is not a
runtime dependency.

## Confirmed current boundary

- `AgentSession` owns one full committed `Message[]`, with successful commit and failure/cancel
  rollback. `transcriptSnapshot()` returns that full defensive history.
- `runAgentTurn` builds every ModelRequest directly from the full current draft. Parent and planner
  child both use this loop, with separate transcripts and request-budget lanes.
- Message roles are user, assistant, and tool. A ToolMessage contains one complete result batch;
  each result retains call ID, name, text, outcome, and optional terminal JSON metadata.
- OpenRouter currently rejects serialized wire messages above 76 KiB and full request bodies above
  256 KiB before fetch. Repository profile documentation already treats 76 KiB as a conservative
  77,824-input-token upper bound.
- Runtime limits remain parent 8 / child 8 / aggregate 16 requests, one planner child per accepted
  parent turn, no retry/fallback, and maximum eight steps per loop.
- Cancellation is a per-turn owner. Once it wins, context preparation must not be followed by a
  request claim, credential read, fetch, child admission, or tool effect.
- Events are synchronous completed lifecycle events. TUI reads outcomes after settlement; provider
  streaming and tool-progress events do not exist yet.

## Scope

In scope:

- one pure synchronous estimator/request-view module;
- exact fixed thresholds, marker, candidate ordering, and metadata preservation;
- loop integration shared by parent and planner child;
- full transcript/outcome/session preservation and cancellation checks;
- a read-only committed-session context snapshot and TUI ready-status indication;
- permission-free unit, integration, process, TUI, topology, and compatibility evidence;
- README/results/lifecycle updates, full offline verification, and bounded review.

Out of scope:

- automatic or manual model-generated summaries, summary prompts, extra model requests, retries,
  fallback, provider tokenizers, provider usage fields, model catalogs, or actual context-window
  claims;
- persistent session/history, resume/list/clear, schema/migration, or on-disk compaction records;
- streaming, tool-progress events, steering, queues, slash commands, or new CLI arguments;
- deletion or summarization of user/assistant text, tool-call arguments, call IDs, tool names,
  outcome/terminal metadata, complete messages, turns, or causal pairs;
- provider/profile/wire changes, permission expansion, dependencies, or lockfiles;
- credential/provider/network/production commands, `_refs/` changes, archive/sibling changes,
  commit, push, tag, publish, or release.

## Pure context preparation contract

Add `v0/agent/context.ts` with exact exported constants and pure contracts. Final local names may
follow repository style, but behavior is fixed:

```ts
const CONTEXT_TRIGGER_ESTIMATED_TOKENS = 65_536;
const CONTEXT_TARGET_ESTIMATED_TOKENS = 49_152;
const OMITTED_TOOL_RESULT_TEXT = '[older tool result omitted for context]';

interface ContextMetrics {
  readonly messageEstimatedTokensBefore: number;
  readonly messageEstimatedTokensAfter: number;
  readonly toolEstimatedTokens: number;
  readonly requestEstimatedTokensBefore: number;
  readonly requestEstimatedTokensAfter: number;
  readonly triggerTokens: 65_536;
  readonly targetTokens: 49_152;
  readonly triggered: boolean;
  readonly targetReached: boolean;
  readonly compressedResultCount: number;
  readonly compressedMessageCount: number;
}

interface PreparedModelContext {
  readonly request: ModelRequest;
  readonly metrics: ContextMetrics;
}

prepareModelContext(request: ModelRequest): PreparedModelContext;
```

`prepareModelContext` validates no provider profile and performs no I/O, model call, credential
access, event delivery, request claim, mutation, or asynchronous work.

### Estimate definition

The word “token” in this module means a deliberately conservative local estimate only:

```text
estimatedTokens = UTF-8 bytes of stable JSON
```

One UTF-8 byte is counted as one estimated token. This aligns with the repository's existing
worst-case safety rationale and avoids claiming provider-tokenizer accuracy. It is expected to
overestimate common text. It is not the model's reported usage or actual context-window capacity.

Build estimates with fixed property order:

- message estimate: UTF-8 bytes of JSON for
  `{systemInstruction, transcript}` when system instruction is present, otherwise `{transcript}`;
- tool estimate: UTF-8 bytes of JSON for the tools array;
- total estimate: UTF-8 bytes of JSON for the complete provider-neutral
  `{systemInstruction?, transcript, tools}` request.

All values are non-negative safe integers. JSON escaping, multibyte text, nested tool arguments,
keys, punctuation, and structural overhead therefore contribute deterministically. OpenRouter's
wire encoding differs from this provider-neutral JSON; the existing 76/256 KiB adapter checks remain
the final authority.

### Trigger and target

- Trigger when `messageEstimatedTokensBefore >= 65_536`.
- If not triggered, return a defensive byte/structure-equivalent request snapshot, before/after
  estimates equal, counts zero, and `targetReached` equal to whether the estimate already satisfies
  `<= 49_152`.
- If triggered, replace eligible result texts oldest-first until the exact after estimate is
  `<= 49_152` or no beneficial candidate remains.
- `triggered` describes the before estimate, even when no result is eligible.
- `targetReached` describes only the final after estimate; target failure is observation, not a new
  public error.

The 64 Ki estimated-token trigger leaves 12 KiB of local headroom below the existing 76 KiB wire
message cap. The 48 Ki target adds hysteresis so one newly appended turn does not immediately repeat
large-scale transformation. Neither constant claims the real model context window.

### Eligibility and exact transform

The marker is exact ASCII and 39 UTF-8 bytes:

```text
[older tool result omitted for context]
```

Candidate selection is exact:

1. Identify the newest complete ToolMessage in the request transcript and protect that whole
   message. If there is no ToolMessage, there are no candidates.
2. Walk earlier ToolMessages from transcript start to end.
3. Within each eligible ToolMessage, walk result content in batch order.
4. A candidate replaces only `ToolResultContent.text` with the fixed marker.
5. Apply it only when the stable JSON string representation of the marker is strictly smaller in
   UTF-8 bytes than that of the original text.
6. Stop immediately after the after estimate reaches `<= 49_152`.

Every replacement preserves role, message/batch boundaries, batch order, callId, name, outcome,
terminal metadata, user/assistant text, assistant tool calls, arguments, and all other values.
Success, error, and terminal results follow the same eligibility rule. No digest, byte count,
prefix/suffix, original content, path, or command is copied into the marker.

`compressedResultCount` is the number of individual result texts actually replaced.
`compressedMessageCount` is the number of distinct ToolMessages containing at least one applied
replacement and increments at most once per ToolMessage. A multi-result batch can therefore have a
result count greater than its message count.

Implementation must be linear in the size of one prepared view plus candidate count: serialize the
stable before envelopes once, clone the request once, and update exact estimates by the UTF-8 JSON
string-size delta of each replaced text. Do not reserialize the whole growing transcript for every
candidate. Each model step derives a new view from the full draft; marker text from an earlier
request is never source data for a later request.

### Irreducible context

If all beneficial eligible candidates are exhausted without reaching the target:

- send that minimal deterministic view through the ordinary single request path;
- do not compress the newest ToolMessage or any non-tool-result field;
- do not create a context-specific retry, fallback, summary, second request, or public stop reason;
- preserve existing OpenRouter sanitized `limit_exceeded` behavior if its 76/256 KiB authority is
  still exceeded before fetch;
- allow an otherwise valid 64–76 KiB noncompressible message view to proceed as today.

## Loop, planner, cancellation, and event integration

Immediately before each model request, `runAgentTurn`:

1. checks the existing turn cancellation signal;
2. creates the full provider-neutral request from system instruction, full draft snapshot, and
   registry definitions;
3. calls `prepareModelContext`;
4. checks cancellation again;
5. claims the existing request lane and performs the existing final pre-generate cancellation check;
6. passes only `prepared.request` to `model.generate`.

The request claim remains as close as today to the actual model call and is never consumed merely by
pure context preparation. A synchronous preparation error uses the existing sanitized contract
failure/noncommit path and starts no provider or tool effect.

Parent and planner child automatically share the same immutable policy because both use
`runAgentTurn`, but their full transcripts and prepared views remain separate. The child begins only
with its explicit task and its own draft. Child estimates and marker decisions do not enter the
parent transcript, session snapshot, events, or TUI. A completed bounded delegation envelope becomes
ordinary parent tool-result text and is eligible only under the same parent rules on a later request.

Do not change:

- parent 8 / child 8 / aggregate 16 admission or one-child state;
- cancellation owner/signal identity or settlement arbitration;
- model/tool counters, max-step behavior, terminal result behavior, commit/rollback;
- completed event types, order, payload, snapshots, or event failure precedence;
- provider retry/fallback zero.

`LoopOutcome.transcript`, event transcript content, and committed session history always retain the
original full tool text. Only ModelRequest observations may contain the marker.

## Session snapshot and TUI contract

Add a read-only `AgentSession.contextSnapshot(): ContextMetrics | undefined` representing the
current committed parent-session context base, not an uncommitted or last-attempted draft.

- Before the first successful committed turn, return `undefined`.
- After successful commit, derive metrics from current full committed transcript, fixed system
  instruction, and registry definitions using the same pure preparation function.
- After failure, cancellation, event-delivery rollback, or rejected blank/busy submit, retain the
  previous committed snapshot exactly.
- If successful commit is rolled back because `turn_end` delivery throws, restore the previous
  snapshot with the previous transcript.
- Return a defensive immutable copy; callers cannot mutate session state.
- Planner child preparation never updates this parent accessor.
- No transcript text, removed text, tool name, path, command, or task is exposed through metrics.

The snapshot is a “next request base” estimate before a future user message is appended. It is not
live provider usage and may differ from the next actual request by that future input.

Extend the internal TUI session port with optional `contextSnapshot`. The controller reads it only
after a turn has settled and only when returning to idle. It does not poll while busy and adds no
event.

Exact ready status:

```text
ready
ready · ctx ≤<ceil(messageEstimatedTokensAfter / 1024)>K/64K est
ready · ctx ≤<ceil(messageEstimatedTokensAfter / 1024)>K/64K est · <N> omitted
```

- Use plain `ready` when the accessor is absent or returns undefined.
- Use the second form when `compressedResultCount === 0`.
- Use the third form when one or more results are omitted.
- The `≤` and `est` labels make the conservative heuristic explicit; denominator 64K is the local
  trigger, not provider capacity.
- `N` is the exact compressed result count in the current committed request view.
- Busy/cancelling/failure/exit status always takes precedence. Cancellation returning to ready shows
  the unchanged prior committed snapshot. Fatal failure still exits through the sanitized path.
- Initial ready, idle input, renderer escaping, terminal restore, and scrollback otherwise remain
  unchanged.

Normal `agent:run` stdout, stderr, JSON, argv/stdin grammar, outcome wire, and exit codes expose no
context metrics and remain unchanged.

## Compatibility requirements

- Below-threshold requests observed by any Model are deeply equal to current provider-neutral
  requests, including property presence, transcript content, tool order, nested JSON values, and
  system instruction.
- OpenRouter endpoint, model, POST body fields, tool schema encoding, `stream:false`, completion
  tokens, credential timing, timeout, response limits, 76/256 KiB checks, and error taxonomy remain
  unchanged.
- Agent Definitions, registry topology, work-tool output bounds, skills snapshot, planner envelope,
  request admission, production task literals, and Deno permissions remain unchanged.
- Corpus/eval, fixed sentinels, acceptance tasks, legacy/basic paths, dependencies/lockfile, and
  `_refs/` remain unchanged.

## Planned file ownership

Add:

- `v0/agent/context.ts`;
- `tests/v0/agent_context_test.ts`;
- `docs/plans/provider-neutral-context-management-results.md` after implementation.

Expected product changes:

- `v0/agent/loop.ts`, `session.ts`;
- `v0/agent/tui_cli.ts`, `v0/tui/controller.ts`, and only if needed `v0/tui/render.ts`;
- focused existing loop/session/runtime/planner/TUI/transport tests and process fixtures;
- `deno.v0.json`, `README.md`;
- owner completion updates to `AGENTS.md` and `.handoff/handoff.md`.

`runtime.ts`, `planner_delegation.ts`, `contracts.ts`, `events.ts`, `openrouter_model.ts`, and
terminal adapters should not require product changes. They may receive only a demonstrated local
type/test seam; any behavioral change requires returning to the stop conditions.

One implementer owns all repository writes. Existing untracked `_refs/` are preserved. No unrelated
file is reformatted, staged, reverted, or removed.

## Ordered implementation

1. Add the pure estimator, constants, marker, exact candidate selection, linear delta accounting,
   defensive cloning, and focused golden/boundary tests.
2. Replace only loop request preparation with the derived view and prove below-threshold identity,
   per-step full-source regeneration, full outcome transcript, cancellation, and event compatibility.
3. Add committed-session snapshot ownership and rollback-safe accessor tests.
4. Prove shared policy but isolated parent/planner child views and unchanged 8/8/16 admission.
5. Add TUI post-settlement ready formatting and fake-terminal/managed-PTY compatibility evidence.
6. Add adapter regression proving irreducible oversize still fails before fetch through the existing
   sanitized limit and ordinary wire bytes remain unchanged.
7. Add the permission-free focused task, check/gate wiring exactly once, README, results, and
   lifecycle evidence.
8. Run repository-defined verification and bounded review.

## Required deterministic tests

Pure context:

- empty transcript, optional system instruction, empty/nonempty tools;
- exact ASCII, multibyte, quote, backslash, newline, nested arguments, and JSON-escape estimates;
- 65,535 below-trigger and 65,536 exact-trigger boundaries;
- exact `<=49,152` stop, oldest-message and batch-result order;
- a multi-result batch with multiple replacements reports result count greater than the one distinct
  compressed message count;
- 39-byte marker, marker-equal/shorter original nonreplacement, beneficial-only replacement;
- newest ToolMessage whole-message protection;
- success/error/terminal metadata, call correlation, batch shape, and causal order unchanged;
- user/assistant text and tool-call arguments remain unchanged regardless of size;
- no candidate and target-not-reached metrics;
- input/source, nested arguments, returned request, and returned metrics mutation isolation;
- exact linear-delta results equal a full stable reserialization oracle in tests.

Loop/session:

- below-threshold request deep identity for final, tool, terminal, and multi-step paths;
- a large old tool result is marked in ModelRequest while `LoopOutcome.transcript` retains full text;
- newest result is verbatim and an earlier result becomes eligible on a later step;
- every step rebuilds from full draft rather than a previous marker view;
- successful committed transcript stays full; next request view may be compressed;
- failed/cancelled/event-delivery drafts do not commit or replace prior context snapshot;
- normal/cancel settlement, counters, events, request claim, and no-next-effect behavior remain exact;
- accessor undefined before first commit, defensive and rollback-safe afterward.

Planner/runtime:

- parent and child independently make marker decisions from their own transcripts;
- child marker/metrics never appear in parent session observation or transcript;
- a bounded child envelope follows ordinary parent eligibility rules;
- parent 8 / child 8 / aggregate 16, one-child admission, no recursion, retry/fallback zero remain exact.

TUI/process/transport:

- initial/absent snapshot `ready`, estimate form, omitted-count form, and exact ceiling formatting;
- snapshot read only after settlement; busy/cancelling/failure/exit statuses take precedence;
- Escape cancellation returns ready with prior committed metrics unchanged;
- no late rendering or terminal restore regression in fake terminal and managed PTY;
- normal `agent:run` process stdout/stderr bytes and exit codes unchanged;
- irreducible >76 KiB wire message fails before credential/fetch with existing sanitized adapter
  error; 64–76 KiB valid noncompressible input still reaches the existing path;
- focused task permissions, production tasks, and full-gate inclusion exactly once.

## Verification commands

Use the exact repository-pinned Deno 2.9.4 command paths recorded in `deno.v0.json`. Add one
permission-free task named `agent:context:test`, then run at least:

```text
agent:context:test
agent:test
agent:session:test
agent:planner-delegation:test
agent:runtime:test
agent:runtime:process:test
agent:transport:test
agent:tui:test
agent:tui:process:test
agent:tui:topology:test
agent:cancellation:test
v0:check
v0:fmt
v0:lint
v0:test
v0:gate
git diff --check
```

The focused task appears exactly once in the full gate. Do not execute production `agent:run`,
`agent:tui`, acceptance/sentinel/canonical/credential launcher tasks, credential probes/reads,
provider/network operations, or anything under `_refs/`.

## Results, review, and completion

The results document maps every contract to evidence and records:

- canonical plan path/hash and baseline/implementation revision;
- exact changed files, constants, marker, estimator envelopes, and TUI status;
- before/after/target/eligibility and parent/child matrices;
- focused/full commands and pass counts;
- review findings, fixes, deviations, rollback, and remaining risks;
- provider, credential, network, production, dependency/lockfile, and `_refs/` activity zero.

After implementation and tests, run one read-only review, at most 30 minutes and stopping after 10
minutes without new evidence. Review estimator correctness, transformation immutability, newest
result protection, full-transcript retention, per-step regeneration, cancellation/request admission,
parent/child isolation, TUI settlement/status, adapter compatibility, and task permissions. If fixes
are required, use at most one changed-lines/finding-closure re-review of 15 minutes. GO requires
Blocker/P1/P2 zero; narrow evidence-only residuals after the single re-review may be closed by an
exact owner final regression and full gate, consistent with repository lifecycle.

Completion requires:

- exact estimator/threshold/target/marker/eligibility tests green;
- below-threshold ModelRequest and normal CLI channels compatible;
- full transcript/outcome/commit/rollback and cancellation/events unchanged;
- parent/child isolation and 8/8/16 preserved;
- TUI alone shows bounded committed-session estimate after settlement;
- focused/full offline gate and diff check green;
- final Blocker/P1/P2 zero;
- no provider/network/credential/production command.

## Migration, rollback, and remaining risks

There is no persistent data or schema migration. Rollback removes only this increment's context
module/tests/task, loop preparation seam, session accessor, TUI status delta, and
documentation/results/lifecycle updates. It must not reset cancellation, multi-turn, TUI,
Definitions, delegation, work tools, handoff history, or untracked references.

Remaining risks:

- the UTF-8-byte estimate is intentionally not tokenizer-accurate and is not actual provider usage;
- provider-neutral JSON differs from OpenRouter wire JSON, so adapter limits remain authoritative;
- marker replacement removes old tool-output meaning from model request views while preserving it in
  full history;
- noncompressible user/assistant/system/tool-definition/newest-result content is not rescued;
- very long full in-memory histories still consume memory and synchronous copy/scan CPU;
- persistent history and semantic/model-generated summary remain later work.

## Stop conditions

Stop implementation and return cause, evidence, impact, proposed plan delta, and verification if:

- user/assistant text, tool-call arguments, call IDs, names, outcome/terminal metadata, complete
  messages/turns, or the newest ToolMessage must be removed or summarized;
- full committed/draft/outcome history must be replaced by the prepared request view;
- a model summary, extra request, retry/fallback, provider tokenizer/usage/window lookup is needed;
- persistence/history, events/progress/streaming, steering/queue, CLI flag/slash command, or public
  output change becomes necessary;
- parent and child context must be shared, or 8/8/16, cancellation, commit/rollback, event order,
  provider/profile/wire/permission contracts must change;
- a dependency/lockfile, credential/provider/network/production command, `_refs/` change, or unsafe
  handling of user-owned state becomes necessary.

This plan authorizes no implementation until the user approves this initial Human Gate.
