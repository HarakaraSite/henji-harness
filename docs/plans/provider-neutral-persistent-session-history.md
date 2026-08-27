# Provider-neutral persistent session/history plan

## Decision

Concept **GO, implementation Human Gate pending**.

Baseline is commit `cbf4fd9556f87e8dcc8d9722586f8750887931e0`. The user approved the
product contract in this plan. This increment adds repo-external persistence to `agent:tui` and a
metadata-only management command. `agent:run` remains one-shot and nonpersistent.

This plan does not authorize implementation until the initial Human Gate is approved. Planning and
review must not run production TUI/session commands, access credentials/providers/network, change
dependencies/lockfiles/`_refs/`, or mutate user session state.

## Approved product contract

1. TUI autosaves a new session by default; `--continue`, `--session ID`, and `--no-session` select
   latest, exact, or memory-only behavior.
2. `agent:sessions` supports metadata-only list and exact `delete --session ID --yes`.
3. State is repo-external under absolute nonblank `XDG_STATE_HOME`, otherwise absolute nonblank
   `HOME/.local/state`, then `henji-harness/sessions`.
4. Resume requires canonical workspace and selected built-in agent match. Current AGENTS and skills
   are rediscovered rather than persisted.
5. Full committed parent transcript is restored to the model. TUI replay is limited to the latest
   100 messages or 256 KiB.
6. Bounds are 8 MiB per session, 256 valid sessions per workspace, and 512 scanned entries. There
   is no automatic deletion, truncation, summary, repair, or migration.
7. Corrupt/unsupported data is preserved and rejected. Delete targets one exact ID and needs
   `--yes`.
8. Settlement uses synced sibling temp plus atomic rename. Directory-fsync crash durability is not
   claimed.

## Current and reference boundaries

`AgentSession` owns full committed history, next-turn state, cancellation, and committed context
metrics (`v0/agent/session.ts`). Successful final/tool-terminal settlement commits before the
synchronous `turn_end`; sink failure restores prior memory (`v0/agent/loop.ts`). `Message` already
contains the complete provider-neutral causal transcript (`v0/agent/contracts.ts`). Context views
are regenerated from full history (`v0/agent/context.ts`). Runtime materializes current workspace,
instructions, skills, Definition, model, and registry once (`v0/agent/runtime.ts`).

From pinned Zot commit `9b7bb6a4f36bc8c8deb2cc5796a8f557f4fb7479`, adopt only canonical
workspace-digest partitioning and separate continue/resume/no-session concepts from
`_refs/zot/packages/core/session.go` and `packages/agent/args.go`. Henji uses the full SHA-256 and
validated stored timestamps, not shortened digest or mtime.

From pinned Pi commit `a69bef789bc95abf0acee16f7b4660b70b650bb9`, adopt only default
autosave, explicit continue/resume/no-session, repo-external organization, and a versioned header as
compared in `_refs/pi/packages/coding-agent/docs/sessions.md` and `session-format.md`.

Do not adopt upstream JSONL, branching, rename/search/picker, compaction, usage/cost, export/import,
repair/migration/pruning, or code. `_refs/` remains unchanged reference evidence.

## Verified locking prerequisite

The installed Deno is 2.9.4 on `aarch64-unknown-linux-gnu`. A disposable `/tmp` probe confirmed
`FsFile.tryLock(true)`: first exclusive owner returns `true`, a second process returns `false`
immediately, and acquisition succeeds after unlock. Exact lock-file read/write permission suffices;
no sys/network/credential permission is required. The probe was removed. The focused process suite
must reproduce this result.

## CLI contract

TUI accepts one optional exact `--agent default|planner` plus one of omitted persistence selector,
`--continue`, `--session ID`, or `--no-session`, in either order. Duplicates, conflicts, missing or
blank values, malformed IDs, unknown flags, and positionals fail before workspace/state/provider/
credential/terminal setup.

