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
- The current live model adapter reads only `HENJI_OPENROUTER_API_KEY`; it does not read this file
  directly.
- A future approved launcher may read this exact file in the parent process and pass the value only
  through `HENJI_OPENROUTER_API_KEY`. Do not put the value in command arguments.
- File content/format has not been inspected or verified. Any content read, credential injection,
  remediation, or provider attempt requires its own explicit authorization.

This document records location and non-secret metadata only. It is not evidence that the credential
is valid or currently accepted by OpenRouter.
