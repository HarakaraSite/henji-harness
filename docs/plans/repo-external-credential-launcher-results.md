# Repo-external credential launcher local-gate results

## Scope and authority

- Plan: `docs/plans/repo-external-credential-launcher.md`
- Plan SHA-256: `c8841539fea5ec10479c81c77da53bab0713707d80cdad3b46a7e87a4fe9afd9`
- Gate: Human Gate L, local implementation only
- Evidence date: 2026-08-25
- No additional production credential/provider access or sentinel attempt was used for this local
  parser fix; the prior one-shot outcome remains recorded below. Persistence and publication
  operations were not used.

## Implemented files

- `v0/eval/live_corpus_credential_launcher.ts`
  - fixed credential path, executable, cwd, entrypoint, suite, environment key, and 4096-byte
    bound;
  - fail-closed lstat/open-handle metadata checks for regular non-symlink `0600` files owned by
    the effective UID, including size and available device/inode identity checks;
  - bounded read, fatal UTF-8 decoding, terminal newline handling, control/Unicode-whitespace
    rejection, static failure codes, exact clear-environment child composition, and exit/signal
    propagation; the parser now removes any terminal sequence of LF and/or complete CRLF pairs;
- `tests/v0/live_corpus_credential_launcher_test.ts`: permission-free dummy filesystem/process
  seam tests;
- `tests/v0/live_corpus_credential_launcher_process_test.ts` and
  `tests/v0/fixtures/live_corpus_credential_launcher_process_fixture.ts`: embedded-Deno process
  boundary with a fake child and dummy secret;
- `tests/v0/fixtures/live_corpus_credential_launcher_fake_child.ts`: isolated fake child that
  checks the allowlisted secret environment, rejects inherited `PATH`, verifies null stdin, and
  emits no secret;
- `tests/v0/live_corpus_credential_launcher_topology_test.ts`: task permissions and gate topology
  assertions;
- `deno.v0.json`: focused direct/process/topology tasks, check/gate coverage, and the separately
  authorized production launcher task;
- this results package.

## Local evidence

| Check | Result |
| --- | --- |
| `agent:corpus:eval:live:credential-launcher:test` | 8 passed, 0 failed |
| `agent:corpus:eval:live:credential-launcher:process:test` | 1 passed, 0 failed |
| `agent:corpus:eval:live:credential-launcher:topology:test` | 1 passed, 0 failed |
| `v0:check` | passed |
| `v0:fmt` | passed, 49 files |
| `v0:lint` | passed, 46 files |
| `git diff --check` | passed |
| `v0:test` | 144 passed, 0 failed |
| `v0:gate` | passed; included 14 offline, 10 live-runner, 8 direct-launcher, 1 process-launcher, 1 topology, 9 corpus, 9 runtime-process, 14 runtime, 6 JSON-key, 10 acceptance, 10 transport, 12 loop, 8 selection, 32 baseline tests |

The direct tests cover empty and oversize input, malformed UTF-8, C0/C1 controls, Unicode
whitespace, single and multiple LF/CRLF terminal forms including a mixed suffix, embedded newline,
bare CR, metadata/type/mode/owner/size/device/inode failures, short/changed reads,
close/read/open/spawn/wait redaction boundaries, no spawn before validation, exact child
argv/cwd/stdio/clear-env/one-key environment, status propagation, and allowlisted signal mapping.
The focused direct task remains 8 passed, 0 failed.

## Approved parser fix

- Structural cause confirmed by the user: the credential had multiple terminal newline sequences,
  which the previous one-newline-only parser rejected as `credential_invalid`.
- Approved local semantics: accept no terminal newline, or any non-empty suffix made solely from LF
  endings and/or complete CRLF pairs; strip only that suffix before token validation.
- Unchanged safety boundary: a bare CR, any CR/LF remaining in the token body, empty-after-strip,
  fatal UTF-8, NUL/C0/C1 controls, and Unicode whitespace remain rejected. No broader whitespace
  trimming or provider-specific token assumptions were added.
- Read-only review is `GO`; Blocker/P1/P2 are all zero. Reviewer reran the direct 8, process 1,
  topology 1, and diff checks without touching the real credential or provider path.