- Omitted creates a new persistent session.
- `--continue` uses the same total order as list—`updatedAt` descending, then ID ascending—and
  selects the first valid matching workspace/agent session. It never silently creates.
- `--session ID` resumes only that exact matching session.
- `--no-session` performs zero state access and preserves current behavior.
- Startup renders exactly `session> <ID> (new)`, `session> <ID> (resumed)`, or
  `session> ephemeral`, through terminal escaping and without state paths.

The POSIX launcher performs one exact side-effect-free grammar preparse before reading XDG/HOME.
For `--no-session`, it starts the existing memory-only TUI child without resolving or granting a
state root. Invalid grammar therefore wins over missing/invalid state environment. For every
persistent selector, it resolves and validates the root before child startup. Shell arguments are
passed as distinct quoted argv values; spaces and shell metacharacters are accepted. Because Deno
2.9.4 permission path lists cannot represent a comma-containing root without broadening access,
XDG/HOME candidates whose derived state root contains comma, CR, or LF fail closed as
`startup_failure`. Launcher and TypeScript parsers must have exhaustive parity tests.

Management grammar is exact:

```text
agent:sessions list
agent:sessions delete --session <SESSION_ID> --yes
```

It uses the current canonical workspace and never materializes instructions, skills, Definition,
registry, model, credential, or provider. Exact success wires, including property order, are:

```text
{"schemaVersion":1,"sessions":[{"id":"<ID>","agent":"default","createdAt":"<ISO>","updatedAt":"<ISO>","turnCount":2,"messageCount":6}]}
{"schemaVersion":1,"sessions":[],"skippedInvalid":2}
{"ok":true,"deleted":"<ID>"}
```

`skippedInvalid` is absent when zero and follows `sessions` when nonzero. Entries contain fields in
the shown order and sort updated-desc then ID-asc. Failure has empty stdout, one exact compact stderr
line `{"ok":false,"error":{"code":"<CODE>","message":"<MESSAGE>"}}\n`, exit 1, and this
exact code-to-message mapping:

```text
invalid_invocation -> invalid invocation
session_not_found  -> session not found
session_busy       -> session busy
session_invalid    -> session invalid
session_limit      -> session limit reached
session_io_failure -> session I/O failure
```

Messages contain no path or content. TUI invocation errors
remain existing `invalid_invocation`; any allocation/resume/root/lock/schema/bound/IO failure before
raw acquisition maps to existing `startup_failure`, empty stdout, its existing exact stderr line,
and exit 1. Internal `session_*` distinctions are not exposed by TUI.

`agent:run` grammar, channels, permissions, outcomes, and state-free behavior do not change.

## Paths, permissions, and identity

A POSIX launcher resolves the state root before pinned-Deno startup and passes it through one
launcher-owned env name. TUI keeps existing workspace/Bash/credential/net permissions plus exact
state-root read/write. Sessions management gets only required workspace/state read/write and env;
no provider net, credential env, or Bash run.

```text
<root>/<workspace-sha256>/sessions/<session-id>/session.json
<root>/<workspace-sha256>/sessions/<session-id>/.tmp-<uuid>
<root>/<workspace-sha256>/locks/.index.lock
<root>/<workspace-sha256>/locks/<session-id>.lock
```

The `sessions` and `locks` directories are separately bounded namespaces; each session directory is
an exact validated ID and contains only `session.json` plus at most one in-flight exact temp.
Workspace digest is
lowercase full SHA-256 over UTF-8 canonical workspace path. Session ID is
lowercase canonical `crypto.randomUUID()` UUID v4. Only validated IDs enter basenames; no caller
path, separator, dot segment, partial ID, or alternate encoding is accepted. App/session/workspace
directories are real non-symlink 0700 directories. Session/temp/lock files are regular non-symlink
0600 files. Wrong types, symlink traversal, or group/other bits fail closed. Parent XDG/HOME modes
are not changed; owner probing and `--allow-sys=uid` are absent.

## Schema v1

