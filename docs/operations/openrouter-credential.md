# OpenRouter credential location

## Guest VM location

The Henji Harness OpenRouter credential is kept outside the repository at:

```text
/home/masat.guest/.config/henji-harness/openrouter-api-key
```

Metadata observed on 2026-08-25 without reading the file contents:

| Path | Type | Owner | Mode | Size |
| --- | --- | --- | --- | ---: |
| `/home/masat.guest/.config/henji-harness` | directory | `masat:masat` | `0700` | 4096 bytes |
| `/home/masat.guest/.config/henji-harness/openrouter-api-key` | regular file | `masat:masat` | `0600` | 75 bytes |

The initially supplied spelling `/home/masat.guest/.config/henji-herness` does not exist. Other
similarly named configuration directories exist, but they are not the recorded Henji Harness
credential location.

## Handling rules

- Keep the credential outside the repository. Do not move or copy it into this tree.
- Do not display, log, commit, or record its contents.
- The legacy eval credential launcher reads this exact file in its parent process and passes the
  validated value only through `HENJI_OPENROUTER_API_KEY` to the fixed child environment. Its local
  implementation and boundary are recorded in
  [`repo-external-credential-launcher-results.md`](../plans/repo-external-credential-launcher-results.md).
- Normal Worker production composition uses `readCredentialFile` from
  [`credential_file.ts`](../../v0/agent/provider/credential_file.ts) as a request-time source for
  [`worker_physical_io.ts`](../../v0/agent/worker/worker_physical_io.ts). Both the interactive TUI
  and noninteractive `agent:run` enter this Worker composition. It validates the fixed path and reads
  the source for each provider request; it does not cache the value or put it in command arguments.
  The adapter then places the resolved value in the provider Authorization header for that request.
- File content/format and current validity have not been inspected or verified in this document.
  Any content read, credential injection, remediation, or provider attempt requires its own explicit
  authorization.

This document records location and non-secret metadata only. It is not evidence that the credential
is valid or currently accepted by OpenRouter.

## Historical provider results

Past separately authorized sentinel, FR1, and Gate 1 runs have their execution and acceptance
evidence in [`pi-style-json-result-submission-results.md`](../plans/pi-style-json-result-submission-results.md),
[`fr1-real-provider-human-acceptance-results.md`](../plans/fr1-real-provider-human-acceptance-results.md),
and [`gate-1-general-agent-production-acceptance-results.md`](../plans/gate-1-general-agent-production-acceptance-results.md).
Those historical outcomes do not establish the credential's current validity or authorize another
provider run.

## Provider pricing preflight

- Small bounded tests do not require a routine price refresh.
- A material expected cost requires an official provider price refresh and an estimate before
  execution.
- Model availability and API/tool contract uncertainty are separate checks from price confirmation.
- An explicit gate-specific requirement takes precedence; the Worker corrections plan §7 requires a
  fresh official model and price readback before its Human Gate.
- Production provider commands require explicit authorization, and automatic retry/fallback is not
  performed without separate explicit authorization.

## Production CLI basic E2E

`deno task --config deno.v0.json agent:e2e:live --confirm-external-call` exercises the normal
`runtime_cli_launcher.sh` → headless Host / Worker route. The E2E orchestrator does not read the
credential and does not receive it through an environment variable or command argument. The child
production Worker uses the same fixed request-time credential source described above.

The task is not called by `v0:test`, `v0:gate`, CI, publish, or release automation. A user must
explicitly authorize each live invocation; implementation or offline-test approval does not count
as that authorization. One invocation runs one fixed `read`-tool scenario, expects two provider
requests, has no automatic retry, and retains its workspace, child stdout/stderr, provider evidence,
and Worker execution artifact under the reported `/tmp/henji-production-e2e-*` directory.
