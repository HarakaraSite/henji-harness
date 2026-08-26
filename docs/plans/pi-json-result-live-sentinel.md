# Pi-style terminal JSON result live sentinel — one-shot Human Gate plan

## Recommendation and assumptions

Present one new **Human Gate** for exactly one execution of the existing fixed
credential-file sentinel. No implementation, configuration, corpus, scorer,
credential, or local-gate change is needed. The active source and tests agree on
the launcher, six-case order, request limits, and v2 report contract.

The fixed sentinel composition is four JSON-result submissions and two
assistant-final text completions. The provisional five/one partition is not the
current corpus composition: `v1.uppercase-text.ascii.explicit` has an
`exact_text` oracle and therefore must finish with an assistant final, just like
`v1.final-only.echo`. This plan uses the verified four/two partition and does
not change corpus data or scoring.

The previous post-fix v1 sentinel is historical and consumed. It completed 6/6
with five passed and one scored failure after 12 requests; it is not
authorization for this operation and must not be rerun or described as the same
attempt. This new operation tests real-model adherence to the implemented
`submit_json_result` terminal path and strict v2 submission scoring. One run
cannot support an aggregate, rate, confidence, ranking, regression-frequency, or
general model-quality claim.

## Confirmed current state

- Active revision `17fc92d` contains the live runner, repo-external credential
  launcher, and Pi-style terminal JSON submission. The approved
  terminal-submission plan is `docs/plans/pi-style-json-result-submission.md`,
  SHA-256 `56fcfc5044993db7ede70ed88ded5931cc15d8500869d7b94815e0e59bda143e`.
- Local evidence is complete: agent 20, offline 14, live fake 10, and full v0
  154 tests pass. After the single re-review, repository-owner final
  verification closed its remaining test-only P2; the resulting local acceptance
  state is `GO` with Blocker/P1/P2 zero. No new local gate is required for this
  execution-only increment.
- `deno.v0.json` fixes the production parent task and permissions. The launcher
  fixes the credential path, Deno executable, child cwd, child arguments,
  one-key environment, and inherited report streams. It accepts no application
  arguments.
- `v0/eval/live_corpus_runner.ts` fixes `sentinel_v1` at six cases and an
  aggregate ceiling of 12. It emits schema 2 / `henji-live-corpus-eval-v2` and
  retains schema-1 read validation only.
- The repo-external credential is fixed at
  `/home/masat.guest/.config/henji-harness/openrouter-api-key`. This plan does
  not inspect, change, probe, display, or relocate it.
- The worktree may contain untracked `_refs/` snapshots. They remain excluded
  and untouched.

## Exact suite and expected terminal evidence

The runner traverses these cases once, in this order. A successful run has the
exact request counts shown because every required domain-tool round and
completion round is distinct.

| Ordinal | Task ID                                      | Oracle / completion source                                         | Required domain tools                                                     | Requests |
| ------: | -------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------- | -------: |
|       1 | `v1.character-count.henji-chick.explicit`    | JSON; one successful `json_result` submission at request ordinal 1 | `character_count`                                                         |        2 |
|       2 | `v1.count-json-array-items.complex.explicit` | JSON; one successful `json_result` submission at request ordinal 1 | `count_json_array_items`                                                  |        2 |
|       3 | `v1.final-only.echo`                         | exact text; assistant final and `submission: null`                 | none                                                                      |        1 |
|       4 | `v1.list-json-object-keys.fmt.explicit`      | JSON; one successful `json_result` submission at request ordinal 1 | `list_json_object_keys`                                                   |        2 |
|       5 | `v1.multi-tool.fmt.explicit`                 | JSON; one successful `json_result` submission at request ordinal 2 | `list_json_object_keys`, then `count_json_array_items` in separate rounds |        3 |
|       6 | `v1.uppercase-text.ascii.explicit`           | exact text; assistant final and `submission: null`                 | `uppercase_text`                                                          |        2 |

For each JSON case, the report submission evidence must have kind `json_result`,
zero-based `requestOrdinal` equal to `requestCount - 1`, correlated nonblank
call/result IDs, and outcome `success`. Submission is separate from the four
domain-tool event types. For both exact-text cases, submission must be null and
the transcript must terminate with the normal assistant-final path.

