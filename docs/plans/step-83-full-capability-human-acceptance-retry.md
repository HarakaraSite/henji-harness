# Step 83 full-capability Human Gate retry

Status: **Human Gate 2 pending; implementation and execution are not
authorized**

Planning source:
`/tmp/planner-inputs/henji-step-83-full-capability-human-acceptance-retry.md`,
SHA-256 `ed6989b955337954e10e5e51f71c8980e4a7a219c7f796534119dd8a4e945319`,
concept revision 42. Target HEAD: `7b8f0d797d45c4345391520017475df13f9f5802`.

The distinct, initially unapproved execution package is
[step-83-full-capability-human-acceptance-retry-gate.md](step-83-full-capability-human-acceptance-retry-gate.md).
The consumed old gate remains immutable and cannot authorize this retry.

## 1. Outcome and boundaries

Prepare one new conditional full-capability acceptance. The installed production
`henji` submits the exact Turn 1 once. A failure stops immediately and is
evaluated through the sanitized live and durable diagnostic. A success
continues, without another approval, through Turn 2 and one `henji --continue`
Turn 3. Acceptance of Turn 1 consumes the gate regardless of outcome.

This plan first closes four production-readiness gaps:

1. successful TUI turns do not expose their actual provider fetch-start counts;
   and
2. the installed launcher predates diagnostics, while the existing one-time
   installer cannot safely perform a second update because its original fixed
   backup already exists; and
3. clean turn cancellation and model-step exhaustion currently terminate without
   the diagnostic ID and exact durable readback required by revision 42; and
4. a failed planner child currently returns a failure envelope to the parent,
   which can issue another provider request instead of stopping at the first
   runtime failure.

The implementation must not change the provider request/response wire, request
admission bounds, transcript, session/context schema, failure-diagnostic record
shape/schema version/store, retry behavior, trusted-local tool authority, or
Step 83R UI/core ownership. It may extend only the bounded diagnostic stage/code
allowlists and terminal creation path described below. It must not inspect a
credential, invoke a provider, run production `henji`, mutate machine state, or
create/delete real acceptance state.

## 2. Confirmed current state

- `main` is at the target HEAD. The working tree has only user-owned untracked
  `_refs/*`; those paths stay unread by the increment and are never changed,
  staged, or deleted.
- Sanitized failure diagnostics are committed. The recorded final disposition is
  Product Blocker/P1/P2 zero and Evidence E1/E2 zero, with all 70 direct files /
  763 offline tests covered.
- The old attempt stopped after Turn 1 with no tool effect or committed turn.
  Its workspace, namespace, and any historical evidence remain outside this
  plan's cleanup authority.
- The repository-owned installer `check` currently returns sanitized
  `startup_failure`, exit 1. The canonical launcher SHA-256 is
  `2e45157491bdac8c0de52ab56116111d00077152665021135324e1602a69dcf6`; the
  installed launcher is
  `0fc6bba0de3d5e6ba7701355b6cf12752b7bfad8e5f31d048f666a4abfb0d95e`; the sacred
  original backup is
  `33adeae91697778d5c648d948a2df50ff2d6476aa72b9fdf29ac3fe8437f1c12`. All three
  are regular non-symlink 0755 files owned by UID 501.
- The runtime increments its aggregate `requestCount` immediately before each
  actual `fetch`. Failure diagnostics retain a turn-relative occurrence count,
  but successful `turn_end` events, presentation, and retained UI have no
  corresponding count.

These observations are planning evidence, not authority to update the installed
launcher or use the preserved state.

## 3. Old/new keep-change table