The process test uses only the exact embedded Deno `--allow-run` permission. It injects a dummy
credential through the test filesystem seam and replaces the child target only inside the test
seam; it does not read the recorded credential path or access the network. The topology test
confirms the production launcher task is absent from `v0:gate`, while the direct/process/topology
tasks retain their narrow permissions.

## Permission topology

- Direct dummy tests: no filesystem, environment, network, or process permission.
- Process fake-child test: `--allow-run=<embedded Deno>` only.
- Topology test: `--allow-read=deno.v0.json` only, for task readback.
- Production launcher task: fixed `--allow-read` for the recorded external credential, fixed
  `--allow-run` for embedded Deno, and the narrowly scoped `--allow-sys=uid` needed by Deno 2.9.4
  to perform the effective-UID ownership check; no broader system, environment, network, or write
  permission is granted to the parent. The production task is not in `v0:gate`.
- Child composition: clear environment with only `HENJI_OPENROUTER_API_KEY`, fixed network/read
  permissions, inherited stdout/stderr, and null stdin.

## Deviations and unperformed work

- No additional provider command, production launcher invocation, credential probe/stat/read,
  network call, retry, fallback, rerun, follow-up, persistence, aggregation, Gate C, commit, push,
  tag, publish, or release was performed for this fix. The consumed one-shot attempt was not
  retried or rerun.
- Accepted local plan delta: on this Deno 2.9.4 VM, `Deno.uid()` requires `--allow-sys=uid` for
  the required effective-UID ownership check. The production task now grants exactly that narrow
  system query; the topology test asserts the exact sys permission and rejects broader
  system/environment/network/write permissions. No production invocation was used to validate it.
- Initial independent review found one P1: the production parent lacked the Deno permission required
  for its approved UID ownership check. The narrowly scoped `--allow-sys=uid` plan delta above was
  accepted and applied. Changed-lines re-review is `GO`; Blocker/P1/P2 are all zero.

## Human Gate S one-shot outcome

- Authorization and execution time: 2026-08-25 23:02 JST.
- Command count: exactly one invocation of
  `agent:corpus:eval:live:sentinel:credential-file`.
- Exit: 1; allowlisted launcher outcome: `credential_invalid`.
- The fixed credential file passed metadata/open/read handling and failed content parsing. Its value,
  bytes, format details, fragments, raw exception, and stack were not displayed or recorded.
- Child spawn count: 0. External provider requests: 0. Retry, fallback, rerun, and follow-up: 0.
- No live report was created; all six selected sentinel cases remained unattempted.
- Fresh official readback immediately before authorization confirmed the exact model remained listed,
  accepted tool calling, and retained USD 0.375/M input and USD 1.875/M output pricing. The approved
  maximum remained 12 requests and USD 0.768, but no provider cost was incurred by this attempt.
- Gate C is ineligible and was not authorized or run. Any further credential inspection/change or
  new sentinel attempt requires a separate explicit approval; this local parser fix does not
  authorize either operation.

## Post-fix one-shot sentinel outcome

- Authorization and execution time: 2026-08-25 23:53 JST.
- Command count: exactly one invocation of
  `agent:corpus:eval:live:sentinel:credential-file`; exit 1.
- Launcher preflight succeeded and spawned exactly one fixed child. The credential value and bytes
  were not displayed, logged, placed in argv, or recorded.
- Report: schema 1, `henji-live-corpus-eval-v1`, `sentinel_v1`, completion `completed`.
- Counts: total 6, completed 6, passed 5, failed 1, errors 0, not-run 0.
- External requests: 12 of 12. Retry, fallback, rerun, and follow-up: 0.
- Passing cases: character count, JSON-array count, final-only echo, JSON-object-key listing, and
  uppercase text.
- Failed case: `v1.multi-tool.fmt.explicit`. Both required tools ran successfully in the required
  order and produced the expected count, but the final `{"count":3}` value was wrapped in a
  Markdown JSON code fence. The strict whole-text JSON oracle therefore returned
  `oracle_json_malformed`.
- No provider/contract error, abort, raw provider body, exception, stack, Authorization data, or
  credential data was recorded. Raw stdout/stderr was not persisted in the repository.
- Gate C is ineligible because the sentinel did not pass 6/6. It was not authorized or run. The
  sentinel was not rerun.
