# Fixed local work tools real-model sentinel plan

## Status and recommendation

Concept review is **GO**. There is no unresolved Why, What, Whether, requirement conflict, or
implementation blocker.

This increment adds a dedicated acceptance child that uses the normal production model, loop, and
production registry, plus a fixed launcher that reuses the existing repo-external credential reader.
It does not parse the normal CLI's final stdout: that output cannot prove causal tool order, exact
results, terminal submission, and final filesystem state.

The child composes the existing:

- `OpenRouterAgentModel`;
- `runAgent`;
- `createProductionRegistry`;
- `MAX_STEPS = 8`;
- fixed profile/model/endpoint/request contract; and
- lexical definitions `bash`, `edit`, `read`, `submit_json_result`, `write`.

A sentinel-only model guard validates every provider response before tool dispatch and emits only a
sanitized acceptance report. Production runtime, tool schemas, model profile, maximum steps, and retry
policy remain unchanged.

The existing `v0/eval/live_corpus_credential_launcher.ts` remains unchanged. The new launcher directly
reuses its exported `readCredential` and fixed credential validation contract. Extracting shared code
would expand regression scope without being required.

This plan has two separate Human Gates:

- **Gate L:** local implementation, dummy/fake-provider tests, full offline verification, and review;
- **Gate S:** one separately approved real credential/provider execution after Gate L is GO.

Planning and Gate L do not authorize credential probing/reading, provider/network access, a production
command, commit, push, tag, publish, or release.

## Confirmed basis and reference decisions

- Base revision: `d4504c4` (`Add Zot-first local work tools`).
- Current baseline: work-tools 13, runtime 10, process 11, full v0 164 tests.
- `v0/agent/runtime.ts` resolves cwd as one workspace, constructs the production registry and model once,
  and calls the existing eight-step loop once.
- `v0/agent/openrouter_model.ts` starts at most one fetch per `generate`, has no application retry, fixes
  the provider request/profile, bounds each response, and retains the existing provider deadline.
- Existing process evidence demonstrates that an absolute repository entrypoint can be loaded by an
  isolated Deno child whose cwd is elsewhere. The new process test must directly retain this premise for
  a temporary cwd.
- The existing credential reader fixes the path, metadata/owner/mode/size checks, bounded read, fatal
  UTF-8, terminal-newline parsing, and static failure codes. The credential value must never appear in
  argv, stdin, workspace files, reports, errors, or logs.

The first reference remains Zot pinned commit
`9b7bb6a4f36bc8c8deb2cc5796a8f557f4fb7479` (MIT), recorded in `_refs/README.md`:

- `_refs/zot/packages/agent/build.go` and `tools/{read,write,edit,bash}.go` inform the cohesive cwd-based
  work-tool composition already adopted by Henji;
- `_refs/zot/README.md` informs noninteractive execution without a per-tool prompt.

The fixed response guard, terminal JSON acceptance, credential launcher, and sanitized evidence are Henji
deviations. No Zot code is copied, and `_refs/` is neither executed nor modified.

## Fixed task and success contract

Task ID is `v1.work-tools.fixed`. The workspace initially is an empty mode-`0700` directory.

The exact task is:

```text
This is a fixed local-work sentinel. Use exactly one tool call in each assistant response and perform these five calls in order. Do not answer with assistant text and do not call any other tool.

1. Call write with {"path":"work/item.txt","content":"alpha\n"}.
2. Call read with {"path":"work/item.txt"}.
3. Call edit with {"path":"work/item.txt","edits":[{"oldText":"alpha\n","newText":"beta\n"}]}.
4. Call bash with {"command":"test \"$(cat work/item.txt)\" = beta && printf 'verified:%s' \"$(wc -c < work/item.txt)\"","timeoutMs":5000}.
5. Only after the prior tool results confirm those operations, call submit_json_result as the sole call with {"json":"{\"path\":\"work/item.txt\",\"content\":\"beta\\n\",\"bytes\":5,\"bash\":\"verified:5\"}"}.
```

Expected continuing tool results, in order:

```text
{"path":"work/item.txt","bytes":6}
alpha\n
{"path":"work/item.txt","edits":1,"bytes":5}
{"stdout":"verified:5","stderr":"","exitCode":0,"signal":null,"timedOut":false,"stdoutTruncated":false,"stderrTruncated":false}
json result submitted
```

Expected terminal JSON:

```json
{"path":"work/item.txt","content":"beta\n","bytes":5,"bash":"verified:5"}
```

Expected final filesystem:

- root entries exactly `work`;
- `work` is a non-symlink directory with the single entry `item.txt`;
- `work/item.txt` is a non-symlink regular file containing exact UTF-8 bytes `beta\n` (5 bytes);
- no sibling atomic temp file or other entry remains.

Success requires all of the following:

- exactly five model requests and five external fetch starts;
- exactly five steps, executed calls, and correlated results;
- one tool call in each assistant response;
- exact tool names, arguments, order, and prior call/result correlation;
- fifth call is the sole batch member;
- stop reason `tool_terminal`, terminal kind `json_result`;
- exact terminal JSON and final filesystem.

The sentinel model guard validates provider output before returning it to `runAgent`. A wrong name,
argument, order, early assistant final, multi-call batch, or extra call fails before dispatch. Before each
new provider request it validates the preceding expected result. A sixth `generate` fails before delegate
fetch. Thus the inherited runtime ceiling remains eight while this sentinel has a hard ceiling of five
fetch starts and five executed tool calls.

## Dedicated child contract

Add `v0/agent/work_tools_sentinel.ts`. It has no production arguments or selectors. It composes the real
adapter, loop, production registry, fixed task, sentinel guard, and strict validators.

The child emits exactly one bounded JSON line to stdout and nothing to stderr. Its exact-key report contains
only:

- schema version, fixed task ID, fixed profile ID;
- `ok` and an allowlisted outcome code;
- model-generate and external-fetch counts;
- steps/tool-call/tool-result counts;
- tool names/order, without arguments or raw results;
- stop reason and terminal kind;
- transcript-validation and workspace-validation booleans;
- the canonical expected terminal result on success.

It must not contain the task text, raw transcript, tool arguments/results, raw Bash output, provider/HTTP
body, exception, stack, credential, or absolute path.

The successful child tuple is fixed at five requests/calls/results, order
`write/read/edit/bash/submit_json_result`, `tool_terminal`, `json_result`, exact final JSON, and verified
workspace. Provider, adherence, execution, terminal, transcript, or filesystem failure maps to an
allowlisted child code and never includes raw evidence.

## Fixed parent launcher and temporary workspace

Add `v0/agent/work_tools_sentinel_launcher.ts`. It accepts zero application arguments. Any argument fails
before credential access, workspace creation, or child spawn.

Production sequence:

1. Call the existing fixed `readCredential` exactly once. Do not probe the credential separately.
2. Create one `/tmp/henji-work-tools-sentinel-*` directory, chmod it `0700`, canonicalize/lstat it,
   require it to be empty, and retain ownership of that exact path.
3. Spawn at most one child with the exact contract below.
4. Bound stdout/stderr and the aggregate child lifetime; kill and reap on timeout, overflow, or handled
   signal.
5. Strictly parse the child report and independently verify the final workspace.
6. Remove the owned workspace recursively in `finally`.
7. Emit only the parent's canonical sanitized result after cleanup outcome is known.

Exact child executable:

```text
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno
```

Exact argv, where `<workspace>` is the one canonical directory created by the parent:

```text
run
--no-prompt
--no-remote
--allow-env=HENJI_OPENROUTER_API_KEY
--allow-net=openrouter.ai
--allow-read=<workspace>
--allow-write=<workspace>
--allow-run=/bin/bash
/home/masat.guest/src/henji-harness/v0/agent/work_tools_sentinel.ts
```

Command options:

- cwd: exact canonical workspace;
- `clearEnv: true`;
- env: exactly `{ HENJI_OPENROUTER_API_KEY: credential }`;
- stdin `null`, stdout/stderr `piped`;
- no task/profile/model/endpoint/workspace argument;
- relative ES imports resolve from the absolute entrypoint module URL;
- normal runtime resolves the child cwd as the workspace.