| Object                                                                       | Plan                                                                                                                                                                                                                                |
| ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Consumed old gate and result                                                 | Keep byte-for-byte; never edit or re-arm                                                                                                                                                                                            |
| `/tmp/henji-step83-full-capability-acceptance` and old namespace/diagnostics | Keep; never reuse, mutate, or clean                                                                                                                                                                                                 |
| New gate document                                                            | Add separately; keep unapproved until offline closure and final execution approval                                                                                                                                                  |
| `/tmp/henji-step83-full-capability-acceptance-r2`                            | Require absent; create once only inside final execution approval; retain afterward                                                                                                                                                  |
| `/tmp/henji-step83-full-capability-expected-r2`                              | Require absent; create only for post-run assertion; retain afterward                                                                                                                                                                |
| New workspace namespace                                                      | Resolve and pin the absolute state root, partition by digest `040610e64dc39b08a9f9ac3f300c4c9f435357014e31449cb834b2cefc0a51bd`, require the complete partition absent before setup, and retain session/context/diagnostic evidence |
| Installed launcher                                                           | Update once only inside final execution approval after all offline gates                                                                                                                                                            |
| Original `henji.pre-step83-continuation` backup                              | Sacred and immutable                                                                                                                                                                                                                |
| New retry backup                                                             | Atomically preserve the pre-retry installed launcher at `henji.pre-step83-retry`                                                                                                                                                    |
| Retry rollback recovery                                                      | Preserve a failed/rolled-back retry candidate at `henji.retry-rollback-recovery`                                                                                                                                                    |
| Repository source/tests/tasks/docs                                           | Change only as specified below after Human Gate 2 approval                                                                                                                                                                          |

Success and failure both retain new workspace, state, diagnostic, expected file,
and launcher evidence. Cleanup is a later, target-specific approval.

## 4. Gate identity and consumption state machine

```text
UNAPPROVED
  └─ separate final execution approval → PRESUBMIT
       ├─ preflight/update/startup/F1 stop → STOP_UNCONSUMED
       └─ exact Turn 1 accepted → CONSUMED
            ├─ Turn 1 failure/cancel/bound violation → FAILURE
            └─ Turn 1 success → Turn 2
                 ├─ failure/cancel/bound violation → FAILURE
                 └─ success → normal exit → henji --continue → Turn 3
                      ├─ failure/cancel/bound violation → FAILURE
                      └─ success → SUCCESS
```

Preflight, the one machine update, readback, workspace setup, startup, and F1 do
not consume the provider attempt. A pre-submit stop must be incorporated into a
corrected package before submission. Once Turn 1 is accepted, the same task is
never resubmitted and no TUI restart, fallback, rerun, additional follow-up,
other model, or other provider is allowed. Turn 2 or Turn 3 failure similarly
forbids that turn and all later turns.

## 5. Successful-turn actual request accounting

### Contract

Extend the terminal event path with two bounded, non-secret integers:

- `turnProviderRequestCount`: actual fetch starts since that accepted turn's
  admission;
- `runtimeProviderRequestCount`: actual fetch starts since the current `henji`
  process began.

`AgentSession` snapshots the runtime fetch counter at turn admission and owns
the subtraction. The loop's provider-neutral direct-call compatibility may keep
these terminal-event fields optional, but every production `AgentSession`
terminal event supplies them. Values must be nonnegative safe integers, turn
count must be 0..16, runtime count must be monotonic within one process, and
every failure diagnostic occurrence count must equal the same turn's terminal
actual count. The immediate-stop rule below forbids a parent or child fetch
after the first diagnostic occurrence. A mismatch or wrong-turn correlation is
non-evaluable; it is never generalized or silently repaired.

Project the values through `v0/agent/events.ts`, `v0/agent/session.ts`,
`v0/presentation/contract.ts`, and `v0/agent/tui_presentation_adapter.ts`.
Retained state/rendering adds exactly one immutable terminal line per accepted
turn:

```text
requests> turn=2 · actual=3 · runtime=7
```

`runtime` is process-local and restarts at zero for `henji --continue`. The
gate-wide total is the sum of the three `actual` values, not the sum of runtime
cumulative values. The line must remain in the retained log through resize,
reflow, scrolling, ready-state redraw, and ordinary exit.

### Non-goals

Do not persist these counts into the transcript, session/context schema, or
failure record; do not send them to the model/provider; and do not change
request admission or cancellation settlement. The gate package records each line
before exiting and performs the three-value arithmetic after Turn 3 or at the
failure stop.

### Files and evidence

Expected source/test surface:

- `v0/agent/events.ts`, `v0/agent/session.ts`;
- `v0/presentation/contract.ts`, `v0/agent/tui_presentation_adapter.ts`;
- `v0/tui/state.ts`, `v0/tui/render.ts` and the existing controller composition
  where needed;
- focused session, runtime, presentation, retained-TUI, process, and topology
  tests.

