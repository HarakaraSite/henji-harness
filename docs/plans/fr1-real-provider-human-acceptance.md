# FR1 real-provider human acceptance

Status: **executed once and accepted — Human Gate consumed**

## Purpose

Confirm the product through the installed production path after the FR0/FR1 stream-compatibility
repair. One human-submitted turn must reach the real OpenRouter model, complete meaningful workspace
tool work, return a settled assistant final, commit the turn, and retain the actual provider exchange
for readback.

This is not another offline test or a reactivation of the consumed Step 83 retry package. No source,
test, review, gate, launcher update, retry, fallback, later turn, or cleanup is part of this plan.

## Fixed identity and authority

- product-source baseline: `d6e737a90f95defd7d345c9b0f4b692a227bb2aa`
- execution repository identity: the clean HEAD containing this plan; record its full hash during
  preflight and require all product paths to remain identical to the baseline
- production entrypoint: `/home/masat.guest/.local/bin/henji`
- canonical wrapper: `v0/agent/henji_machine_launcher.sh`
- model: `google/gemini-3.7-flash`
- API: `POST https://openrouter.ai/api/v1/chat/completions`
- fresh workspace: `/tmp/henji-fr1-real-provider-acceptance`
- workspace namespace digest: `d3601cdc2db6293648e4d76511ec0174c81477de29eae9ff7894a5ab1efadad0`
- state namespace:
  `/home/masat.guest/.local/state/henji-harness/d3601cdc2db6293648e4d76511ec0174c81477de29eae9ff7894a5ab1efadad0`
- accepted turns: exactly one
- provider requests: product-bounded maximum 16 for the accepted turn
- inference authorization ceiling: USD 1.00
- Henji retry, fallback, resubmission, additional turn, and rerun: zero

The source profile allows at most 1,024 completion tokens per request and computes a conservative
USD 0.062208 worst case per request at USD 0.75/M input and USD 3.75/M output. Sixteen requests are
therefore bounded at USD 0.995328, rounded up to the USD 1.00 authorization ceiling. Immediately
before execution, refresh the official model page and API documentation. Stop before submission if
the model, endpoint, streaming contract, or prices have changed enough to invalidate this bound.

Official references checked during planning on 2026-09-02:

- <https://openrouter.ai/google/gemini-3.7-flash>
- <https://openrouter.ai/docs/api_reference/overview>
- <https://openrouter.ai/docs/api_reference/streaming>

## Human Gate

Execution requires one explicit approval covering only:

- read-only installed-launcher and machine identity checks;
- creation of the fixed fresh workspace and its normal persistent state namespace;
- request-time read of the existing credential without displaying or modifying it;
- production `henji`, OpenRouter network access, and one accepted human turn;
- the workspace-local read/write/edit/Bash effects requested below;
- read-only diagnostic/provider-evidence readback and results/handoff recording.

Approval does not authorize launcher installation/update/rollback, another provider turn, retry,
fallback, code changes, cleanup of old or new state, `_refs/*`, dependency changes, commit, push,
tag, publication, or release.

## Preflight before the turn

The checks and workspace setup below do not consume the provider attempt. They must not read the
credential or contact the provider.

1. Refresh the official model/API/pricing facts above and retain the USD 1.00 ceiling.
2. Record the current plan-containing HEAD. Confirm tracked cleanliness, product-source identity,
   canonical wrapper identity, installed command, and the read-only installer check:

   ```sh
   cd -- /home/masat.guest/src/henji-harness
   henji_acceptance_head=$(git rev-parse HEAD)
   test -z "$(git status --short --untracked-files=no)"
   git diff --quiet d6e737a90f95defd7d345c9b0f4b692a227bb2aa -- \
     v0 tests/v0 deno.v0.json README.md
   test "$(sha256sum v0/agent/henji_machine_launcher.sh | awk '{print $1}')" = \
     2e45157491bdac8c0de52ab56116111d00077152665021135324e1602a69dcf6
   test "$(command -v henji)" = /home/masat.guest/.local/bin/henji
   v0/agent/install_henji_machine_launcher.sh check
   ```

   Record `henji_acceptance_head` in the result. If the product-source comparison or `check` fails,
   stop. The previous one-shot installer lifecycles are consumed; this plan does not authorize an
   update or rollback.