Each session is one canonical strict-UTF-8 JSON object plus one LF, in exact property order:

```ts
interface PersistentSessionV1 {
  readonly schemaVersion: 1;
  readonly sessionId: string;
  readonly workspaceRoot: string;
  readonly agent: 'default' | 'planner';
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly nextTurn: number;
  readonly transcript: readonly Message[];
}
```

File size is 1..8,388,608 bytes; BOM/NUL are rejected. Parsed data is strictly validated, then bytes
must equal `JSON.stringify(value) + "\n"`. This rejects unknown/duplicate/reordered fields,
whitespace, noncanonical values, and unsupported versions without a dependency. Validate canonical
UUID, exact workspace/agent, canonical ISO timestamps with updated >= created, finite nested JSON,
every message/result variant and causal pair. Transcript starts with user, contains only complete
successful turns, and `nextTurn` equals user-message count plus one.

Persist only identity metadata and full committed parent transcript. Never persist request views,
markers/metrics, instructions/skills/tools, events/outcomes/counters, cancellation, provider/profile/
credential data, planner-child history, or terminal display history.

## Bounds and restored display

```text
MAX_SESSION_FILE_BYTES = 8_388_608
MAX_VALID_SESSIONS_PER_WORKSPACE = 256
MAX_WORKSPACE_DIRECTORY_ENTRIES = 512
MAX_RESTORED_DISPLAY_MESSAGES = 100
MAX_RESTORED_DISPLAY_BYTES = 262_144
```

The 512 bound applies independently to direct entries in `sessions` and `locks`; entry 513 in either
fails the operation. Each session ID directory is one sessions entry; index/session locks are lock
entries. A session directory must contain only zero or one `session.json` and at most one in-flight
exact temp; an unexpected third or unknown entry is invalid. Exactly 256 distinct reserved-or-valid
session IDs rejects new allocation. Invalid session directories do not count as valid but count
toward the sessions scan. Oversize commit fails before temp creation. Nothing is automatically
removed or shortened.

Resume restores full history to session/model. Restored-display accounting is the sum of UTF-8 bytes
of `JSON.stringify(message)` for each whole selected message, with no array brackets, commas,
renderer prefixes, escaping expansion, or omission line included. Walk newest-first, include the
next whole message only when count remains `<=100` and byte sum remains `<=262144`, then reverse the
selected suffix into causal order. If the newest message alone exceeds the byte bound, render no
history messages and omit all. Render one static omission line with the exact omitted message count.
Existing per-value 64-KiB display bounds and terminal escaping then apply without changing selection.

## Locking and settlement

`locks/.index.lock` serializes allocation, both bounded scans, resume/delete coordination, and
session-lock pathname management. `locks/<id>.lock` serializes one writable session and exact delete.
Acquisition is
nonblocking `tryLock(true)`, always index then session. An active TUI holds only its session lock
during model/tool work. Contention is `session_busy`; there is no retry, polling, sleep, PID data, or
process probing. Crash-released kernel locks make zero-byte lock files reusable.

Under index lock, accounting is the set union of valid session-directory IDs and actively
kernel-locked session-lock IDs. To classify a lock, try exclusive acquisition once: `false` means
active; `true` means crash-orphan/inactive and it is released, then may be removed only when no
matching valid session exists. Thus an active empty allocation is a reservation and the union never
exceeds 256. New allocation scans both top-level namespaces within 512, enforces the union bound,
obtains a bounded-collision UUID, creates its 0700 session directory, acquires its 0600 lock, then
releases index. First commit writes inside that reserved directory and does not increment the union.
No JSON exists before first successful turn. Clean empty close removes the empty session directory
and lock under index coordination. A commit creates at most one temp inside its own directory, so it
cannot consume another top-level workspace entry or race the 512 scan ceiling. Crash-orphan empty
directories/locks are removed only under index lock after proving no active kernel lock and no JSON.