Known answers include parent-only success, one planner child, actual fetch
versus admission claim, two-turn cumulative counts, post-continue process reset,
failure/cancel/max-steps terminal ordering, diagnostic/terminal equality,
mismatch/wrong-turn rejection, retained-log stability, and byte-identical
session JSON without a new count field.

### Cancellation and model-step terminal diagnostics

Extend the existing bounded allowlists, without changing record fields, schema
version, storage format, or CLI, with one fixed turn-control stage and two fixed
codes:

- `turn_control` / `turn_cancelled` for clean cancellation after an accepted
  turn;
- `turn_control` / `model_step_limit` for model-step exhaustion.

The loop mints these records at terminal settlement through the existing
occurrence-bound diagnostic owner, before delivering `turn_end`. Their request
count therefore equals the terminal turn count. Existing `cancellation_cleanup`
/ `cleanup_error` precedence remains unchanged. A previous diagnostic already
owned by the same turn is never overwritten; its typed cause remains
authoritative and the terminal count correlation follows the exact-equality
rule. Add direct known answers for zero-request cancellation, cancellation after
a fetch, exact max-step exhaustion, prior diagnostic ownership, persistence
failure, noncommit, and event/result identity.

### Planner failure propagation

Replace the production path that converts a non-success planner execution into a
recoverable failure envelope. A child diagnostic, non-success child outcome,
invalid or oversized planner output, or delegation admission violation becomes
one fixed typed internal terminal signal. The parent loop recognizes only that
signal, emits the bounded tool failure evidence required by the retained UI, and
terminates the accepted parent turn as `contract_failure` without another model
request.

When the child already owns a diagnostic, the parent terminal path reuses and
persists that exact immutable record; it must not call `record` again or set the
collision flag. For a planner validation or admission failure without an
existing record, the path first mints one bounded existing-shape diagnostic
using the applicable allowlisted `model_result_validation` or
`request_admission` stage/code, then follows the same terminal path.
Cancellation and cleanup precedence remain authoritative.

This changes failure control flow only. Successful delegation retains its
bounded result envelope and normal parent continuation. Direct known answers
must prove one child failure call/result, exact diagnostic identity through the
parent terminal event, no diagnostic collision, failed parent noncommit,
occurrence count equal to terminal actual count, and zero parent fetch after the
child failure. Invalid output, output limit, delegation limit, persistence
failure, and cancellation precedence receive the same no-post-failure-fetch
assertion.

## 6. Second machine launcher update and rollback

Extend `v0/agent/install_henji_machine_launcher.sh` without changing existing
`check|install|rollback` semantics. Add two distinct commands:

```text
update-retry
rollback-retry
```

Fixed paths are:

```text
target             /home/masat.guest/.local/bin/henji
original backup    /home/masat.guest/.local/bin/henji.pre-step83-continuation
retry backup       /home/masat.guest/.local/bin/henji.pre-step83-retry
retry recovery     /home/masat.guest/.local/bin/henji.retry-rollback-recovery
```

`update-retry` requires canonical source, target, and original backup to be
current-owner regular non-symlink 0755 files; source and target must differ;
retry backup, retry recovery, and all fixed temporary names must be absent. It
must never write, remove, rename, or republish the original backup. Under
`umask 077`, it copies and verifies the current target into one private
temporary, atomically publishes that as the retry backup, copies and verifies
canonical source into another private temporary, atomically replaces the target,
then verifies target/source bytes, mode, and owner. Every failure is sanitized
and bounded. Publication of the retry backup is irreversible evidence and must
not be hidden by later cleanup.

`rollback-retry` uses only the retry backup. It requires target/retry-backup
validity and retry recovery absence, atomically publishes a verified copy of the
current target as retry recovery, then atomically restores a verified copy of
the retry backup. It leaves the original backup and retry backup unchanged. The
old `rollback` continues to mean restore from the original backup.

Offline process tests cover successful update/check/rollback-retry; old command
compatibility; original-backup byte invariance; duplicate retry backup/recovery;
mode, owner, symlink, special-file, and missing-file refusal; every
`mktemp/cp/chmod/stat/cmp/mv` position; late failure target and retry backup
survival; and no unbounded cleanup. The execution package forbids old `install`
and old `rollback` for this retry.

