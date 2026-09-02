# Step 83 full-capability Human Gate retry — execution package

Status: **CONSUMED — Turn 1 diagnosed failure; no retry**

The user explicitly authorized final execution on 2026-09-02. The launcher update and preflight
succeeded. Exact Turn 1 was accepted once and failed after one provider request with the retained
diagnostic recorded below; Turns 2 and 3 were not attempted.

Repository implementation completed locally. The user later supplied the separate final execution
authorization; the pinned execution below is now a consumed historical record and must not be run
again.

This is the distinct revision-42 conditional retry package. It does not inherit
authority from the consumed old gate. Repository implementation, review,
authoritative offline verification, pinned integration identity, final model,
API, and price refresh, and a separate final execution approval are all required
before any command below may run.

## Fixed identity and bounds

- workspace: `/tmp/henji-step83-full-capability-acceptance-r2`
- expected file: `/tmp/henji-step83-full-capability-expected-r2`
- workspace namespace digest:
  `040610e64dc39b08a9f9ac3f300c4c9f435357014e31449cb834b2cefc0a51bd`
- production state root: `/home/masat.guest/.local/state/henji-harness`
- complete new namespace:
  `/home/masat.guest/.local/state/henji-harness/040610e64dc39b08a9f9ac3f300c4c9f435357014e31449cb834b2cefc0a51bd`
- machine command: installed `/home/masat.guest/.local/bin/henji`
- agent/session: default Agent, persistent new session, then same-session
  `--continue`
- parent/planner maximum: 8/8 requests per accepted turn, aggregate 16
- accepted turns: exactly 3 conditional turns
- application request maximum: 48
- inference authorization ceiling: USD 3.10
- Henji retry, fallback, rerun, model/provider switch, extra follow-up, context
  compaction: 0
- cleanup during this package: 0

The values below were pinned before execution. Any future value change requires
a distinct new package and authorization.

```text
integration HEAD: 7b8f0d797d45c4345391520017475df13f9f5802
canonical launcher SHA-256: 2e45157491bdac8c0de52ab56116111d00077152665021135324e1602a69dcf6
installed pre-update SHA-256: 0fc6bba0de3d5e6ba7701355b6cf12752b7bfad8e5f31d048f666a4abfb0d95e
retry backup SHA-256 after update: 0fc6bba0de3d5e6ba7701355b6cf12752b7bfad8e5f31d048f666a4abfb0d95e
model: google/gemini-3.7-flash
endpoint: POST https://openrouter.ai/api/v1/chat/completions
price: USD 0.75/M input, USD 3.75/M output
price verified at: 2026-09-02 11:34 JST
```

Official sources:

- <https://openrouter.ai/google/gemini-3.7-flash>
- <https://openrouter.ai/docs/api/api-reference/chat/send-chat-completion-request>

## Safety and consumption

This is the real trusted-local default Agent. `read`, `write`, `edit`, and
unsandboxed OS-user Bash may reach outside the workspace; planner delegation is
available once per accepted turn. The task limits intended effects to the fixed
workspace, and the operator watches every stream/tool/result. No observed
out-of-scope effect is allowed; this package is not a hard filesystem sandbox.

Preflight, one launcher update/readback, workspace setup, startup, and F1 do not
consume the gate. Acceptance of exact Turn 1 consumes it. After consumption, any
failure/cancellation/bound violation stops the workflow without resubmission,
restart, fallback, later turn, fix, or cleanup.

Stop before submission on identity drift, wrong workspace, agent, or session,
raw credential, header, or payload display, unexpected external or destructive
activity, request or cost bound drift, model, API, or price change, diagnostic
preflight error, or terminal failure. Preserve all state.

## Final provider-free preflight

The final approval must include these exact operations. Do not run them from
this draft.

1. Confirm reviewed HEAD/worktree and refresh official model/API/pricing.
2. Resolve and pin the absolute production state root. Require the complete new
   digest namespace, workspace, expected file, retry backup, and retry recovery
   absent.
3. Record but do not modify the old workspace and original backup identity.
4. Run the repository-owned installer `update-retry` exactly once.
5. Run installer `check`; read back canonical/target/retry-backup SHA, type,
   0755 mode, and owner.
6. On update failure, inspect bounded state. Only if the retry backup is valid
   and target is not the canonical source may the approved package run
   `rollback-retry` once, then stop unconsumed.

Planned exact machine commands after implementation and final approval:

```sh
cd -- /home/masat.guest/src/henji-harness
v0/agent/install_henji_machine_launcher.sh update-retry
v0/agent/install_henji_machine_launcher.sh check
```