Before `turn_end committed:true`, a successful turn validates/serializes the full candidate, creates
a unique 0600 sibling temp, writes all bytes, syncs and closes it, atomically renames it, installs
memory/context, then emits the event. The separate session lock remains held across rename. This
claims prior-or-complete-new visibility and file sync, not directory-fsync durability or rollback of
model/tool/filesystem effects.

Write/sync/close/rename/schema/size/lock failures preserve prior state before rename, clean temp
best-effort, restore memory, emit no committed end, poison the session, sanitize failure, and make
TUI restore/exit 1. No fallible work may remain between rename and memory installation.

To preserve current event rollback, a `turn_end` failure after install atomically restores the prior
serialized snapshot (or removes first-turn JSON) under the same lock, then restores memory and
poisons. Durable rollback failure reports sanitized cleanup failure, preserves recovery artifacts,
and makes no authority claim. All fault positions require direct tests.

## Corruption, privacy, and compatibility

Missing exact ID is `session_not_found`; invalid bytes/schema/version/workspace/agent/mode/type/
symlink is `session_invalid`; I/O is sanitized. List skips invalid JSON with only a count, but a
directory failure or entry 513 fails wholly. Listing/resume never rewrite. Temp cleanup is deferred.

History may contain tasks, responses, local file/shell output, arguments, and results. Document
autosave/location before use. `--no-session` touches no state, modes are 0700/0600, list is metadata
only, and errors expose no content/path. Encryption, telemetry, indexing, preview, secure erase, and
hostile-same-user protection are not claimed.

Definitions, current AGENTS/skills, 8/8/16 admission, planner isolation, cancellation, context,
events, provider wire/credential timing/no-retry, work tools, corpus/eval/sentinels, dependencies,
and `agent:run` remain unchanged.

Out of scope: run persistence; summary/marker persistence; branching/picker/search/rename;
automatic retention/repair/migration; export/import; stored instructions/skills; child persistence;
progress/streaming/steering/queue; shared writers; directory-fsync; encryption/secure erase;
dependency/lockfile, provider/network/credential production use; `_refs/`, archive/siblings; commit,
push, tag, publish, release.

## Files and ordered implementation

Add `v0/agent/session_store.ts`, `session_cli.ts`, `session_launcher.sh`, direct/process/topology
tests, an optional process fixture, and a results document. Modify `session.ts`, `runtime.ts`,
`tui_cli.ts`, only necessary TUI files/tests, `deno.v0.json`, README, AGENTS, and handoff. One
implementer owns all writes.

1. Pure constants, strict schema/codec, ID/time/message validation, digest, metadata projection.
2. Abstract store/lock port and fake adapter.
3. Deno adapter for modes/types/bounds/scans/locks/atomic writes.
4. Cross-process pinned-Deno lock proof in disposable `/tmp`.
5. Session hydration, durable commit/rollback, poisoning, close; preserve ephemeral constructor.
6. Runtime composition for ephemeral/new/continue/exact resume; leave `runRuntime` unchanged.
7. TUI grammar/startup/replay and lock release across all exits.
8. Metadata-only list and confirmed delete without provider/runtime materialization.
9. Launcher and exact production/test permission topology.
10. Direct/process/topology and compatibility evidence, tasks included once in check/gate.
11. README/results/lifecycle, full offline verification, bounded review.

## Required tests

Evidence must include:

- canonical golden bytes; UTF-8/BOM/NUL/order/unknown/duplicate/version/ID/time/finite JSON/message/
  causal validation; 8-MiB boundary; mutation isolation;
- workspace digest, UUID collision seams, XDG/HOME precedence, no path injection, 0700/0600,
  symlink/type/mode rejection, unchanged parents, exact shell/TypeScript parser parity, both flag
  orders, unset/relative env, spaces/comma/shell metachar roots, effective child permissions, and
  zero `--no-session` state resolution/access;
- first/second-process lock, unlock/crash recovery, index/session ordering/contention,
  different-session concurrency, active-delete rejection, no retry/PID probing;