The child aggregate deadline is 180 seconds: five existing 30-second provider deadlines plus bounded
startup/tool/capture margin. Capture is independently limited to 8 KiB per channel. The fixed Bash call
has `timeoutMs: 5000`.

The parent handles `SIGHUP`, `SIGINT`, and `SIGTERM` by terminating the child, escalating after a fixed
grace, awaiting final status, and cleaning the workspace. Deadline and output overflow use the same
kill/reap/cleanup path. SIGKILL, VM loss, or a process crash cannot be handled in-process.

## Parent evidence and failure contract

After successful child validation and workspace cleanup, stdout is exactly one canonical JSON line:

```json
{"schemaVersion":1,"taskId":"v1.work-tools.fixed","profile":"openrouter-google-gemini-3.7-flash-vertex-v0","ok":true,"outcome":"passed","modelRequests":5,"externalRequests":5,"toolCalls":5,"toolResults":5,"toolOrder":["write","read","edit","bash","submit_json_result"],"stopReason":"tool_terminal","result":{"path":"work/item.txt","content":"beta\n","bytes":5,"bash":"verified:5"},"workspaceVerified":true,"workspaceRemoved":true,"retryCount":0}
```

Success stderr is empty and exit code is zero.

On failure, stdout is empty. Stderr is one canonical JSON line containing the fixed schema/task,
`ok:false`, `outcome:"aborted"`, allowlisted stage/code, child count 0 or 1, observed external requests
`0..5` or `null` when unavailable, fixed ceiling 5, retry count 0, and workspace removal state
`true`/`false`/`null`. Raw child bytes are never relayed.

Failure codes:

- preflight: `arguments_invalid`;
- credential: existing `credential_*` codes;
- workspace: `workspace_create_failed`, `workspace_invalid`;
- process: `child_spawn_failed`, `child_wait_failed`, `child_exit_failed`, `child_signal`;
- bounds: `deadline_exceeded`, `stdout_overflow`, `stderr_overflow`;
- evidence: `child_report_invalid`;
- execution: `provider_failure`, `model_adherence_failure`, `tool_execution_failure`;
- terminal/filesystem: `terminal_result_mismatch`, `workspace_mismatch`;
- cleanup: `cleanup_failed`;
- fallback: `internal_failure`.

Unknown fields, extra lines, stderr bytes, malformed child JSON, counters outside the fixed bounds, or tuple
mismatch are `child_report_invalid`. Cleanup failure overrides an otherwise successful result.

Success, provider/adherence/tool failure, timeout, handled signal, overflow, nonzero exit, invalid report,
and spawn failure all attempt removal. An uncatchable SIGKILL/VM loss may leave a mode-`0700` disposable
directory, which can be manually removed without rerunning the provider attempt. Credential state is never
changed. Provider requests and charges are not rollbackable.

## Exact tasks and permissions

The production task is conceptually exact:

```text
agent:work-tools:sentinel:credential-file =
  <embedded-deno> run --no-prompt --no-remote
  --allow-read=/home/masat.guest/.config/henji-harness/openrouter-api-key,/tmp
  --allow-write=/tmp
  --allow-run=/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno
  --allow-sys=uid
  v0/agent/work_tools_sentinel_launcher.ts
```

The parent receives no env, net, repository-write, or `/bin/bash` run permission. Installed-Deno direct and
process tests must verify whether the planned signal handling needs any narrower additional permission; if
it does, stop and report the exact local plan delta instead of granting broad `--allow-sys`.

The production task must be unreachable from `v0:gate`, `v0:test`, focused tasks, and fixtures.

## File ownership

One implementation agent owns only:

- `v0/agent/work_tools_sentinel.ts`;
- `v0/agent/work_tools_sentinel_launcher.ts`;
- `tests/v0/work_tools_sentinel_test.ts`;
- `tests/v0/work_tools_sentinel_process_test.ts`;
- `tests/v0/work_tools_sentinel_topology_test.ts`;
- narrowly needed `tests/v0/fixtures/work_tools_sentinel_*` files;
- `deno.v0.json`;
- the sentinel section of `README.md`;
- `docs/plans/local-work-tools-real-model-sentinel-results.md`.