The old `install` and old `rollback` are forbidden for this retry.

## Fresh workspace setup

Run only after machine readback succeeds:

```sh
umask 077
henji_retry_workspace=/tmp/henji-step83-full-capability-acceptance-r2
henji_retry_expected=/tmp/henji-step83-full-capability-expected-r2
henji_retry_state_namespace='/home/masat.guest/.local/state/henji-harness/040610e64dc39b08a9f9ac3f300c4c9f435357014e31449cb834b2cefc0a51bd'
[ ! -e "$henji_retry_workspace" ]
[ ! -e "$henji_retry_expected" ]
[ ! -e "$henji_retry_state_namespace" ]
mkdir -m 0700 -- "$henji_retry_workspace"
printf '%s\n' \
  'Project: Henji acceptance retry' \
  'Owner: Masato' \
  'Status: draft' \
  > "$henji_retry_workspace/request.txt"
chmod 0600 -- "$henji_retry_workspace/request.txt"
test "$(stat -c '%a' -- "$henji_retry_workspace")" = 700
test "$(stat -c '%a' -- "$henji_retry_workspace/request.txt")" = 600
cd -- "$henji_retry_workspace"
test "$(pwd -P)" = "$henji_retry_workspace"
test "$(command -v henji)" = /home/masat.guest/.local/bin/henji
henji_retry_diagnostic_baseline=$(henji diagnostics list) || exit 1
test "$henji_retry_diagnostic_baseline" = '{"schemaVersion":1,"diagnostics":[]}'
```

The diagnostic list must be an exact valid empty result for this new namespace
and must not read a credential or initialize provider, tool, session, or context
state. Stop on any record/error.

Record the exact preflight output as `henji_retry_diagnostic_baseline`; it must be
`{"schemaVersion":1,"diagnostics":[]}`. This value is used by the final guarded
read-only assertions below.

Start installed bare `henji`. Confirm exact workspace, default Agent, new
persistent session, and ready turn 0. Open and dismiss F1 once. It must explain
request-time credential use, trusted-local tools, stream/results, cancellation,
exit/restart, sessions/history/context, and diagnostics without showing a
credential value, Authorization header, raw payload, or unexpected path.

## Turn 1

Enter exactly once:

```text
このworkspace内だけで作業してください。request.txtを読み、その内容からacceptance-note.mdを新規作成してください。文書は「# Henji acceptance」「Owner: Masato」「Status: draft」「Check: pending」の4行にします。作成後にそのfileを読み返し、「Status: draft」だけを「Status: READY」へ編集し、Bashで4行がその順序・完全一致であることを検証してください。必要ならplannerに相談して構いません。行ったことと検証結果を短く報告してください。workspace外は変更しないでください。
```

Success requires meaningful read/create/edit/Bash activity, visible stream/tool
results, settled final, committed Turn 1, one immutable `requests> turn=1` line
with actual 1..16, no observed out-of-scope effect, and this exact regular file:

```text
# Henji acceptance
Owner: Masato
Status: READY
Check: pending
```

The unchanged input must also pass:

```sh
printf '%s\n' \
  'Project: Henji acceptance retry' \
  'Owner: Masato' \
  'Status: draft' \
  | cmp - -- request.txt
```

Record `turn1_actual=<N>`. On failure/cancel/bound violation, do not resubmit;
use the failure branch. On success, perform read-only file/count assertions and
continue directly to Turn 2.

## Turn 2

Enter exactly once:

```text
同じacceptance-note.mdの「Check: pending」だけを「Check: passed」へ変更し、Bashでもう一度4行の完全一致を確認してください。ほかのfileや行は変更せず、結果を短く報告してください。
```

Success requires settled final, committed Turn 2, one immutable request line
with actual 1..16, only the requested line change, exact `Check: passed`, and
the same literal `request.txt` comparison. Record `turn2_actual=<N>` and require
the same-process runtime cumulative to equal `turn1_actual + turn2_actual`.

On success, confirm an empty editor, press Ctrl-D, and require exit 0 and
terminal restoration. On failure, use the failure branch and do not run Turn 3.

Before pressing Ctrl-D, identify the only session through the repository-owned
metadata CLI and record the printed UUID. The parser is intentionally strict:
it accepts exactly one default session with `turnCount: 2`; do not type or
guess a UUID.

