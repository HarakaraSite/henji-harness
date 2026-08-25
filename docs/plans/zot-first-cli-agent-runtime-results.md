# Zot-first normal CLI agent runtime — step 11 results

## Acceptance package

- Plan: docs/plans/zot-first-cli-agent-runtime.md
- Plan SHA-256: 6981539366c3130bb4864180a6c09e935f32192fc0ddd13e960df5e5dcf75bca
- Approval: user-approved local implementation, offline validation, results, and bounded review on
  2026-08-25.
- Scope: fixed normal single-shot CLI runtime only. No broad tools, streaming, sessions, context,
  skills, extensions, RPC, subagents, dynamic provider/model selection, dependency changes, or
  persistent state.

## Implemented behavior

- v0/agent/runtime.ts constructs one fixed model and one Registry per invocation, advertises
  character_count, count_json_array_items, list_json_object_keys, and uppercase_text in stable
  name order, and calls the existing runAgent once with maxSteps: 8.
- The runtime keeps the JSON reader bound to the literal deno.v0.json path. The fetch-start
  counter and injected fetch, credential, and file-reader seams are available only to direct
  offline tests; production uses the existing fixed OpenRouter profile and host fetch/credential
  source.
- v0/agent/runtime_cli.ts accepts exactly one --task TEXT value or one non-TTY stdin source.
  It rejects duplicates, missing values, unknown or positional arguments, ambiguous sources,
  terminal-without-task, blank input, fatal UTF-8 decode errors, and input over 65,536 UTF-8 bytes.
  Stdin is bounded at the first raw byte beyond 65,536.
- Success emits only final assistant text to stdout, adding one newline when required. Failure
  emits one sanitized compact JSON line to stderr with only the allowlisted outcome, counters, and
  generic error code/message. No task, transcript, tool data, provider body, credential, endpoint,
  thrown object, stack, or model text is included.
- deno.v0.json adds the production agent:run task with only the fixed OpenRouter environment,
  network, and deno.v0.json read permissions; it adds the permission-free agent:runtime:test
  task and integrates the new source/test into v0:check and v0:gate.
- README.md documents both exact input forms, the four-tool boundary, output channels, eight
  request bound, and the production-provider warning.

## Direct evidence

agent:runtime:test: **14 passed, 0 failed**.

The direct suite covers argv and piped input normalization, source ambiguity and terminal failure,
duplicate/missing/unknown/positional arguments, blank and invalid UTF-8 input, exact 65,536-byte
and oversized 65,537-byte boundaries, preflight isolation, fixed registry/order, final-only,
one-tool, sequential two-tool, multiple calls in one response, unknown/invalid/execution tool
errors with bounded recovery, fixed-path rejection before file read, missing credential, first
transport failure with no retry, eight requests with no ninth request, and sanitized failure
presentation, including an integrated CLI/runtime-seam later-request failure that preserves
requestCount 2, steps 2, and toolCallCount/toolResultCount 1/1 without a third fetch.

## Offline validation

The plan's sequence was run in order using the repository's embedded Deno 2.9.4 binary at
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno. The step 11 README commands use this
absolute path directly and are executable on this VM. The original sequence exited 0; after the
review fixes, the focused runtime task, v0:gate, and git diff --check were rerun against the final
files and also exited 0:

| Command | Result |
| --- | --- |
| agent:runtime:test | 14 passed |
| agent:test | 12 passed |
| agent:transport:test | 10 passed |
| agent:acceptance:test | 10 passed |
| agent:selection:test | 8 passed |
| agent:json-keys:test | 6 passed |
| v0:check | pass |
| v0:fmt | pass, 31 files checked |
| v0:lint | pass, 29 files checked |
| v0:test | 92 passed |
| v0:gate | 92 passed |
| git diff --check | pass |

The unmodified shorthand deno task --config deno.v0.json agent:runtime:test was probed and failed
before task execution with deno: command not found; no product code ran in that probe. It is not
used by the step 11 documentation or the evidence recorded above.

## Requirement mapping

| Requirement | Evidence |
| --- | --- |
| Exact argv/stdin contract and preflight ordering | 14 direct tests; runtime runner is not invoked for invalid/ambiguous input |
| 64 KiB task and bounded stdin | direct exact-boundary and oversized tests |
| Fixed four-tool registry and stable order | direct request-body inspection and runtime registry composition |
| Fixed JSON path boundary | direct reader invocation count remains zero for another path |
| Generic bounded tool-error recovery | direct unknown, invalid-argument, and execution-failure cases |
| One composition, max eight requests, no retry | direct one/two/multi-call, transport, later-request failure, and eight/no-ninth tests |
| Exact success/failure channels and redaction | direct final-only/newline, later-request failure, max-step, and recursive sanitized JSON checks |
| Existing behavior remains intact | agent:test, transport, acceptance, selection, JSON-key, full v0:test, and v0:gate pass |
| Production command stays outside local gates | task literal inspection: agent:run is defined but never invoked by the offline sequence |

## Changed files

- v0/agent/runtime.ts
- v0/agent/runtime_cli.ts
- tests/v0/agent_runtime_test.ts
- deno.v0.json
- README.md
- docs/plans/zot-first-cli-agent-runtime-results.md

## Provider, credential, review, and risk status

- Production agent:run and production agent:acceptance were not executed.
- No provider/network request was made by this implementation or its offline tests. No credential
  value was read, displayed, or recorded; the host credential was not checked.
- No dependency, lockfile, persistent state, commit, push, tag, release, publish, or destructive
  operation was performed.
- Independent bounded review initially returned two P2 findings: the new README commands used a
  PATH-unavailable shorthand, and the direct suite lacked an integrated later-request failure case.
  Both were fixed and revalidated. The one changed-lines-only re-review returned GO with
  Blocker/P1/P2 zero.
- Remaining risk: this evidence does not establish live provider availability, credential validity,
  or production model behavior. Those require a separate explicit user-authorized production
  operation.