Inside the later final approval, call `update-retry` exactly once. If it returns
failure, do not continue automatically. Read back target/backup state. Only when
the retry backup was validly published and target is not the canonical source
may the same final approval permit one `rollback-retry`; record the result and
stop before Turn 1.

## 7. Model, request, and inference-cost ceiling

Official OpenRouter information was refreshed on 2026-09-02 at 09:30 JST:

- model `google/gemini-3.7-flash`;
- endpoint `POST https://openrouter.ai/api/v1/chat/completions`;
- tool calling supported;
- context 1,048,576 tokens and provider maximum completion 65,536 tokens;
- input USD 0.75/M tokens and output USD 3.75/M tokens.

Sources: <https://openrouter.ai/google/gemini-3.7-flash>,
<https://openrouter.ai/docs/api/api-reference/chat/send-chat-completion-request>,
and the public OpenRouter Models API. Repository profile/runtime values remain
`max_completion_tokens=1024`, parent 8, planner child 8, aggregate 16 per
accepted turn, three accepted turns, and application retry 0. Therefore the
workflow permits at most 24 parent plus 24 planner requests, total 48.

The exact no-skill fixed registries at the 76-KiB serialized-message limit
measure 80,304 parent request bytes and 78,566 planner request bytes. Treating
each byte as one input token is a deliberately conservative engineering ceiling:

```text
input = 24 × 80,304 + 24 × 78,566 = 3,812,880 byte-as-token
input cost  = 3,812,880 × 0.75 / 1,000,000 = USD 2.859660
output cost = 48 × 1,024 × 3.75 / 1,000,000 = USD 0.184320
total       = USD 3.043980
```

The rounded inference authorization ceiling is **USD 3.10**. It is not a
prediction; the fixed Turn 1 initial request body measured only 3,126 bytes and
normal spend should be materially lower. Credit-purchase fees and taxes are
outside the inference ceiling.

Repeat the profile/body measurement and official model, endpoint, tools, price,
and conditional pricing check immediately before final approval and immediately
before Turn 1. Any change to model, endpoint, price, token/request bound,
routing contract, or a computed value over 48 requests or USD 3.10 stops before
submission and returns a revised package to the user.

## 8. Provider-free readiness sequence

After implementation review and offline closure, the final package fixes this
order:

1. pin reviewed integration HEAD, source SHA, review disposition, and
   authoritative gate result;
2. confirm the worktree has only the allowed user-owned `_refs/*` entries;
3. refresh official model/API/tool/pricing facts and recompute the ceiling;
4. resolve and pin the absolute production state root; prove the complete digest
   partition, new workspace, expected file, retry backup, and retry recovery are
   absent;
5. record old workspace and original backup identity without changing or
   cleaning them;
6. under the separate final approval, run `update-retry` once;
7. run installer `check` and read back target/source bytes, regular-file status,
   0755 mode, and owner;
8. create the exact 0700 fresh workspace and exact 0600 three-line
   `request.txt`;
9. from that workspace, confirm installed `henji diagnostics list` routes to the
   current repository and reports no diagnostic for the new namespace without
   provider/credential/tool/session effects;
10. start bare installed `henji`, verify workspace/default/new session,
    open/dismiss F1 once, and verify request-time credential guidance without
    reading its value;
11. submit exact Turn 1 once.

Pre-submit drift or error stops unconsumed. It does not authorize an improvised
repair or submission.

## 9. Conditional three-turn workflow

The gate document contains the exact revision-42 tasks and literal assertions.

- Turn 1 must use meaningful read, create/write, edit, Bash verification,
  visible streaming/tool activity, a settled final, a committed turn, one
  request-count line, exact four-line file, and no observed out-of-scope effect.
  Failure takes the failure branch; success advances to Turn 2.
- Turn 2 changes only `Check: pending` to `Check: passed`, verifies exact four
  lines, commits, and emits its count. Failure stops; success performs clean
  Ctrl-D exit and terminal restoration.
- Continue uses installed bare `henji --continue` from the same workspace. It
  must restore the same default Agent/session and two committed turns. Turn 3
  appends only `Resumed: yes`, verifies exact five lines, commits, emits its
  process-reset count, and exits cleanly.

Tool order is not fixed. Optional planner delegation remains at most once per
accepted turn. Bash-only substitution for all file work remains a named UX
blocker candidate, not an automatic rewrite of the expected tool order.