```sh
henji_retry_session_before_continue_json=$(
  /home/masat.guest/src/henji-harness/v0/agent/session_cli_launcher.sh list
)
henji_retry_session_before_continue_uuid=$(
  printf '%s\n' "$henji_retry_session_before_continue_json" |
    /home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno eval --no-remote '
      const value = JSON.parse(await new Response(Deno.stdin.readable).text());
      const row = Object.keys(value).join("\u001f") === "schemaVersion\u001fsessions" &&
        value.schemaVersion === 1 && Array.isArray(value.sessions) &&
        value.sessions.length === 1 ? value.sessions[0] : undefined;
      if (row === undefined || row.agent !== "default" || row.turnCount !== 2) Deno.exit(1);
      if (typeof row.id !== "string" ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(row.id)) Deno.exit(1);
      console.log(row.id);
    '
)
printf '%s\n' "session_before_continue=$henji_retry_session_before_continue_uuid"
```

Preserve that printed UUID as `henji_retry_session_before_continue_uuid` for
the final assertions; it is compared with a newly parsed post-Turn-3 UUID.

## Continue and Turn 3

After successful Turn 2 exit:

```sh
cd -- /tmp/henji-step83-full-capability-acceptance-r2
henji --continue
```

Confirm the same default Agent/session and restored committed Turns 1 and 2.
Then enter exactly once:

```text
前の作業を続けます。acceptance-note.mdを読み、末尾へ新しい1行「Resumed: yes」を追加してください。Bashで全5行が順序・完全一致であることを確認し、再開前の作業を引き継げたか短く報告してください。workspace外は変更しないでください。
```

Success requires settled final, committed Turn 3, one immutable request line
with actual 1..16, same-session canonical history, no observed out-of-scope
effect, the same literal `request.txt` comparison, and:

```text
# Henji acceptance
Owner: Masato
Status: READY
Check: passed
Resumed: yes
```

Record `turn3_actual=<N>`. Its runtime cumulative restarts with the new process
and must equal `turn3_actual`. Press Ctrl-D and require exit 0 and terminal
restoration.

## Failure branch

At the first failure/cancel/bound violation:

1. send no more input or provider request;
2. record the complete retained `failure>` line and same-turn `requests>` line;
3. require the diagnostic occurrence count to equal the same turn's terminal
   actual count; treat any mismatch or wrong-turn correlation as non-evaluable;
4. discard pending input only through the normal confirmed Ctrl-D path and
   restore the terminal;
5. use the displayed ID, never a guessed latest ID:

```sh
cd -- /tmp/henji-step83-full-capability-acceptance-r2
henji diagnostics show --id '<DISPLAYED_UUID>'
```

6. compare exact live/durable fields and verify no credential/header/raw
   payload/private text;
7. inspect new workspace files, exact committed-turn prefix, session/context,
   selected lock/temp, already-recorded request counts, and diagnostic state
   read-only;
8. record `evaluable diagnosed failure` or `non-evaluable diagnostic failure`;
9. retain workspace/state/diagnostic/expected path and stop. Do not fix, retry,
   clean, or decide UX adoption from a non-evaluable failure.

Diagnostic persistence failure retains the live record and fixed store error but
is non-evaluable.

## Success assertions and decision

After successful Turn 3, set the three observed values and validate their
arithmetic:

```sh
turn1_actual='<RECORDED_TURN_1_COUNT>'
turn2_actual='<RECORDED_TURN_2_COUNT>'
turn3_actual='<RECORDED_TURN_3_COUNT>'
case "$turn1_actual:$turn2_actual:$turn3_actual" in
  *[!0-9:]*|'') exit 1 ;;
esac
test "$turn1_actual" -ge 1 && test "$turn1_actual" -le 16
test "$turn2_actual" -ge 1 && test "$turn2_actual" -le 16
test "$turn3_actual" -ge 1 && test "$turn3_actual" -le 16
henji_retry_total=$((turn1_actual + turn2_actual + turn3_actual))
test "$henji_retry_total" -ge 1 && test "$henji_retry_total" -le 48
```

Identify the one session UUID from repository-owned session listing; never guess
it. Confirm exactly three committed turns and the same resumed session. Create
the expected file once, then run the following literal guarded, read-only
assertion block. It compares exact bytes, confirms top-level entries, selected
lock/temp absence, and proves there is no new failure diagnostic relative to
the preflight baseline. The block never deletes the session, diagnostic, or
workspace.

```sh
printf '%s\n' \
  '# Henji acceptance' \
  'Owner: Masato' \
  'Status: READY' \
  'Check: passed' \
  'Resumed: yes' \
  > "$henji_retry_expected"
chmod 0600 -- "$henji_retry_expected"
```