3. Require the fixed workspace and its complete state namespace to be absent, then create only the
   workspace and seed its input:

   ```sh
   umask 077
   henji_acceptance_workspace=/tmp/henji-fr1-real-provider-acceptance
   henji_acceptance_state_namespace='/home/masat.guest/.local/state/henji-harness/d3601cdc2db6293648e4d76511ec0174c81477de29eae9ff7894a5ab1efadad0'
   test ! -e "$henji_acceptance_workspace"
   test ! -e "$henji_acceptance_state_namespace"
   mkdir -- "$henji_acceptance_workspace"
   printf '%s\n' \
     'Project: Henji acceptance retry' \
     'Owner: Masato' \
     'Status: draft' \
     > "$henji_acceptance_workspace/request.txt"
   cd -- "$henji_acceptance_workspace"
   test "$(pwd -P)" = "$henji_acceptance_workspace"
   henji diagnostics evidence list
   ```

   Evidence list must be empty for this workspace. Any existing namespace, evidence, diagnostic,
   wrong command identity, or launcher failure stops execution without a provider attempt. Preserve
   what exists; do not clean it up.

4. Start bare `henji`. Confirm the displayed workspace, default agent, new persistent session, and
   ready turn 0. Do not submit anything yet.

## The single product turn

Submitting the following text with Enter consumes the Human Gate:

```text
このworkspace内だけで作業してください。request.txtを読み、その内容からacceptance-note.mdを新規作成してください。文書は「# Henji acceptance」「Owner: Masato」「Status: draft」「Check: pending」の4行にします。作成後にそのfileを読み返し、「Status: draft」だけを「Status: READY」へ編集し、Bashで4行がその順序・完全一致であることを検証してください。必要ならplannerに相談して構いません。行ったことと検証結果を短く報告してください。workspace外は変更しないでください。
```

Do not type a second message. Observe the actual assistant stream, tool calls/results, request count,
evidence ID, outcome, and final response. Do not interrupt a normally progressing turn merely to
inspect intermediate evidence.

## Product success

The turn succeeds only when all of the following are observed:

- the real provider response passes HTTP/SSE parsing through a terminal model result;
- successful tool activity actually reads the input, creates and reads back the output, edits the
  requested line, and verifies the final file with Bash; the exact valid tool sequence is observed,
  not prescribed for the model;
- a short assistant final is displayed and the turn is committed with ready state;
- the TUI reports an actual turn request count from 1 through 16;
- the TUI reports a durable provider-evidence ID/readback command;
- `request.txt` remains exactly the three seeded lines;
- `acceptance-note.md` is exactly:

  ```text
  # Henji acceptance
  Owner: Masato
  Status: READY
  Check: pending
  ```

After the settled result, leave the empty editor with Ctrl-D and require a clean terminal return.
Then verify the files read-only:

```sh
printf '%s\n' \
  'Project: Henji acceptance retry' \
  'Owner: Masato' \
  'Status: draft' \
  | cmp - -- request.txt
printf '%s\n' \
  '# Henji acceptance' \
  'Owner: Masato' \
  'Status: READY' \
  'Check: pending' \
  | cmp - -- acceptance-note.md
```

## Provider-evidence readback

From the same workspace, run:

```sh
henji diagnostics evidence list
henji diagnostics evidence show --id <displayed-evidence-id>
```

Read the retained artifact as the actual execution record. Confirm and record:

- each request's lane, model step, ordinal, serialized body, HTTP status and response headers;
- exact raw response bytes, ordered SSE events, and the final usage/accounting frame shape;
- parser transitions, including one terminal transition rather than a duplicate transition for the
  accounting frame;
- model/tool/result order, final outcome, turn request count, and runtime request count;
- provider-reported usage and cost when present; do not invent an exact charge when absent;
- the capture shape contains no credential, request header collection, or Authorization field/value,
  while other provider response data remains intact.

The readback itself is not a substitute for tool completion; both the product result and correlated
evidence are required.

## Failure branch

If the accepted turn fails, is cancelled, reaches max steps, lacks a final, does not commit, performs
the wrong work, or cannot durably retain/read the evidence:

1. do not resubmit, retry, switch model/provider, continue the session, or start another turn;
2. exit/discard only after the runtime settles;
3. retain the workspace and state;
4. run `henji diagnostics evidence list` and show the displayed evidence ID, or show the diagnostic
   ID when the failure supplies one;
5. report the exact request, HTTP/SSE event, field, parser transition, tool/runtime event, and request
   count that caused the failure. If persistence itself failed, report that separately from the
   provider/product outcome.

No code change or additional provider attempt follows automatically.

## Completion record

After execution, create
`docs/plans/fr1-real-provider-human-acceptance-results.md` with the fixed identity, approval consumed
or unconsumed state, actual request count, observed provider usage/cost, exact tool outcomes, file
readback, evidence ID/durability, accounting-frame shape, parser/runtime outcome, and any failure.
Update `.handoff/handoff.md` and `AGENTS.md` once. Do not copy raw provider bodies or credential-like
values into those summaries; the complete raw exchange remains in its provider-evidence artifact.

Local planning is complete when this plan is approved or rejected. Production compatibility and
human acceptance remain pending until the single turn and evidence readback both succeed.