## Fixed profile and ceilings

The command cannot select or override these values:

- profile ID: `openrouter-google-gemini-3.7-flash-vertex-v0`;
- model: `google/gemini-3.7-flash`;
- endpoint/method: `https://openrouter.ai/api/v1/chat/completions`, `POST`;
- streaming: `false`; maximum completion tokens: 1,024;
- serialized-message bound: 76 KiB, represented by the repository profile as a
  conservative 77,824 input-token pricing bound;
- case request maxima: `2, 2, 1, 2, 3, 2`; aggregate external-request ceiling:
  12;
- application retry, fallback, rerun, and follow-up: all zero.

Immediately before execution, read the official OpenRouter model page and
official model/tool documentation and record URL plus JST timestamp. Confirm the
exact slug is available, tools and `tool_choice` remain supported, and current
input/output prices do not make the existing ceiling non-conservative. At the
last planning readback, prices were USD 0.375/M input and USD 1.875/M output:

```text
77,824 * 0.375 / 1,000,000 = USD 0.029184 input/request
 1,024 * 1.875 / 1,000,000 = USD 0.001920 output/request
current-price bound/request      = USD 0.031104
repository worst/request         = USD 0.062208
authorization ceiling/request    = USD 0.064

12 * 0.062208 = USD 0.746496 repository worst case
12 * 0.064    = USD 0.768 authorization ceiling
```

The USD 0.768 value is an authorization ceiling derived from enforced
request/token bounds, not a provider-side spend cap; actual billed usage is not
collected. If fresh pricing, availability, tool support, model identity, or
repository arithmetic conflicts with these facts—or if USD 0.064 per request is
no longer conservative—stop before the command and return for a new decision.

Official readback sources:

- <https://openrouter.ai/google/gemini-3.7-flash>
- <https://openrouter.ai/docs/guides/overview/models>
- <https://openrouter.ai/docs/guides/features/tool-calling>

## Exact one-shot command and topology

After a matching fresh readback and explicit approval of this plan's SHA-256,
run exactly once from `/home/masat.guest/src/henji-harness`:

```sh
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --quiet \
  --config deno.v0.json agent:corpus:eval:live:sentinel:credential-file
```

The task expands to one parent Deno process with only:

```text
run --no-prompt
--allow-read=/home/masat.guest/.config/henji-harness/openrouter-api-key
--allow-run=/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno
--allow-sys=uid
v0/eval/live_corpus_credential_launcher.ts
```

The parent has no environment, network, or write permission. It validates the
fixed file as a non-symlink regular file, exact mode `0600`, effective-UID
owner, size 1..4096 bytes, stable pre-open/open-handle metadata, bounded fatal
UTF-8, and the existing single-token/terminal-newline contract. It closes the
handle before parsing/reporting and creates at most one child.

The fixed child uses the same Deno binary and exact topology:

```text
cwd: /home/masat.guest/src/henji-harness
argv:
  run
  --no-prompt
  --no-remote
  --allow-env=HENJI_OPENROUTER_API_KEY
  --allow-net=openrouter.ai
  --allow-read=v0/corpus/task-corpus.v1.json,deno.v0.json
  v0/eval/live_corpus_cli.ts
  sentinel
environment: clearEnv=true, exactly HENJI_OPENROUTER_API_KEY=<validated credential>
stdin: null
stdout: inherit
stderr: inherit
```

No shell expansion, caller-selected input, second child, alternate suite, direct
live task, or separate credential probe is permitted. The credential is read
only inside this command, passed only through the fixed child environment, and
never placed in argv, stdout, stderr, a repository file, or an evidence record.

## Execution and stop rules

1. Confirm the plan file SHA-256 and current revision, the completed
   local/review evidence above, and the fresh official readback. Do not stat,
   read, or validate the credential separately.
2. Obtain explicit approval for this exact command, at most one credential
   read/one child, maximum 12 requests, USD 0.768 ceiling, and the no-retry
   rules.
3. Invoke the command once. Observe its inherited stdout/stderr and exit status
   without redirecting either stream to a repository file. Do not invoke another
   command to repair, retry, probe, or continue the run.