The existing credential launcher, runtime/model/loop/tools, corpus/eval code, dependencies, lockfiles,
archive, and `_refs/` remain unchanged. `AGENTS.md` and `.handoff/handoff.md` remain repository-owner
bookkeeping. If implementation requires changing a preserved product contract, stop with cause, evidence,
impact, proposed plan delta, and verification.

## Ordered implementation

### 1. Fixed contract and guarded model

Implement constants, exact JSON comparison, expected arguments/results, transcript causality checks,
generate/fetch counters, and response validation before dispatch.

Direct tests reject early final, wrong/unknown/out-of-order tool, wrong or extra arguments, multiple calls,
changed prior result, correlation mismatch, and sixth request before prohibited dispatch/fetch. Every request
must advertise the exact production definitions. Injected secret/provider/path markers must not appear in
errors.

### 2. Acceptance child

Compose the guarded adapter with `runAgent`, `createProductionRegistry`, resolved cwd workspace, and
`MAX_STEPS`. Validate terminal transcript, exact final JSON, and exact filesystem, then serialize a strict
child report.

Fake-provider tests execute the complete causal sequence in a temp workspace. No real credential or network
is available.

### 3. Parent launcher and lifecycle

Reuse `readCredential`; add temp creation/ownership, exact child composition, bounded capture, aggregate
deadline, signal/status mapping, strict report parsing, independent workspace verification, cleanup, and
parent report.

Injected tests prove preflight ordering, one credential read, one workspace, at most one child, exact
executable/argv/cwd/environment/stdio, redaction, cleanup on every failure, and cleanup-failure override.

### 4. Actual-process fake-provider boundary

Use the real embedded `Deno.Command`, dummy credentials, and fake provider only. Verify:

- the absolute entrypoint loads from an unrelated temp cwd without repository read permission;
- child permissions are limited to its temp read/write and `/bin/bash`; the recorded production invocation
  alone has one credential env and `openrouter.ai` net;
- write/read/edit/bash/submit execute causally and the parent observes the final file before removal;
- child env is secret-only, stdin is null, and neither secret nor task is in argv;
- nonzero exit, signal, spawn failure, deadline, stdout/stderr overflow kill/reap and clean up;
- raw marker strings never cross the parent report boundary.

### 5. Task/check/gate topology

Add focused tasks:

- `agent:work-tools:sentinel:test`;
- `agent:work-tools:sentinel:process:test`;
- `agent:work-tools:sentinel:topology:test`;
- production-only `agent:work-tools:sentinel:credential-file`.

Topology tests prove focused tasks have no credential-file read or network permission; production task is
unreachable from all local gates; existing production/live/credential task literals remain exact; each
focused task occurs once in `v0:gate`; no local fixture can invoke a production path.

### 6. Evidence and review

Add `docs/plans/local-work-tools-real-model-sentinel-results.md` mapping requirements to source/test
evidence, exact commands/counts, permission topology, cleanup matrix, dummy-only status, deviations,
unperformed operations, review, and remaining risks.

Initial independent read-only review is bounded to 30 minutes and stops after 10 minutes without new
evidence. One changed-lines re-review is allowed for 15 minutes. Gate S requires Blocker/P1/P2 zero.

Review focus is pre-dispatch hard bounds, exact production composition, secret boundary, report redaction,
temp lifecycle, kill/reap, cleanup override, local-gate non-reachability, and preservation of the existing
launcher/runtime.

## Gate L: local implementation and verification

Gate L authorizes only the owned files, dummy/fake-provider tests, offline verification, results, lifecycle
bookkeeping, and bounded review. It does not authorize credential metadata/content access, provider/network,
production tasks, dependency/lockfile changes, commit, push, tag, publish, or release.

Run the repository-pinned Deno commands:

```sh
deno task --config deno.v0.json agent:work-tools:sentinel:test
deno task --config deno.v0.json agent:work-tools:sentinel:process:test
deno task --config deno.v0.json agent:work-tools:sentinel:topology:test
deno task --config deno.v0.json agent:work-tools:test
deno task --config deno.v0.json agent:runtime:test
deno task --config deno.v0.json agent:runtime:process:test
deno task --config deno.v0.json agent:transport:test
deno task --config deno.v0.json agent:corpus:eval:live:credential-launcher:test
deno task --config deno.v0.json agent:corpus:eval:live:credential-launcher:process:test
deno task --config deno.v0.json agent:corpus:eval:live:credential-launcher:topology:test
deno task --config deno.v0.json v0:check
deno task --config deno.v0.json v0:fmt
deno task --config deno.v0.json v0:lint
deno task --config deno.v0.json v0:test
deno task --config deno.v0.json v0:gate
git diff --check
```