```sh
henji_retry_ok=1
henji_retry_entries=$(find -- "$henji_retry_workspace" -mindepth 1 -maxdepth 1 -printf '%f\n' | sort) || henji_retry_ok=0
test "$henji_retry_entries" = "$(printf '%s\n' acceptance-note.md request.txt)" || henji_retry_ok=0
cmp -s -- "$henji_retry_expected" "$henji_retry_workspace/acceptance-note.md" || henji_retry_ok=0
test -z "$(find -- "$henji_retry_workspace" -maxdepth 1 \( -name '*.lock' -o -name '*.tmp*' \) -print)" || henji_retry_ok=0
test -f "$henji_retry_expected" || henji_retry_ok=0

if test "$henji_retry_ok" -eq 1; then
  henji_retry_session_after_json=$(
    /home/masat.guest/src/henji-harness/v0/agent/session_cli_launcher.sh list
  ) || henji_retry_ok=0
  henji_retry_session_after=$(
    printf '%s\n' "$henji_retry_session_after_json" |
      /home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno eval --no-remote '
        const expectedTurns = Number(Deno.args[0]);
        const value = JSON.parse(await new Response(Deno.stdin.readable).text());
        if (Object.keys(value).join("\u001f") !== "schemaVersion\u001fsessions" ||
          value.schemaVersion !== 1 || !Array.isArray(value.sessions) || value.sessions.length !== 1) Deno.exit(1);
        const row = value.sessions[0];
        const keys = Object.keys(row).join("\u001f");
        if (keys !== "id\u001fagent\u001fcreatedAt\u001fupdatedAt\u001fturnCount\u001fmessageCount") Deno.exit(1);
        if (row.agent !== "default" || row.turnCount !== expectedTurns ||
          typeof row.messageCount !== "number" || !Number.isSafeInteger(row.messageCount) || row.messageCount <= 0) Deno.exit(1);
        if (typeof row.id !== "string" ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(row.id)) Deno.exit(1);
        console.log(`${row.id}\t${row.agent}\t${row.turnCount}\t${row.messageCount}`);
      ' 3
  ) || henji_retry_ok=0
  henji_retry_session_after_uuid=$(printf '%s\n' "$henji_retry_session_after" | cut -f1) || henji_retry_ok=0
  test "$henji_retry_session_after_uuid" = "$henji_retry_session_before_continue_uuid" || henji_retry_ok=0
  test "$(printf '%s\n' "$henji_retry_session_after" | cut -f3)" = 3 || henji_retry_ok=0
fi

if test "$henji_retry_ok" -eq 1; then
  henji_retry_diagnostics=$(henji diagnostics list) || henji_retry_ok=0
  test "$henji_retry_diagnostics" = "$henji_retry_diagnostic_baseline" || henji_retry_ok=0
  test -d "$henji_retry_state_namespace/sessions/$henji_retry_session_after_uuid" || henji_retry_ok=0
  test ! -e "$henji_retry_state_namespace/locks/$henji_retry_session_after_uuid.lock" || henji_retry_ok=0
  test ! -e "$henji_retry_state_namespace/contexts/$henji_retry_session_after_uuid.json" || henji_retry_ok=0
  test -z "$(find -- "$henji_retry_state_namespace/sessions/$henji_retry_session_after_uuid" -mindepth 1 -maxdepth 1 -name '.tmp-*' -print)" || henji_retry_ok=0
fi

if test "$henji_retry_ok" -ne 1; then
  printf '%s\n' 'retry success assertions failed; preserving workspace, session, and diagnostic state' >&2
  exit 1
fi
```

Any mismatch preserves all state and stops without cleanup.

## Provider-free implementation readiness

The repository-only implementation and focused verification are recorded in
[`step-83-full-capability-human-acceptance-retry-results.md`](step-83-full-capability-human-acceptance-retry-results.md).
No command in this draft is authorized by that local evidence. In particular, do not resolve a
production state root, invoke either retry installer command against the fixed machine target,
read a credential, start `henji`, contact a provider, create the r2 workspace, or consume the
three-turn gate until the final package has reviewed identities and explicit execution approval.

Only after all assertions succeed, ask the user once:

1. `採用可能`
2. `方向は有望だがnamed blockerあり`
3. `不採用`

Do not infer this decision from test counts or mechanical success. After
recording the decision, still retain the new workspace, expected file,
session/context namespace, diagnostic baseline, retry backup, and launcher
evidence. Cleanup is a separate explicit approval.