The trusted-local Bash tool is not a hard sandbox. `workspace outside effect 0`
means no such effect is observed in retained tool activity and the package's
bounded file/session assertions. It is not a mathematical audit of the entire OS
filesystem. Requiring that stronger property would need a new sandbox/audit
concept and is outside revision 42.

## 10. Failure branch

On any runtime failure, cancellation, bound violation, commit failure, or
diagnostic persistence failure after startup:

1. send no additional provider request and never resubmit pending input;
2. record the retained `failure>` ID, stage, code, lane, requests, optional HTTP
   status/parser reason, turn, model step, timestamp, retry 0, durability, and
   fixed store error;
3. record the same turn's `requests>` line and require exact equality with the
   diagnostic occurrence count;
4. exit through the normal pending-discard/terminal-restoration contract;
5. use only the displayed ID with installed
   `henji diagnostics show --id '<UUID>'`; do not infer a record from `list` or
   `latest`;
6. compare live/durable IDs and fields and assert absence of credential,
   Authorization, raw payload, and arbitrary private text;
7. inspect new workspace file effects, committed session/turn/context state,
   selected locks/temps, and already-recorded actual request counts read-only;
8. classify the result as `evaluable diagnosed failure` or
   `non-evaluable diagnostic failure`;
9. retain all new state and stop without fix, retry, cleanup, or adoption
   decision.

If persistence fails, the live immutable record plus fixed store error remains
evidence, but the gate is non-evaluable. A missing request line, count mismatch,
wrong-turn correlation, or missing durable record is never presented as a
diagnosed success.

## 11. Success branch

After each successful turn and before the next transition, record settled final,
committed turn, exact file, `requests>` actual 1..16, runtime cumulative
consistency, visible planner call/result count, and retry/fallback/rerun 0.

After Turn 3, assert:

- exact five-line `acceptance-note.md` and top-level entries exactly
  `acceptance-note.md` and `request.txt`;
- exactly three committed turns, same-session resume, canonical history, and
  expected context state;
- three per-turn actual request counts and their total 1..48;
- no new failure diagnostic in the new namespace since the preflight baseline;
- terminal restoration and selected-session lock/temp residue zero;
- reviewed launcher/profile/endpoint/package identities; and
- no observed out-of-scope file/tool effect.

Do not delete the session, diagnostic namespace, workspace, or expected file.
Present exactly one human decision: `採用可能`,
`方向は有望だがnamed blockerあり`, or `不採用`. Mechanical success does not
substitute for the user's UX judgment, and cleanup remains a later approval even
after that judgment.

## 12. Non-concealment evidence matrix

| Evidence             | Success                                              | Failure                                                |
| -------------------- | ---------------------------------------------------- | ------------------------------------------------------ |
| Application requests | One immutable line per turn; arithmetic total        | Same-turn diagnostic occurrence equals terminal actual |
| Planner              | Visible call/result count                            | Failing lane plus completed call/result evidence       |
| Tools                | Stream, call, result, final                          | Retained activity through the failure boundary         |
| Files                | Exact file/top-level assertions                      | Read-only partial-effect inspection                    |
| Commit/session       | Committed turns and same-session resume              | Failed turn noncommit and exact surviving prefix       |
| Diagnostic           | No new failure record relative to baseline           | Live ID equals exact post-exit readback                |
| Credential           | Fixed source kind and request-time verification only | Never value/header/raw payload                         |
| Cleanup              | Zero; retain evidence                                | Zero; retain evidence                                  |

Unknown is allowed only for a genuinely unobserved bounded fact and must carry a
fixed reason. The gate is not evaluable if the user cannot explain actual
provider requests, tool/file effects, commit/session state, and diagnostic
presence from this evidence.

## 13. Implementation slices and focused verification

### Slice A — request accounting

Implement the typed terminal counts, production-session ownership, bounded
turn-control diagnostics, fail-fast planner propagation, presentation
projection, retained line, and exact known answers. Run only affected
diagnostic/loop/planner/session/runtime/presentation/TUI checks, necessary
check/fmt/lint, and `git diff --check`.

### Slice B — retry installer

Implement `update-retry|rollback-retry`, fixed paths, atomic lifecycle, fault
seams, original-backup invariance, and process tests. Do not invoke the real
installer. Run the focused launcher/package process and topology checks, shell
syntax, necessary check/fmt/lint, and diff check.

