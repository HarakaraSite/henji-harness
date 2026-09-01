# Step 83 full-capability Human Gate

Status: **separate final Human Gate consumed; Turn 1 failure is non-evaluable; no retry**

The approved one-shot execution on 2026-09-01 stopped after the exact Turn 1 submission returned
`contract_failure`. Turn 2, Continue/Turn 3, assertions, session deletion, and cleanup were not run.
The insufficient evidence and overprotection finding are recorded in
[step-83-full-capability-human-acceptance-results.md](step-83-full-capability-human-acceptance-results.md).
This package is retained as the execution contract and does not authorize a retry or rerun.
Its original three-way decision requirement cannot be applied because the implementation discarded
the sanitized failure classification and request-count evidence needed for a meaningful judgment.

This is the single real-screen acceptance package for the continuation. It must be run with the
installed `/home/masat.guest/.local/bin/henji` after implementation review and machine launcher
readback. It is not a fake-host fixture and must not be replaced by `agent:tui` or a provider-free
task.

## Safety and bounds

The command uses the default Agent with the full trusted-local registry: workspace read/create/edit,
Bash verification, `submit_json_result`, and optional planner delegation. Tools execute as the OS
user and may reach outside the workspace or the network. The task explicitly limits intended work to
the acceptance workspace; inspect every tool result and stop on any out-of-scope effect.

- parent max steps: 8
- planner child max steps: 8
- aggregate requests per accepted turn: 16
- accepted turns: exactly 3
- total model/provider requests: at most 48
- planner delegation: at most once per turn
- retry, fallback, rerun, and additional follow-up: 0
- context compaction: 0

Stop without retry on launcher drift, workspace/agent/session mismatch, credential/path/raw secret
display, external or destructive activity, a bound or turn failure, uncommitted results, unexpected
tool/file state, terminal restoration failure, or lock/temp residue. Preserve the workspace for
diagnosis when stopped.

The acceptance has exactly three accepted tasks: Turn 1, Turn 2, and Continue/Turn 3 below. The
launcher must remain the installed `henji` command; do not substitute a fixture or test command.
The complete run is bounded to 48 requests, with no retry, fallback, rerun, or additional follow-up.

## Execution preflight refreshed 2026-09-01

The fixed profile uses `google/gemini-3.7-flash` through OpenRouter
`POST /api/v1/chat/completions`. The official OpenRouter model page currently lists two serving
providers, tool calling, a 1,048,576-token context window, and prices of USD 0.75 per million input
tokens and USD 3.75 per million output tokens.

The runtime bounds each request to the existing conservative maximum of 77,824 input tokens and
1,024 completion tokens. At the current prices the inference ceiling is:

```text
per request = 77,824 × 0.75 / 1,000,000 + 1,024 × 3.75 / 1,000,000
            = USD 0.062208
48 requests = USD 2.985984
```

This is an inference-cost ceiling, not a prediction of typical cost. Existing OpenRouter credits
may already cover it; purchasing new credits can have a separate platform payment fee. Stop before
launch if the model page, endpoint contract, or displayed prices no longer match these values.

Official references:

- <https://openrouter.ai/google/gemini-3.7-flash>
- <https://openrouter.ai/docs/api/api-reference/chat/send-chat-completion-request>
- <https://openrouter.ai/docs/faq>

## Setup and launch

Run from a terminal with the credential already configured by the host. Do not print or inspect the
credential value.

```sh
umask 077
henji_accept_workspace=/tmp/henji-step83-full-capability-acceptance
henji_accept_expected=/tmp/henji-step83-full-capability-expected
[ ! -e "$henji_accept_workspace" ]
[ ! -e "$henji_accept_expected" ]
mkdir -- "$henji_accept_workspace"
printf '%s\n' \
  'Project: Henji acceptance' \
  'Owner: Masato' \
  'Status: draft' \
  > "$henji_accept_workspace/request.txt"
cd -- "$henji_accept_workspace"
test "$(pwd -P)" = "$henji_accept_workspace"
test "$(command -v henji)" = /home/masat.guest/.local/bin/henji
henji
```

The startup screen must identify this workspace and default session, and F1 must make the task,
stream/tool/final, steering/follow-up, cancellation, exit/restart, session/history/context,
capabilities, and trusted-local authority understandable. Open and dismiss F1 once before sending
the task. Stop if the screen shows a secret, credential path, raw error, wrong workspace, or an
unexpected agent/session.

## Turn 1

Enter exactly:

```text
このworkspace内だけで作業してください。request.txtを読み、その内容からacceptance-note.mdを新規作成してください。文書は「# Henji acceptance」「Owner: Masato」「Status: draft」「Check: pending」の4行にします。作成後にそのfileを読み返し、「Status: draft」だけを「Status: READY」へ編集し、Bashで4行がその順序・完全一致であることを検証してください。必要ならplannerに相談して構いません。行ったことと検証結果を短く報告してください。workspace外は変更しないでください。
```

Observe meaningful read/create/edit, Bash verification, streamed progress, tool results, and a
settled final. Do not require a particular tool order. Bash-only substitution for all file work is
a named blocker candidate because it does not demonstrate the advertised edit UX. Expected file:

```text
# Henji acceptance
Owner: Masato
Status: READY
Check: pending
```

## Turn 2

After the successful settled first turn, enter exactly:

```text
同じacceptance-note.mdの「Check: pending」だけを「Check: passed」へ変更し、Bashでもう一度4行の完全一致を確認してください。ほかのfileや行は変更せず、結果を短く報告してください。
```

Expected file is the same four lines with `Check: passed`. Confirm the completed final and empty
editor, then press Ctrl-D to exit normally. Do not retry a failed or cancelled turn.

## Continue and Turn 3

From the same acceptance workspace run:

```sh
cd -- /tmp/henji-step83-full-capability-acceptance
henji --continue
```

Confirm the same default agent/session and the first two committed turns are restored. Enter:

```text
前の作業を続けます。acceptance-note.mdを読み、末尾へ新しい1行「Resumed: yes」を追加してください。Bashで全5行が順序・完全一致であることを確認し、再開前の作業を引き継げたか短く報告してください。workspace外は変更しないでください。
```

Expected final file:

```text
# Henji acceptance
Owner: Masato
Status: READY
Check: passed
Resumed: yes
```

Confirm the resumed read, edit, Bash verification, and final. Press Ctrl-D after the settled turn.

## Session management and cleanup

From the acceptance workspace, use the repository-owned session CLI. The list must identify exactly
one current full-session UUID by workspace and metadata; do not guess or copy a UUID not shown by
the list.

```sh
cd -- /tmp/henji-step83-full-capability-acceptance
/home/masat.guest/src/henji-harness/v0/agent/session_cli_launcher.sh list
/home/masat.guest/src/henji-harness/v0/agent/session_cli_launcher.sh delete --session <SESSION_UUID> --yes
/home/masat.guest/src/henji-harness/v0/agent/session_cli_launcher.sh list
```

The post-delete list must not contain that UUID. Confirm workspace top-level entries are exactly
`acceptance-note.md` and `request.txt`; create the expected file and compare it with `diff -u`.
Stop and preserve state on another session, invalid JSON, lock/temp residue, or any mismatch.

Only after recording the single decision (`採用可能`, `方向は有望だがnamed blockerあり`, or
`不採用`) may cleanup proceed. Guard the two literal paths, move them to `/tmp` if needed for
diagnosis, remove only the workspace and expected file, and verify both are absent. Do not retry,
rerun, or invoke another provider task in this work period.

The following are literal post-run assertions. Run them after the final turn and before guarded
cleanup; replace only `<SESSION_UUID>` with the UUID printed by the preceding list command.

```sh
henji_accept_session_uuid='<SESSION_UUID>' # replace with the one UUID printed by list
if ! {
  henji_accept_ok=1
  henji_accept_entries=$(find -- "$henji_accept_workspace" -mindepth 1 -maxdepth 1 -printf '%f\n' | sort) || henji_accept_ok=0
  test "$henji_accept_entries" = "$(printf '%s\n' acceptance-note.md request.txt)" || henji_accept_ok=0
  cat > "$henji_accept_expected" <<'EOF' || henji_accept_ok=0
# Henji acceptance
Owner: Masato
Status: READY
Check: passed
Resumed: yes
EOF
  diff -u -- "$henji_accept_expected" "$henji_accept_workspace/acceptance-note.md" || henji_accept_ok=0
  test -z "$(find -- "$henji_accept_workspace" -maxdepth 1 \( -name '*.lock' -o -name '*.tmp*' \) -print)" || henji_accept_ok=0
  henji_accept_state_root="${XDG_STATE_HOME:-$HOME/.local/state}/henji-harness"
  henji_accept_workspace_digest=$(printf '%s' "$henji_accept_workspace" | sha256sum | awk '{print $1}')
  henji_accept_state_namespace="$henji_accept_state_root/$henji_accept_workspace_digest"
  # Only the selected session/workspace namespace is evidence for this run. A live index lock and
  # unrelated sessions/locks in the shared state root are not acceptance residue.
  test ! -e "$henji_accept_state_namespace/locks/$henji_accept_session_uuid.lock" || henji_accept_ok=0
  test ! -e "$henji_accept_state_namespace/sessions/$henji_accept_session_uuid" || henji_accept_ok=0
  test ! -e "$henji_accept_state_namespace/contexts/$henji_accept_session_uuid.json" || henji_accept_ok=0
  case "$henji_accept_workspace" in
    /tmp/henji-step83-full-capability-acceptance) ;;
    *) henji_accept_ok=0 ;;
  esac
  case "$henji_accept_expected" in
    /tmp/henji-step83-full-capability-expected) ;;
    *) henji_accept_ok=0 ;;
  esac
  test -d "$henji_accept_workspace" && test -f "$henji_accept_expected" || henji_accept_ok=0
  test "$henji_accept_ok" -eq 1
}; then
  printf '%s\n' 'acceptance assertions failed; preserving diagnosis state' >&2
  exit 1
fi

rm -rf -- "$henji_accept_workspace" "$henji_accept_expected"
test ! -e "$henji_accept_workspace" && test ! -e "$henji_accept_expected"
```
