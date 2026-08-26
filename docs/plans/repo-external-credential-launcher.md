# Repo-external OpenRouter credential launcher plan

## Status and decision

- Classification: plan / credential transport remediation.
- Concept review: `GO`.
- This document is the canonical plan for a fixed launcher that reads the already recorded repo-external
  credential and passes only `HENJI_OPENROUTER_API_KEY` to the existing live sentinel child.
- Human Gate L is currently closed. This plan does not authorize implementation, credential-content access,
  a network/provider call, a new sentinel attempt, commit, push, or release.
- The previous Gate B attempt was consumed with `provider_missing_credential` and zero external requests. A
  later run through this launcher will be a separately authorized new attempt, not a retry.

## Confirmed inputs

- Credential source: `/home/masat.guest/.config/henji-harness/openrouter-api-key`.
- Recorded metadata: parent directory mode `0700`; regular file mode `0600`, owner `masat:masat`, size 75
  bytes. The value, format, and validity have not been inspected.
- Embedded Deno: `/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno`.
- Repository cwd: `/home/masat.guest/src/henji-harness`.
- Existing child entrypoint: `v0/eval/live_corpus_cli.ts sentinel`.
- Existing adapter consumes only `HENJI_OPENROUTER_API_KEY` for this credential.
- The sentinel remains the canonical six cases, at most 12 external requests, application retry/fallback/
  rerun/follow-up zero, repository worst case USD 0.746496, and authorization ceiling USD 0.768.

## Scope

In scope for Human Gate L:

- one fixed TypeScript credential launcher;
- fail-closed metadata, bounded-read, and single-token validation;
- exact child composition and status propagation;
- direct tests using dummy bytes and injected filesystem/process seams only;
- a process-level fake-child test for the real `Deno.Command` boundary;
- minimal task/check/gate integration, results evidence, and bounded review.

Out of scope:

- moving, copying, modifying, displaying, logging, serializing, or committing the credential;
- caller-selected credential path, executable, argv, cwd, suite, model, endpoint, profile, or limits;
- shell `source`, command substitution, stdin credential input, or credential-bearing argv;
- live runner, provider adapter/profile, corpus, scorer, normal runtime, dependencies, or lockfile changes;
- persistence, aggregation/statistics, usage/cost collection, retry, fallback, rerun, or Gate C;
- `_refs/`, `archive/`, commit, push, tag, publish, or release;
- any real credential read, network access, or provider command during the local implementation gate.

## Production contract

### Fixed values

The launcher accepts no application arguments and fixes the following values in source:

```text
CREDENTIAL_PATH       /home/masat.guest/.config/henji-harness/openrouter-api-key
DENO_COMMAND          /home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno
CHILD_CWD             /home/masat.guest/src/henji-harness
CHILD_ENTRYPOINT      v0/eval/live_corpus_cli.ts
CHILD_SUITE           sentinel
SECRET_ENV            HENJI_OPENROUTER_API_KEY
MAX_CREDENTIAL_BYTES  4096
```

Any launcher argument causes a sanitized failure before file access or child creation.

### Metadata and bounded read

Only the later, explicitly authorized one-shot command may exercise the production reader. It must:

1. `lstat` the exact path and require a non-symlink regular file, exact mode `0600`, size `1..4096`, and a
   file UID equal to the effective process UID. If the Linux UID fields needed for this contract are
   unavailable, fail closed.
2. Open the file and repeat type, mode, owner, and size checks on the handle. Compare available device/inode
   fields with the pre-open metadata.
3. Read no more than `MAX_CREDENTIAL_BYTES + 1`; reject oversize, short/changed file, or read failure.
4. Close the handle before parsing or reporting any outcome.

This is a trusted-local, single-user boundary. Complete defense against a hostile same-user replacement race
is not an acceptance condition, but symlink, type, permission, owner, size drift, and unbounded reads fail
closed.

### Content parser

- Decode fatal UTF-8; do not continue with replacement characters.
- Reject NUL and all C0/C1 control characters.
- Permit no terminal newline, exactly one LF, or exactly one CRLF; remove it once.
- Reject remaining CR/LF, multiple lines, multiple terminal newlines, an empty token, and any Unicode
  whitespace in or around the token.
- Do not impose a provider-specific prefix, alphabet, or minimum length.
- Never place the parsed value in a log, error, report, JSON, argv, or file.

A malformed real file consumes the later one-shot attempt and does not cause an automatic repair or rerun.

### Exact child

After successful validation, create at most one child equivalent to:

```ts
new Deno.Command(DENO_COMMAND, {
  args: [
    "run",
    "--no-prompt",
    "--no-remote",
    "--allow-env=HENJI_OPENROUTER_API_KEY",
    "--allow-net=openrouter.ai",
    "--allow-read=v0/corpus/task-corpus.v1.json,deno.v0.json",
    "v0/eval/live_corpus_cli.ts",
    "sentinel",
  ],
  cwd: CHILD_CWD,
  clearEnv: true,
  env: { HENJI_OPENROUTER_API_KEY: credential },
  stdin: "null",
  stdout: "inherit",
  stderr: "inherit",
});
```

- The child environment contains exactly the secret variable; caller environment, `PATH`, and `HOME` are not
  inherited.
- Stdout/stderr are not captured or duplicated; the existing sanitized live report remains authoritative.
- Normal child exit codes propagate. Signals use an allowlisted `128 + signal number` mapping; unknown signals
  map to exit 1.