- no JSON for empty allocation, first/two/restarted-third turns, full terminal/causal history;
  255/256 allocation, concurrent empty reservations, 256 active sessions, first/update temp at the
  boundary, crash-orphan locks, delete/reallocation, independent 512/513 scans, stable metadata and
  same-timestamp continue/list tie-break, invalid count, no content leaks, exact delete;
- byte-identical prior file after model/contract/max-step/cancel/busy failure; injected temp/write/
  sync/close/rename/size failures; poison; event rollback including first turn and rollback failure;
- resumed full context and recomputed metrics; current instructions/skills; workspace/agent early
  mismatch; default/planner separation; child nonpersistence; unchanged 8/8/16/lazy credential;
  zero `agent:run` state;
- all TUI grammar permutations, preflight ordering, exact session line, causal bounded replay at
  100/256-KiB exact JSON-message-byte edges including an oversized newest message, omission/escaping,
  terminal replay, context status, restore/lock close;
- exact management success property order, optional skippedInvalid, every fixed error wire, and TUI
  internal-session-error to startup-failure mapping; list/delete never materialize provider/runtime
  and local topology never invokes production modes.

## Tasks, verification, and review

Add pinned-Deno `agent:session-store:test`, a `/tmp` read/write plus pinned-Deno-run process test, and
a topology test reading only `deno.v0.json` and launcher. Production `agent:tui` and
`agent:sessions` use the launcher. Focused tasks occur exactly once in check/gate.

Run at least all three new tasks, `agent:session:test`, `agent:context:test`,
`agent:cancellation:test`, `agent:planner-delegation:test`, runtime direct/process, TUI direct/
process/topology, transport, loop, `v0:check`, `v0:fmt`, `v0:lint`, `v0:test`, `v0:gate`, and
`git diff --check`. Tests use disposable `/tmp` roots and prove zero remnants. Never run production
agent/session/provider/credential/sentinel tasks or change dependencies/`_refs/`.

README documents autosave/opt-out, grammar, location, privacy, bounds, corruption/lock/atomicity
nonclaims, and run nonpersistence. Results map requirements, files, schema/path/lock/fault matrices,
commands/counts/review, deviations, and prohibited activity zero.

After implementation, run one read-only review up to 30 minutes, stopping after 10 without new
evidence. One changed-lines re-review may run for 15 minutes. GO requires Blocker/P1/P2 zero; narrow
evidence-only residue may close by exact owner regression and full gate.

There is no existing migration. Unknown versions are preserved/rejected. Code rollback restores
memory-only TUI but never deletes v1 data; cleanup needs a destructive Human Gate. Remaining risks
are plaintext history, hostile same-user access, no directory-fsync guarantee, rollback
indeterminacy, hard 8-MiB refusal, full-history memory cost, POSIX assumptions, changed current
instructions/skills, ordinary unlink, and manual orphan cleanup.

## Stop conditions and Human Gates

Stop with cause/evidence/impact/proposed delta/verification if pinned locking or exact state-root
permissions fail; strict validation needs dependency/broader parser; durable install/event rollback
or rename-to-memory authority cannot be made exact; cancellation can release locks early;
same-session writers cannot fail promptly; resume needs persisted views/instructions/provider/child
state; existing run/Definition/8-8-16/provider/work-tool/cancellation/context contracts must change;
or repair/truncation/pruning/migration/retry, dependency, provider/credential/network production,
`_refs/` change, destructive state action, or unrelated-state overwrite becomes necessary.

The initial implementation Human Gate authorizes only repository implementation, disposable tests,
full offline verification, docs/results/lifecycle, bounded review, and plan-scoped fixes. It excludes
production `agent:tui`/`agent:run`/`agent:sessions`, actual session creation/resume/list/delete,
provider/network/credential access, dependency/lockfile/`_refs`, commit, push, tag, publish, and
release. Any real-session smoke test, deletion/cleanup, migration/repair, provider attempt, or
release is a separate explicit Human Gate.
