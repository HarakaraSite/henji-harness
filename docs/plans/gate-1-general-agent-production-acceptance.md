# Gate 1 general-agent production acceptance

Status: **planning complete — Human Gate pending**

## Outcome to prove

Use the installed post-D0 production TUI to complete one small, human-readable file task across
three turns:

- FR2: real assistant streaming, settled final, and committed turn;
- FR3: exactly one built-in planner consultation followed by parent read/write/edit/bash work,
  tool-result reinsertion, file effect, and final;
- FR4: a same-session follow-up, normal exit, `henji --continue`, restored canonical history, and a
  third continued turn.

The user directly judges the TUI, file, history, and retained execution evidence. Offline tests,
fixed tool order, and file comparison do not replace that product judgment.

## Authority and baseline

- concept revision: 47
- canonical input:
  `/tmp/planner-inputs/henji-gate-1-general-agent-production-acceptance-preparation.md`
- input SHA-256: `ce16f0fd67178373b62a7e51c673d999feb76d124db33af5e970597ee32d8a73`
- D0 product baseline: `591fe6f53dbdaa543653fc8b326a7bec7a7b3812`
- gate identity: `gate1-general-agent-production-acceptance-r47-591fe6f-20260902`

At planning start, HEAD matched the D0 baseline, tracked files were clean, and only user-owned
untracked `_refs/*` were present. This plan does not authorize execution. After the plan is recorded
in a clean commit, preflight records that exact plan-containing HEAD and proves that product paths
remain identical to the D0 baseline.

## Fixed execution boundary

- workspace: `/tmp/henji-gate1-general-agent-production-acceptance`
- workspace partition digest:
  `11a050e529be10802e4e74b88da8d1a0b37bddd965b68b6191e708c586114cd8`
- state root: `/home/masat.guest/.local/state/henji-harness`
- fresh state namespace:
  `/home/masat.guest/.local/state/henji-harness/11a050e529be10802e4e74b88da8d1a0b37bddd965b68b6191e708c586114cd8`
- production command: installed bare `/home/masat.guest/.local/bin/henji`
- selected Definition: omitted selector, therefore `default`
- accepted parent turns: exactly three
- planner delegation: exactly one in Turn 1; zero in Turns 2 and 3

Permitted local effects are only `brief.txt` and `release-note.md` in the fresh workspace, the one
fresh workspace-partitioned session/evidence/diagnostic namespace, and the installed launcher's
request-time read of the existing credential. The credential value is never displayed or stored.
The tools must not change the repository, installed launcher, previous acceptance workspaces/state,
or other filesystem locations.

## Consumption and stop states

```text
planned_unapproved
  -> explicit Human Gate approval
     -> approved_unconsumed
        -> pre-submit failure: stopped_unconsumed
        -> Turn 1 accepted by TUI: consumed_in_progress
           -> first failure/cancel/bound/wrong-effect/evidence failure: stopped_consumed
           -> Turn 1 -> Turn 2 -> exit -> continue -> Turn 3 -> readback
              -> completed_pending_human_judgment
                 -> accepted | rejected
```

Turn 1 acceptance consumes the Gate even if the first provider request has not yet begun. After any
failure, cancellation, wrong file effect, request-bound violation, or evidence failure, do not
submit the pending or next turn. Application retry, fallback, rerun, model/provider switch, and
additional turns remain zero. Retain the fresh workspace and state for diagnosis.

## Current runtime and official provider contract

Current source declares:

- model `google/gemini-3.7-flash`;
- `POST https://openrouter.ai/api/v1/chat/completions` in production SSE mode;
- 1,024 maximum completion tokens per application request;
- parent and planner `maxSteps` of eight;
- per accepted turn request lanes of parent 8, planner child 8, aggregate 16;
- default read/write/edit/bash/planner capabilities and read-only nonrecursive planner capability.

Official OpenRouter sources checked on 2026-09-02:

- [Gemini 3.7 Flash model and price](https://openrouter.ai/google/gemini-3.7-flash): model ID,
  tool calling, USD 0.75/M input and USD 3.75/M output;
- [Chat Completions API](https://openrouter.ai/docs/api/api-reference/chat/create-a-chat-completion):
  endpoint and streaming/non-streaming support;
- [Tool calling](https://openrouter.ai/docs/guides/features/tool-calling): assistant tool request,
  client execution, tool-result reinsertion, and subsequent completion;
- [Usage accounting](https://openrouter.ai/docs/cookbook/administration/usage-accounting): provider
  usage/cost reporting.

OpenRouter may route one application request between upstream providers. Record any routing metadata
separately; it is not a Henji retry or an additional application request.

### Request and cost ceiling

```text
3 parent turns x 8 parent requests = 24
1 planner consultation x 8 child requests = 8
maximum application requests = 32

77,824 input tokens x USD 0.75/M = USD 0.058368/request
 1,024 output tokens x USD 3.75/M = USD 0.003840/request
per-request source-bound maximum      = USD 0.062208
32-request theoretical maximum        = USD 1.990656
Human Gate ceiling                    = USD 2.00
```

USD 2.00 is a worst-case authorization ceiling, not the expected charge: it assumes every one of 32
requests reaches both the full conservative input bound and full completion bound. The prior FR1
proof cost USD 0.0055785 for six requests; this task's likely cost is still expected to be cents,
though multi-turn history makes direct per-request extrapolation non-authoritative.

Immediately before seeking execution approval, recheck the four official pages and current source.
If the model/tool/endpoint/SSE contract differs, the source-derived request maximum exceeds 32, or
the recalculated ceiling exceeds USD 2.00, stop and return to the user without expanding the bound.

## Provider-free preflight before Human Gate

Do not read the credential and do not probe the completion endpoint. From the repository:

```sh
cd -- /home/masat.guest/src/henji-harness

gate1_head=$(git rev-parse HEAD)
test -z "$(git status --short --untracked-files=no)"
git diff --quiet 591fe6f53dbdaa543653fc8b326a7bec7a7b3812 -- \
  v0 tests/v0 deno.v0.json README.md

test "$(command -v henji)" = /home/masat.guest/.local/bin/henji
test "$(sha256sum v0/agent/henji_machine_launcher.sh | awk '{print $1}')" = \
  2e45157491bdac8c0de52ab56116111d00077152665021135324e1602a69dcf6
v0/agent/install_henji_machine_launcher.sh check

gate1_workspace=/tmp/henji-gate1-general-agent-production-acceptance
gate1_namespace=/home/masat.guest/.local/state/henji-harness/11a050e529be10802e4e74b88da8d1a0b37bddd965b68b6191e708c586114cd8
test ! -e "$gate1_workspace"
test ! -e "$gate1_namespace"
```

Record `gate1_head`; it must be the clean plan-containing commit. Confirm from current source that
the omitted selector resolves to post-D0 `default`, parent/planner limits are eight, the delegated
planner uses the common Definition/manifest/materialization path, and the planner has no mutation or
recursive delegation tool. Do not inspect previous acceptance contents; the distinct workspace
partition leaves them unchanged.

If all checks pass, present the user with the exact command, three prompts, maximum 32 application
requests, USD 2.00 theoretical ceiling, permitted effects, and stop-on-first-failure rule. Stop for
one explicit Human Gate approval.

That approval covers setup, credential read, provider requests, exactly three prompts, one normal
restart, and read-only result evidence. It does not cover retries, cleanup, launcher changes,
product/test changes, extra turns, another model/provider, commit, or release activity.

## Post-approval setup

After approval and before launching the TUI:

```sh
umask 077
gate1_workspace=/tmp/henji-gate1-general-agent-production-acceptance
gate1_namespace=/home/masat.guest/.local/state/henji-harness/11a050e529be10802e4e74b88da8d1a0b37bddd965b68b6191e708c586114cd8
test ! -e "$gate1_workspace"
test ! -e "$gate1_namespace"
mkdir -- "$gate1_workspace"

printf '%s\n' \
  'Title: Neighborhood release note' \
  'Audience: maintainers' \
  'Decision: Publish only after the checklist is verified.' \
  'Owner: Masato' \
  > "$gate1_workspace/brief.txt"

cd -- "$gate1_workspace"
test "$(pwd -P)" = "$gate1_workspace"
henji diagnostics evidence list
henji diagnostics list
/home/masat.guest/src/henji-harness/v0/agent/session_cli_launcher.sh list
```

The three readbacks must be empty. If not, stop without deleting anything. Launch exactly:

```sh
cd -- /tmp/henji-gate1-general-agent-production-acceptance
henji
```

Confirm the startup screen shows the fixed physical workspace, agent `default`, new persistent
session, and ready turn 0. Record the full session UUID. If startup is wrong, exit without submitting;
the Gate remains unconsumed.

## Turn 1 — planner-assisted initial implementation

Submit exactly once:

```text
このworkspace内だけで、小さなrelease-day field guideを作ってください。brief.txtを読み、built-in plannerへこの作業の文書構成と検証方法を必ずちょうど一回だけ相談してください。そのplanner結果を踏まえ、parent agentがrelease-note.mdを新規作成してください。最初は末尾を「Status: DRAFT」とし、次の内容にしてください。

# Neighborhood release note
Audience: maintainers
Decision: Publish only after the checklist is verified.
Checklist:
- Confirm the brief was read.
- Verify this note matches the brief.
Status: DRAFT

作成後にrelease-note.mdを読み返し、「Status: DRAFT」だけを「Status: READY」へeditし、Bashでtitle、audience、decision、Checklist二項目、READY状態が揃うことを検証してください。plannerはworkspaceを変更せず、再帰delegationもしないでください。最後に作業内容と検証結果を短く報告してください。
```

The TUI accepting this input consumes the Gate. Observe, without interrupting normal progress:

- real assistant streaming and tool activity/results;
- parent read of `brief.txt`;
- exactly one successful `delegate_to_planner` and planner result reinsertion;
- planner workspace mutations zero;
- parent write/read/edit/bash completion, without prescribing an exact tool-call order;
- settled assistant final, ready state, committed Turn 1, request count, and evidence ID.

Expected `release-note.md` after Turn 1:

```text
# Neighborhood release note
Audience: maintainers
Decision: Publish only after the checklist is verified.
Checklist:
- Confirm the brief was read.
- Verify this note matches the brief.
Status: READY
```

Record the session UUID, parent/planner request counts, planner call count, evidence ID, and file.
Any mismatch stops the Gate before Turn 2.

## Turn 2 — same-session follow-up

Submit exactly:

```text
同じsessionで、先ほど作った文書を引き継いでください。Audienceの直後に「Owner: Masato」を追加し、Checklistの二つ目を「- Verify title, audience, owner, decision, and status.」へ更新してください。plannerは呼ばず、文書を読み、編集し、Bashで更新内容とStatusがREADYのままであることを確認してから、短く結果を報告してください。
```

Expected file:

```text
# Neighborhood release note
Audience: maintainers
Owner: Masato
Decision: Publish only after the checklist is verified.
Checklist:
- Confirm the brief was read.
- Verify title, audience, owner, decision, and status.
Status: READY
```

Confirm the model used committed Turn 1 context instead of recreating the task, planner call total
remains one, read/edit/bash and tool-result reinsertion complete, and Turn 2 settles and commits.

## Normal exit, restart, and history

With an empty editor and no pending lane, press Ctrl-D. Require exit status 0 and normal terminal
restoration. From the same workspace run:

```sh
/home/masat.guest/src/henji-harness/v0/agent/session_cli_launcher.sh list
henji diagnostics evidence list
henji diagnostics list
```

Expect exactly one session with the recorded UUID and two committed turns, two evidence artifacts,
and no failure diagnostics. Restart exactly:

```sh
cd -- /tmp/henji-gate1-general-agent-production-acceptance
henji --continue
```

Confirm the same UUID, agent `default`, committed turn 2, restored causal log, and ready state. Open
Ctrl-T history and directly confirm both user prompts, assistant finals, and causal tool call/results;
close it with Esc. History viewing must make no provider request. If restoration fails, do not submit
Turn 3.

## Turn 3 — resumed continuation

Submit exactly:

```text
再開前の文脈を使って、先ほどの文書を仕上げてください。Checklistの末尾に「- Share the note with maintainers.」を一項目追加してください。plannerは呼ばず、対象文書を読み、編集し、Bashで追加項目とREADY状態を確認してから、短く結果を報告してください。
```

The file name and previous full content are intentionally omitted; the model must use restored
history to identify the continuing work. Expected final file:

```text
# Neighborhood release note
Audience: maintainers
Owner: Masato
Decision: Publish only after the checklist is verified.
Checklist:
- Confirm the brief was read.
- Verify title, audience, owner, decision, and status.
- Share the note with maintainers.
Status: READY
```

Confirm same session, settled final, committed Turn 3, planner call total one, request count, and
evidence ID. Exit once with Ctrl-D and require exit status 0 and terminal restoration.

## Final product and session readback

```sh
cd -- /tmp/henji-gate1-general-agent-production-acceptance

printf '%s\n' \
  'Title: Neighborhood release note' \
  'Audience: maintainers' \
  'Decision: Publish only after the checklist is verified.' \
  'Owner: Masato' \
  | cmp - -- brief.txt

printf '%s\n' \
  '# Neighborhood release note' \
  'Audience: maintainers' \
  'Owner: Masato' \
  'Decision: Publish only after the checklist is verified.' \
  'Checklist:' \
  '- Confirm the brief was read.' \
  '- Verify title, audience, owner, decision, and status.' \
  '- Share the note with maintainers.' \
  'Status: READY' \
  | cmp - -- release-note.md

test "$(find . -mindepth 1 -maxdepth 1 -printf '%f\n' | LC_ALL=C sort)" = \
"brief.txt
release-note.md"

/home/masat.guest/src/henji-harness/v0/agent/session_cli_launcher.sh list
henji diagnostics evidence list
henji diagnostics list
```

Expect the same UUID and three committed turns, three evidence artifacts, and no success-path
diagnostics. Read-only compare the repository tracked state and launcher identity to preflight.

## Provider evidence and accounting

Open each displayed turn evidence ID once:

```sh
henji diagnostics evidence show --id <turn-1-evidence-id>
henji diagnostics evidence show --id <turn-2-evidence-id>
henji diagnostics evidence show --id <turn-3-evidence-id>
```

Read back and record:

- Turn 1 parent and planner lanes, with exactly one delegation; Turn 2/3 parent lane only;
- ordinal/model step, serialized request, HTTP status/response headers, raw response bytes, ordered
  SSE, accounting frame, parser transitions, model/tool/result/outcome order;
- planner result followed by continuing parent execution;
- per-turn display count equals the corresponding artifact request count;
- first-process runtime count covers Turns 1+2, restarted-process runtime count covers Turn 3;
- all three artifact counts total 1–32;
- provider-reported tokens and cost when present; do not invent missing values;
- no credential, request-header collection, or Authorization field/value in capture input, while
  response/provider/parser/tool/runtime evidence remains readable.

Do not query another API to explain OpenRouter routing metadata.

## Acceptance decision

Gate 1 is accepted only if all of the following are true:

1. Installed post-D0 `henji` completes all three turns with real streaming, settled finals, and
   commits.
2. Exactly one planner consultation succeeds, mutates nothing, and its result returns to the parent.
3. Parent read/write/edit/bash and tool-result reinsertion create the expected files.
4. Turn 2 uses Turn 1; restarted Turn 3 uses restored Turn 1/2 history.
5. Both exits restore the terminal; `--continue`, same UUID, and Ctrl-T history succeed.
6. Display/session/evidence request accounting agrees, totals at most 32, and retry/fallback/
   resubmission/rerun/additional turns are zero.
7. Three durable artifacts provide the raw request/SSE/parser/tool/runtime evidence.
8. Local effects remain within the fixed workspace and state namespace.
9. The user directly accepts the general-agent production result.

## Failure branch

At the first failure, cancellation, mismatch, bound violation, or evidence problem:

- submit no pending or subsequent turn and make no retry/fallback/rerun/model switch;
- let active work settle, then exit normally if possible;
- retain workspace, state, session, evidence, and diagnostics;
- read the displayed evidence or diagnostic ID once and report the exact HTTP/SSE/parser/tool/runtime
  event, request count, committed turns, and actual files;
- distinguish an evaluable product failure from a non-evaluable evidence durability/readback failure;
- do not modify code/tests, launcher, credential, or retained data.

## Completion record and stop

After execution, record the consumed state, exact observed counts/cost/effects/evidence, and the
user's decision in `docs/plans/gate-1-general-agent-production-acceptance-results.md`, `AGENTS.md`,
and `.handoff/handoff.md` once. Raw provider bodies remain only in the evidence artifact.

If accepted, FR2–FR4 and Gate 1 are complete; next is FR5 integrated human UI candidate assessment.
If failed, return only the evidence-backed Gate 1 product gap for separate authorization. Do not
automatically begin D1, FR5 redesign, FR6, Gate 2, cleanup, code/test changes, provider retry,
launcher changes, dependency/lockfile work, `_refs/*`, commit, push, tag, publish, or release.

Stop now before the Human Gate.