- Metadata/content/spawn failures print one allowlisted static error code to stderr, leave stdout empty, and
  never expose a raw OS message, path-bearing exception, stack, or credential fragment.
- No failure path creates a second child.

### Parent task permissions

Add a production task conceptually equivalent to:

```text
agent:corpus:eval:live:sentinel:credential-file
  <embedded-deno> run --no-prompt
  --allow-read=/home/masat.guest/.config/henji-harness/openrouter-api-key
  --allow-run=/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno
  v0/eval/live_corpus_credential_launcher.ts
```

The parent gets no env, net, or write permission. This production task must not be reachable from `v0:gate`
or another local task.

## Ordered implementation

1. Add `v0/eval/live_corpus_credential_launcher.ts` with fixed constants, allowlisted errors, injected
   filesystem/process seams, metadata validation, bounded decoding, and parsing.
2. Add single-child orchestration and verify exact executable, argv, cwd, `clearEnv`, one-key env, stdio,
   exit/signal behavior, zero spawn before validation, and at most one spawn overall.
3. Add `tests/v0/live_corpus_credential_launcher_test.ts`. It must run permission-free using dummy data only
   and cover empty/oversize/invalid UTF-8/control/whitespace/newline cases plus metadata and redaction failures.
4. Add a narrowly scoped process test and fixture if needed. It may have only exact embedded-Deno run
   permission, uses an injected dummy credential, verifies argv/env/stdin/stdout/stderr/exit/reap behavior, and
   must not read the real file or access network.
5. Update `deno.v0.json` with focused direct/process tasks, source/test check/gate entries, and the production
   launcher task. Gate-topology tests must prove the production task is unreachable locally and each task has
   only its specified permissions.
6. Add `docs/plans/repo-external-credential-launcher-results.md` mapping requirements to files/tests,
   commands, counts, permission topology, dummy-only evidence, deviations, review, and unperformed work.

Implementation ownership is limited to the new launcher, its tests/fixture/results, and the associated
`deno.v0.json` entries. `AGENTS.md` and `.handoff/handoff.md` remain default-agent lifecycle bookkeeping. If an
existing live runner, CLI, adapter, corpus, scorer, or normal runtime must change, stop and report a plan
deviation instead of expanding scope.

## Local verification and review

Use repository-defined tasks after adding the focused entries. At minimum run the focused direct/process
tests, existing live/offline/corpus/runtime/transport tests, `v0:check`, `v0:fmt`, `v0:lint`, `v0:test`,
`v0:gate`, and `git diff --check`. Do not run the production launcher, existing live sentinel/canonical,
normal production run, or acceptance provider path. Do not probe, stat, or read the real credential.

Review is read-only and bounded to 30 minutes, stopping after 10 minutes without new evidence. It covers fixed
constants, bounded parsing, metadata checks, zero-secret errors, exact child environment, single-spawn/status
behavior, permissions, local-gate non-reachability, and preservation of existing live behavior. One
changed-lines re-review is allowed for 15 minutes. Human Gate S requires review `GO` with Blocker/P1/P2 zero.

## Human Gate L: local implementation

Approval of Gate L authorizes only the launcher, dummy-only direct tests, fake-child process test,
task/check/gate integration, results document, local verification, and bounded review. It does not authorize
reading/probing the real credential, network/provider access, a sentinel attempt, Gate C, or repository
publication operations.

## Human Gate S: one new sentinel attempt

After Gate L is complete and reviewed `GO`, present a separate explicit approval request containing:

- exact six sentinel IDs/order and the unchanged profile/model/endpoint/method/stream/completion bounds;
- maximum 12 external requests, worst case USD 0.746496, authorization ceiling USD 0.768, and zero application
  retry/fallback/rerun/follow-up;
- this plan revision/hash plus local test and review evidence;
- a fresh official OpenRouter readback for model availability, tool support, and pricing, with URL/timestamp;
- notice that the credential is first read inside this one command and is not put in output, argv, or repo;
- notice that missing/malformed credential also consumes the attempt and will not be rerun.

The separately approved exact command is:

```sh
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --quiet \
  --config deno.v0.json agent:corpus:eval:live:sentinel:credential-file
```

No separate credential probe occurs. Stop without retry/rerun/fallback/follow-up on fresh-fact conflict,
metadata/content failure, spawn/signal/provider/contract/scoring/report/redaction anomaly, or any indication
that the 12-request limit or secret boundary could be exceeded. Gate C remains closed.

Record only a secret-free outcome summary: command count/status, allowlisted preflight result, child count,
suite/report and task IDs, external-request and result counts, abort code/task, zero retries, fresh official
readback, and unperformed Gate C. Do not persist raw stdout/stderr, provider bodies, exceptions, stacks,
Authorization data, or credential values.

## Completion and rollback

Local completion requires the fixed launcher and strict parser, passing direct/process/full local gates with no
real credential/provider use, production-task non-reachability, review `GO`, and no changes to the credential,
adapter/profile, corpus/scorer, or normal runtime.

One-shot completion requires a fresh official readback within the ceiling, exactly one production launcher
command, at most one credential read and child, a sanitized recorded outcome, and no automatic rerun regardless
of result.

Rollback removes only the additive launcher, tests/fixture/results, related `deno.v0.json` entries, and
lifecycle bookkeeping. It must not reset the worktree or touch the credential, existing live implementation,
or consumed Gate B evidence. Provider requests and charges are irreversible.