4. Treat missing/invalid credential, metadata/content failure, child
   spawn/wait/signal failure, provider/contract/transport/report/redaction
   anomaly, partial/aborted result, score failure, malformed output, or any
   request/secret-boundary concern as a consumed attempt. Stop and report the
   sanitized outcome; do not retry or follow up automatically.

A scored case failure is allowed to continue only through the runner's same
fixed traversal and 12-request aggregate ceiling so it can produce the completed
six-case report. Any runner error aborts at the affected task and produces the
fixed `not_run` suffix. Neither result authorizes a second traversal.

## Success and failure interpretation

Success requires all of the following from the single command:

- exit status 0 and exactly one valid JSON report line on stdout, with empty
  stderr;
- `schemaVersion: 2`, `reportId: "henji-live-corpus-eval-v2"`,
  `mode: "live_openrouter"`, `suite: "sentinel_v1"`;
- profile ID/model and corpus
  `{schemaVersion: 1, corpusId: "henji-normal-cli-small-v1"}` exactly match the
  fixed contracts;
- `requestCeiling: 12`, `externalRequests: 12`, completion `completed`, and null
  abort fields;
- counts exactly total 6, completed 6, passed 6, failed 0, errors 0, notRun 0;
- task order and per-case request counts exactly `2, 2, 1, 2, 3, 2`;
- four successful JSON submissions and two null submissions exactly as mapped
  above;
- all oracle, domain-tool, submission, and request dimensions pass; the
  multi-tool case uses the two required domain tools in order and separate
  rounds;
- no credential, Authorization data, provider request/response body, raw
  transcript, raw tool arguments/results, exception, stack, token usage, or cost
  data appears outside the report's already validated bounded fields.

Any unmet condition is a consumed, non-passing attempt. A completed scored
failure is model-quality evidence, not a provider/contract error. An
aborted/error/not-run report is execution/contract evidence, not a scored model
result. A launcher static failure may leave stdout empty and emit only its
allowlisted code on stderr. A CLI preflight/serialization fatal may leave stdout
empty and emit one compact sanitized error JSON line. No outcome reopens the
historical Gate C or authorizes the 24-case canonical suite.

## Sanitized evidence and lifecycle recording

Return a concise outcome containing only:

- plan SHA/revision, execution timestamp, exact command count, exit status, and
  fresh official readback URLs/facts;
- launcher preflight category and child count, without raw OS errors or
  credential metadata beyond the already documented non-secret contract;
- schema/report/mode/suite/profile/corpus identifiers;
- ordered task IDs, per-case status/request counts/completion-source category,
  aggregate counts and external requests;
- abort code/task when present, and retry/fallback/rerun/follow-up all zero;
- the success/failure interpretation and the explicitly unperformed operations.

Do not copy final answer text, submission JSON, tool arguments/results, raw
stdout/stderr, provider bodies, exceptions/stacks, headers, credential
bytes/value, Authorization data, token usage, or unverified actual cost into
results or handoff. The live report itself is observed only as needed to
validate the fields above and is not persisted verbatim.

This Human Gate authorizes the irreversible external operation only: the exact
one command and the credential read performed inside it. It does not by itself
authorize repository file edits. If a persistent results document, `AGENTS.md`
phase update, or `.handoff/handoff.md` checkpoint is wanted afterward, obtain
the applicable file-change authorization and record only the sanitized fields
listed here. The command itself has no repository write permission.

## Human Gate and unresolved decision

The only unresolved decision is whether the user approves this new one-shot
attempt after reviewing this plan's SHA-256 and a fresh official readback.
Approval authorizes exactly:

- the command above, once;
- its fixed credential-file read/validation, at most one fixed child, and at
  most 12 external requests;
- a maximum authorization ceiling of USD 0.768;
- observation and immediate sanitized reporting of that command's outcome.

Approval does **not** authorize another sentinel, a
retry/rerun/fallback/follow-up, direct credential inspection or modification,
source/test/config/corpus/scorer/dependency/lockfile changes, remediation,
persistence, aggregation/statistics, the canonical 24-case suite, Gate C,
commit, push, tag, publish, or release. Any need for one of those operations
returns to a new decision.
