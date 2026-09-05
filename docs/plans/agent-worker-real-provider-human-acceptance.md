# Agent Worker real-provider human acceptance

Status: **execution package prepared — Human Gate pending**

Prepared: 2026-09-05

## Outcome to prove

Use the installed production `henji` path to complete one fresh built-in Definition turn followed by
one fresh external Definition turn. Each turn must use the real OpenRouter model, call `read`
exactly once, use no planner or other tool, return the exact final text, commit through the Host /
Worker path, and retain provider evidence and a Worker execution artifact for readback.

This gate accepts the already implemented Worker candidate. It does not start an experience-driven
self-revision trial and does not prove Stage 4, resident Host, same-session revision transition, or
permanent provider/tool I/O placement.

## Authority and fixed identity

- Corrections contract:
  [`agent-worker-real-provider-gate-corrections.md` §7](./agent-worker-real-provider-gate-corrections.md#7-後続human-gateのtask-cost)
- product-source baseline: `3b7e3aa8f054f3da1e0827e4750ec5bdb6b47c2b`
- execution identity: the clean plan-containing commit; record its full hash immediately before the
  Human Gate and require no product-path difference from the baseline
- production command: `/home/masat.guest/.local/bin/henji`
- canonical wrapper: `v0/agent/henji_machine_launcher.sh`
- model: `google/gemini-3.7-flash`
- endpoint: `POST https://openrouter.ai/api/v1/chat/completions`
- response mode: SSE
- built-in selector: omitted, resolving to built-in `default`, `maxSteps: 8`
- external selector: `--definition ./henji.agent.ts`, `maxSteps: 4`
- turns: built-in 1, then external 1
- expected provider requests: 2 + 2 = 4
- expected tools: built-in `read` once; external `read` once
- planner requests: zero
- application retry, provider fallback, resubmission, rerun, and additional turn: zero

The existing `parent 8 + planner 8 + external parent 4 + planner 8 = 28` figure is only the runtime
stop/diagnostic bound. It is not a request budget. Any planner call, tool other than `read`, second
`read`, request beyond two in either turn, retry/fallback, unexpected provider/parser outcome, wrong
file effect, missing final, failed commit, or failed evidence/artifact readback stops the package.

## Current official provider readback and cost

The public official OpenRouter Models API and documentation were read on 2026-09-05 without a
credential or completion request:

- [Models API](https://openrouter.ai/api/v1/models) lists `google/gemini-3.7-flash`, context length
  1,048,576, maximum completion 65,536, tool support, input USD 0.75/M tokens, and output USD 3.75/M
  tokens.
- [Chat Completions](https://openrouter.ai/docs/api/api-reference/chat/create-a-chat-completion)
  documents `POST /api/v1/chat/completions` and streaming mode.
- [Tool calling](https://openrouter.ai/docs/guides/features/tool-calling) documents assistant tool
  calls, local tool execution, tool-result reinsertion, and subsequent model completion.
- [Usage accounting](https://openrouter.ai/docs/cookbook/administration/usage-accounting) documents
  response usage and cost fields.

Historical actual-cost proportional estimates for four requests are:

```text
FR1:                     USD 0.0055785 × 4 / 6  = USD 0.003719
Gate 1 successful run:  USD 0.028308  × 4 / 16 = USD 0.007077
excluded Worker incident, 4 requests:             USD 0.003063
expected task range:                                USD 0.004–0.01
```

This is an estimate, not an enforced cap. At the official full model limits, one request could cost
up to USD 1.032192 and four could cost USD 4.128768. The current client cannot enforce a monetary
cap inside a provider request. This package constrains the actual task by exact turns, tools,
expected requests, and stop-on-first-deviation instead.

Refresh the public Models API and the three official pages immediately before execution. Stop before
credential access or submission if the slug, endpoint, SSE/tool contract, availability, or price has
changed in a way that invalidates this package.

## Fixed workspaces and state

| Definition | Workspace                                  | Workspace digest                                                   | State namespace                                                                                                 |
| ---------- | ------------------------------------------ | ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| built-in   | `/tmp/henji-worker-real-provider-builtin`  | `ebec20dc5ccaaa940b40c680f4b8b693670557e3e36eb1f40b4670494563052f` | `/home/masat.guest/.local/state/henji-harness/ebec20dc5ccaaa940b40c680f4b8b693670557e3e36eb1f40b4670494563052f` |
| external   | `/tmp/henji-worker-real-provider-external` | `7830b3efa11a9609b9f9382779ef4e4dc0d8c0ddd5403972334ac71a1a9aaf20` | `/home/masat.guest/.local/state/henji-harness/7830b3efa11a9609b9f9382779ef4e4dc0d8c0ddd5403972334ac71a1a9aaf20` |

Both workspaces and namespaces were absent during package preparation. If any exists at execution
preflight, preserve it and stop. Do not reuse or clean it up.

Each workspace receives this exact input, including the terminal newline:

```text
Worker acceptance: READY
```

The external workspace also receives this exact `henji.agent.ts`:

```ts
import { createDefaultAgentComposition, type ExecutableAgentDefinition } from '@henji/agent';

const definition: ExecutableAgentDefinition = (input) =>
  createDefaultAgentComposition(input, { limits: { maxSteps: 4 } });

export default definition;
```

- UTF-8 bytes: 249
- SHA-256: `2390c3233731be0821ed5c4ff1e2b9893d4d67c80a869afef0d75b54e4a18697`

## Provider-free package preflight

Package preparation used the exact prompt and input, the built-in standard composition and external
`maxSteps: 4` composition, the actual production request encoder, a dummy credential source, a fake
fetcher, scripted tool-call/final SSE, and the actual `read` tool. It did not read the real
credential, contact OpenRouter's completion endpoint, run production `henji`, or create production
state.

Both paths produced `final`, exact text `WORKER ACCEPTANCE OK`, one tool call/result, two parent
requests, zero child requests, no AGENTS/skill snapshot, `stream: true`, model
`google/gemini-3.7-flash`, and `max_completion_tokens: 65536`.

| Definition | Request | Body bytes | Scripted-body SHA-256                                              | Message roles         |
| ---------- | ------: | ---------: | ------------------------------------------------------------------ | --------------------- |
| built-in   |       1 |      2,784 | `5019ba74c10a3a62f2bb7e520ce3908e6887484705877b39cc896a130262aaf1` | user                  |
| built-in   |       2 |      3,041 | `99133708531914f719e83e8cc4beac9ad88ae34506d7163c255c643520b60f80` | user, assistant, tool |
| external   |       1 |      2,784 | `5019ba74c10a3a62f2bb7e520ce3908e6887484705877b39cc896a130262aaf1` | user                  |
| external   |       2 |      3,043 | `cb9ff629506d2751546d8d99cec21f817fbc5d3a4e49015af52ceffb23bc683b` | user, assistant, tool |

Second-request hashes and bytes include scripted provider tool-call IDs. The real provider values
may differ; the authoritative real request bodies and bytes will be read from retained provider
evidence.

## Human Gate consumption

```text
package_prepared_unapproved
  -> explicit execution approval
     -> approved_unconsumed
        -> pre-submit failure: stopped_unconsumed
        -> built-in prompt submitted: consumed_in_progress
           -> first deviation or failure: stopped_consumed
           -> built-in accepted -> external accepted -> readback
              -> completed_pending_human_judgment
                 -> accepted | rejected
```

Submission of the built-in prompt consumes the gate. A startup or setup failure before submission
does not consume provider authorization, but the fixed paths are preserved and the package is not
silently rerun. Any consumed failure stops before the external turn or any new attempt.

## Preflight after approval and before setup

These checks do not read the credential or contact the completion endpoint:

```sh
cd -- /home/masat.guest/src/henji-harness

worker_gate_head=$(git rev-parse HEAD)
test -z "$(git status --short --untracked-files=no)"
git diff --quiet 3b7e3aa8f054f3da1e0827e4750ec5bdb6b47c2b -- \
  v0 tests/v0 deno.v0.json README.md

test "$(command -v henji)" = /home/masat.guest/.local/bin/henji
test "$(sha256sum v0/agent/henji_machine_launcher.sh | awk '{print $1}')" = \
  2e45157491bdac8c0de52ab56116111d00077152665021135324e1602a69dcf6
v0/agent/install_henji_machine_launcher.sh check

test ! -e /tmp/henji-worker-real-provider-builtin
test ! -e /tmp/henji-worker-real-provider-external
test ! -e /home/masat.guest/.local/state/henji-harness/ebec20dc5ccaaa940b40c680f4b8b693670557e3e36eb1f40b4670494563052f
test ! -e /home/masat.guest/.local/state/henji-harness/7830b3efa11a9609b9f9382779ef4e4dc0d8c0ddd5403972334ac71a1a9aaf20
```

Record `worker_gate_head`. Stop on any mismatch. The plan-containing commit may add documentation,
but product paths must remain identical to the fixed baseline.

## Post-approval setup

After the preflight succeeds:

```sh
umask 077
mkdir -- /tmp/henji-worker-real-provider-builtin
mkdir -- /tmp/henji-worker-real-provider-external

printf '%s\n' 'Worker acceptance: READY' \
  > /tmp/henji-worker-real-provider-builtin/acceptance.txt
printf '%s\n' 'Worker acceptance: READY' \
  > /tmp/henji-worker-real-provider-external/acceptance.txt

printf '%s\n' \
  "import { createDefaultAgentComposition, type ExecutableAgentDefinition } from '@henji/agent';" \
  '' \
  'const definition: ExecutableAgentDefinition = (input) =>' \
  '  createDefaultAgentComposition(input, { limits: { maxSteps: 4 } });' \
  '' \
  'export default definition;' \
  > /tmp/henji-worker-real-provider-external/henji.agent.ts

test "$(sha256sum /tmp/henji-worker-real-provider-external/henji.agent.ts | awk '{print $1}')" = \
  2390c3233731be0821ed5c4ff1e2b9893d4d67c80a869afef0d75b54e4a18697
```

Before each launch, confirm the physical workspace and that its evidence, diagnostics, executions,
and sessions lists are empty. From that workspace, use:

```sh
henji diagnostics list
henji diagnostics evidence list
henji diagnostics executions list
/home/masat.guest/src/henji-harness/v0/agent/session_cli_launcher.sh list
```

Do not inspect other workspace namespaces.

## Exact turn prompt

Submit this exact text once in each TUI:

```text
このworkspace内のacceptance.txtをread toolでちょうど一回読み、内容が「Worker acceptance: READY」の一行であることを確認してください。plannerや他のtoolは使わず、最後に「WORKER ACCEPTANCE OK」とだけ答えてください。
```

### Turn 1 — built-in

```sh
cd -- /tmp/henji-worker-real-provider-builtin
/home/masat.guest/.local/bin/henji
```

Confirm startup shows the built-in `default` Definition, new persistent session, and ready turn 0.
Submit the prompt once. Require exactly one `read` of `acceptance.txt`, no planner/other tool,
exactly two provider requests, exact final `WORKER ACCEPTANCE OK`, committed turn 1, and a clean
exit from the empty editor with Ctrl-D.

Read back the workspace's provider evidence and Worker execution artifact before starting Turn 2. If
any success condition fails, do not start the external command.

### Turn 2 — external

```sh
cd -- /tmp/henji-worker-real-provider-external
/home/masat.guest/.local/bin/henji --definition ./henji.agent.ts
```

Confirm startup shows the exact external Definition revision, `maxSteps: 4`, new persistent session,
and ready turn 0. Submit the same prompt once. Require the same
one-read/no-planner/two-request/final/ commit conditions, then exit from the empty editor with
Ctrl-D.

## Readback and product success

From each workspace, run the installed read-only commands shown by the TUI for the exact retained
IDs, including:

```sh
henji diagnostics evidence list
henji diagnostics evidence show --id <evidence-id>
henji diagnostics executions list
henji diagnostics executions show --id <execution-id>
/home/masat.guest/src/henji-harness/v0/agent/session_cli_launcher.sh list
```

The gate succeeds only if both paths establish all of the following:

- real OpenRouter HTTP/SSE reaches one terminal model tool-call result and one terminal final
  result;
- actual order is model → `read` call → read result → model → exact final;
- `acceptance.txt` is read exactly once and remains the exact seeded bytes;
- planner, write, edit, Bash, JSON submission, retry, fallback, and other tools are unused;
- each turn reports exactly two requests and the package reports exactly four;
- each persistent session commits exactly one turn;
- the built-in and external Definition identities, Manifest, generation, command sequence, Host
  store, commit acknowledgement, settlement, request count, evidence link, and execution artifact
  correlate;
- external maxSteps is 4 and the external entry hash matches the fixed source;
- provider evidence retains serialized request bodies, raw response bytes, ordered SSE events,
  provider metadata, parser transitions, usage and cost when supplied, and exactly one terminal
  parser transition per response;
- credential values and Authorization are absent from output and retained artifacts;
- the user can read the final and evidence and judge both paths usable.

Provider-reported usage and cost are authoritative when present. Do not invent an exact charge when
absent and do not replace product success with sanitized summaries or offline evidence.

## Failure branch

On the first failure, deviation, cancellation, wrong effect, missing final, non-commit, evidence or
artifact persistence/readback failure:

1. do not resubmit, retry, continue the session, switch model/provider, or start another turn;
2. allow the current runtime to settle, then exit without deleting anything;
3. preserve both fixed workspaces and their state namespaces;
4. read the available evidence, execution artifact, or diagnostic by the displayed ID;
5. report the exact request count and the request, raw response/SSE, parser transition, tool event,
   runtime outcome, or persistence stage that caused the failure.

No code correction or another provider attempt follows automatically.

## Human Gate requested after package preparation

Execution approval covers only:

- a fresh official public model/API/price readback;
- the read-only identity, launcher, absence, and empty-list checks above;
- creation of the two fixed temporary workspaces and their normal fresh state namespaces;
- request-time read of the existing credential without displaying or changing it;
- the two exact installed production commands and exact prompt once each, in fixed order;
- expected four real provider requests, exactly two `read` calls total, no planner, and stop on the
  first deviation;
- read-only result/evidence/execution/session readback and results/handoff documentation.

It does not authorize retry, fallback, rerun, another turn, another model/provider, cleanup, source
or test changes, installed launcher changes, unrelated state inspection, `_refs/*`, dependency
changes, commit, push, tag, publication, or release.

After execution, record the exact identity, consumption state, requests, usage/cost, tool/runtime
outcomes, Definition/Manifest/generation bindings, session commit, evidence/artifact IDs and
readback, and human judgment in `agent-worker-real-provider-human-acceptance-results.md`; then
update the active handoff Record once. Keep raw provider bodies in their retained evidence rather
than copying them into the summary document.