### Slice C — execution package and topology

Complete the new unapproved gate document, README/task/topology ownership if
required, exact literal package assertions, results skeleton, and lifecycle
records. The package test is provider-free and must not substitute a fake host
for the later Human Gate.

Expected focused commands are selected from the repository-owned tasks after
implementation:

```sh
deno task --config deno.v0.json agent:test
deno task --config deno.v0.json agent:failure-diagnostic:test
deno task --config deno.v0.json agent:planner-delegation:test
deno task --config deno.v0.json agent:session:test
deno task --config deno.v0.json agent:runtime:test
deno task --config deno.v0.json agent:ui-presentation:test
deno task --config deno.v0.json agent:tui:test
deno task --config deno.v0.json agent:tui:process:test
deno task --config deno.v0.json agent:ui-retained:acceptance:launcher:process:test
deno task --config deno.v0.json agent:tui:topology:test
deno task --config deno.v0.json agent:ui-boundary:topology:test
deno task --config deno.v0.json v0:offline-gate:topology:test
deno task --config deno.v0.json v0:check
deno task --config deno.v0.json v0:fmt
deno task --config deno.v0.json v0:lint
git diff --check
sh -n v0/agent/install_henji_machine_launcher.sh \
  v0/agent/henji_machine_launcher.sh \
  v0/agent/session_launcher.sh \
  v0/agent/failure_diagnostic_cli_launcher.sh
```

Do not use `v0:test` or `v0:gate` during implementation/finding closure. Focused
test expectations must include request-count
success/failure/cancel/continue/nonpersistence and every retry-installer atomic
failure position, old-command compatibility, literal gate paths, tasks,
48-request and USD 3.10 ceilings, zero retry, zero cleanup, and complete central
topology ownership.

## 14. Review, closure, authoritative gate, and rollback

After all affected focused checks are green, perform one 30-minute changed-lines
read-only review. Report Product Blocker/P1/P2 separately from Evidence E1/E2.
Close Product findings first; add only the minimum plan-required known-answer
evidence; rerun affected focused checks; then perform one 15-minute narrow
re-review of changed lines and existing findings. Do not let evidence
requirements expand without a new source-to-impact Blocker/P1.

Only after Product Blocker/P1/P2 zero and Verification E1/E2 zero may the
coordinating owner run one authoritative:

```sh
deno task --config deno.v0.json v0:gate
```

If it fails, fix through the relevant focused test and run one stable-candidate
gate again, recording the reason and count. The reviewer does not rerun the full
gate.

Repository rollback removes only the additive request-count
event/presentation/state/render path, retry installer commands/tests, new
task/topology/docs/results/lifecycle entries, and restores existing source
behavior. It never invokes machine rollback or touches old/new real state. After
an approved machine update, machine rollback is only the separately bounded
`rollback-retry` described above; it is not repository rollback.

Stop and return to the user if implementation needs raw provider data,
credential inspection, session schema migration, persistent success telemetry,
broader tracing, dependency/lockfile change, hard sandboxing, more than the
approved review closure, provider access, actual state cleanup, or a change to
revision 42 Why/What/Whether.

## 15. Human Gates

### Human Gate 2 — repository implementation approval

Approval may cover only the repository product/package/test/docs implementation
above, disposable provider-free tests, focused verification, bounded
review/closure/re-review, lifecycle/results updates, and the final owner offline
gate. It does **not** cover machine update/rollback, credential access,
provider/network, production `henji`, new
workspace/state/session/diagnostic/expected-file creation, the real three-turn
workflow, cleanup, commit, push, tag, publish, or release.

**Stop after presenting this plan. Do not implement before explicit Human Gate 2
approval.**

### Final execution Human Gate — separate approval

After reviewed offline closure, present one exact package containing pinned
HEAD/source SHA, `update-retry` and conditional `rollback-retry`, exact three
tasks, maximum 48 application requests, USD 3.10 inference ceiling,
trusted-local effect scope, consumption point, all per-turn stop conditions,
retry/fallback/rerun zero, success/failure state retention, and cleanup
separation. Refresh official model/API/pricing immediately before approval and
submission. Only that distinct approval may update the machine and perform the
one conditional provider workflow.