The actual task definitions use the repository-pinned absolute Deno 2.9.4 path. Gate L must not run
`agent:run`, live/canonical corpus tasks, either credential-file task, legacy acceptance, or another
production provider path.

Gate L completes when all focused/full commands pass, production tasks are unreachable locally, no
credential probe/stat/read or provider request occurred, the results package is complete, review is GO with
zero Blocker/P1/P2, and no preserved production source changed.

## Gate S: separately approved real one-shot

Only after Gate L GO, present the approved plan path/hash, target revision/diff, local counts, review status,
and exact command for a separate explicit decision:

```sh
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --quiet \
  --config deno.v0.json agent:work-tools:sentinel:credential-file
```

Gate S readback must state:

- one command, one fixed task, one credential-open sequence, one workspace, at most one child;
- model `google/gemini-3.7-flash` and fixed OpenRouter endpoint/profile;
- POST, non-streaming, maximum 1,024 completion tokens per request;
- runtime maximum 8, sentinel hard maximum 5 external requests;
- aggregate completion-token ceiling 5,120;
- repository worst-case amount `5 × USD 0.062208 = USD 0.31104`;
- authorization ceiling `5 × USD 0.064 = USD 0.320`;
- application retry/fallback/rerun/follow-up 0;
- 180-second child deadline, 5-second Bash timeout, 8-KiB/channel capture;
- credential value is first accessed only by this exact command;
- any missing/malformed credential consumes the attempt;
- normal cleanup covers every handled outcome;
- no rerun regardless of result.

Under the current policy this bounded five-request test does not require a routine fresh price lookup. Verify
model/API/tool availability only if evidence at Gate S makes that contract uncertain. If bounds change or
spend becomes material, stop and refresh official pricing before approval.

Stop without retry or follow-up for any credential, workspace, spawn, provider, adherence, tool, terminal,
filesystem, report, deadline, overflow, signal, redaction, cleanup, plan-hash, or local-review anomaly.

Record only the canonical sanitized result, command count/status, observed external count or unknown count
with fixed upper bound, child count, cleanup state, and retry count zero. Never persist raw child output,
transcript, tool arguments/results, provider bodies, exceptions/stacks, Authorization data, or credential.

## Acceptance package, rollback, and remaining risks

The final package records plan hash/base revision, requirement-to-file/test mapping, focused/full counts,
permission topology, dummy-only Gate L evidence, review/re-review disposition, sanitized Gate S result if
separately approved, deviations, rollback, and unperformed publication operations.

Rollback removes only the two sentinel source files, sentinel tests/fixtures, task/check/gate entries,
README/results section, and lifecycle bookkeeping. It must not reset the worktree, touch the credential,
change the existing live launcher/runtime/tool/corpus/eval contracts, modify `_refs/`, or erase consumed
provider evidence. Provider effects and charges cannot be rolled back.

Accepted remaining risks:

- Bash remains unsandboxed same-user execution. The fixed pre-dispatch guard permits this sentinel's exact
  foreground temp-relative command only, but it is not a general OS sandbox.
- Same-user process inspection may observe a child environment, though the secret is absent from argv,
  files, and logs.
- SIGKILL, VM loss, or parent crash may leave a mode-`0700` disposable temp directory.
- Complete descendant containment is not guaranteed; the accepted command starts no background process.
- Provider accounting/effects are irreversible.
- One fixed-task success proves adherence only for this sentinel, not general work-tool quality.

## Human Gate L

**Does the user approve Gate L: implementation of this fixed launcher/child, dummy-only local tests, full
offline verification, results package, lifecycle bookkeeping, and bounded read-only review?**

Approval does not include real credential access, provider/network execution, a production command, Gate S,
dependency/lockfile changes, `_refs/`, commit, push, tag, publish, or release.
