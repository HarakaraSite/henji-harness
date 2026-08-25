# Normal CLI offline process E2E results

## Acceptance package

- Plan: `docs/plans/normal-cli-offline-process-e2e.md`
- Plan SHA-256: `8b4514b276a6c8d4b168181b322d84fbadca7b50b1eba116c91799906077013a`
- Approval: user-approved test-only implementation, offline validation, results, and bounded review
  on 2026-08-25.
- Scope: independent offline OS-process coverage for the normal CLI runtime. No production provider
  operation, credential access, product/shared runtime change, dependency, lockfile, persistent state,
  task corpus, eval, live E2E, fuzz, load, or soak work.

## Implemented behavior

- `tests/v0/fixtures/runtime_process_fixture.ts` is a test-only child entrypoint. It accepts only
  `argv-success`, `stdin-success`, `runtime-failure`, and `tty`, removes that fixture mode, and
  passes the remaining application argv to the existing `main` function. It injects only a dummy
  credential and deterministic in-memory fake fetch through `runtimeSeam`; it does not inject a
  replacement `run` function.
- `tests/v0/agent_runtime_process_test.ts` builds the exact embedded Deno command, writes and closes
  the child stdin pipe, captures stdout/stderr with 16 KiB per-stream limits, enforces a 2-second
  deadline, kills on timeout/overflow, and awaits `child.status` so a killed child is reaped.
- Three separate harness-safety tests exercise the timeout, stdout-overflow, and stderr-overflow
  branches with permission-free `deno run -` children, a test-local 100 ms deadline, and live
  intervals that keep each child alive until the harness kills and reaps it. These tests do not add
  fixture modes or alter the six-case product process matrix.
- The focused parent task has exactly `--allow-run=/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno`
  and `--allow-read=deno.v0.json`. The child uses `clearEnv: true`, `env: {}`, no permission grants,
  `--no-prompt`, and `--no-remote`; its constructed argv contains no `--allow-*` option.
- `deno.v0.json` integrates `agent:runtime:process:test`, the fixture/test into `v0:check`, and the
  focused task into `v0:gate`. `README.md` documents the focused command only.

## Exact process matrix

| Case | Child argv/application input | Observed result | Fake request / termination |
| --- | --- | --- | --- |
| topology/config | `run --no-prompt --no-remote <fixture> argv-success --task '  argv task  '` | exact command topology; production task literals unchanged | config-only case; no child run |
| argv success | mode `argv-success`, `--task '  argv task  '`; terminal seam `true` | exit 0; stdout `offline argv answer\n`; stderr empty | task `argv task`; fake request 1; natural exit |
| piped stdin success | mode `stdin-success`; stdin bytes `  piped task\n` | exit 0; stdout `offline stdin answer\n`; stderr empty | task `piped task`; fake request 1; natural exit |
| preflight failure | mode `tty`, `--unknown`; terminal seam `true` | exit 1; stdout empty; exact compact `invalid_input` JSON with all counters 0 | fake request 0; natural exit |
| runtime failure | mode `runtime-failure`, `--task valid`; terminal seam `true` | exit 1; stdout empty; exact compact `agent_failure` JSON with steps/request `1/1`; sensitive marker absent | fake request 1, rejected locally; natural exit |
| prompt termination | mode `tty`, no application argv, stdin closed; terminal seam `true` | exit 1 before 2 seconds; stdout empty; exact preflight JSON; all counters 0 | fake request 0; natural exit, kill not fired |

The success fake validates the normalized task in the provider request body before returning the
fixed final text. The runtime-failure fake rejects with a sensitive marker, which is absent from the
CLI failure record. No fake fetch delegates to network; actual provider/network calls were 0.

## Harness-safety evidence

The three harness-only tests are separate from the six planned process cases:

| Harness branch | Child | Observed result |
| --- | --- | --- |
| timeout | permission-free `deno run --no-prompt --no-remote -`, live interval, 100 ms local deadline | non-success, `killed: true`, no overflow, completion under 1 second |
| stdout overflow | same child shape, writes 16 KiB + 1 byte to stdout, live interval | non-success, `killed: true`, stdout overflow only, completion under 1 second |
| stderr overflow | same child shape, writes 16 KiB + 1 byte to stderr, live interval | non-success, `killed: true`, stderr overflow only, completion under 1 second |

Each helper awaits `child.status` before returning, providing the reap boundary; no child remains
running after any safety test.

## Offline validation

All commands used the embedded Deno 2.9.4 binary at
`/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno`. The required focused/direct/check/format/
lint/full/gate sequence completed successfully:

| Command | Result |
| --- | --- |
| `agent:runtime:process:test` | 9 passed, 0 failed (6 matrix + 3 harness-safety) |
| `agent:runtime:test` | 14 passed, 0 failed |
| `v0:check` | pass |
| `v0:fmt` | pass, 33 files checked |
| `v0:lint` | pass, 31 files checked |
| `v0:test` | 101 passed, 0 failed |
| `v0:gate` | pass; includes focused 9, direct 14, and full 101 |
| `git diff --check` | pass |

The focused command was:

```text
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --config deno.v0.json agent:runtime:process:test
```

No production `agent:run` or `agent:acceptance` task was executed. The test reads only the
non-secret `deno.v0.json` task definitions and asserts the existing `agent:run` and
`agent:acceptance` strings are unchanged. Production credential presence and values were not
checked or read.

## Requirement mapping

| Requirement | Evidence |
| --- | --- |
| OS process argv/stdin/exit/stdout/stderr boundary | five process cases spawn embedded Deno and assert exact inputs, statuses, and channels |
| Child isolation | exact `--no-prompt --no-remote`, no child `--allow-*`, `clearEnv`, empty env, and focused parent permission assertions |
| Actual normal runtime composition | fixture calls `main` with `runtimeSeam` only; fake validates request task and returns provider-shaped responses |
| Exact six-case matrix | six focused tests, including topology/config and five process cases |
| Harness timeout/overflow safety | three separate focused tests cover timeout, stdout overflow, and stderr overflow with kill/reap |
| Timeout/reap/output boundary | shared harness implements 2-second deadline, 16 KiB stream caps, kill, and awaited status reap |
| Production boundary | production task literals are asserted unchanged and neither production task is invoked |
| Existing behavior | direct runtime, check, format, lint, full v0 suite, and integrated gate pass |

## Changed files

- `tests/v0/fixtures/runtime_process_fixture.ts`
- `tests/v0/agent_runtime_process_test.ts`
- `deno.v0.json`
- `README.md`
- `docs/plans/normal-cli-offline-process-e2e-results.md`

## Provider, credential, review, and risk status

- Provider/network calls: 0. The only request starts were calls to the in-memory fake fetch inside
  the child (success 1 each, runtime failure 1, preflight/TTY 0).
- Production credentials were neither inspected nor read. No production command, dependency,
  lockfile, persistent state, commit, push, tag, release, publish, or destructive operation was
  performed.
- Independent review initially returned two P2 findings: `v0:gate` inclusion/exclusion lacked a
  direct exact-segment assertion, and the timeout/overflow kill/reap branches were not exercised.
  Both were fixed without changing the six-case/four-mode contract. The one changed-lines-only
  re-review returned GO with Blocker/P1/P2 zero.
- Remaining risks are those explicitly deferred by the plan: the TTY result uses the existing seam
  rather than a real PTY; fake provider behavior does not establish live provider availability,
  credential validity, or model quality; a 2-second deadline could be scheduler-sensitive; broader
  corpus/eval/live/fuzz/load/soak coverage remains out of scope.
