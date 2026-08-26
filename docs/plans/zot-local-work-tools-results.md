# Zot-first local work tools — local acceptance package

Plan: [`zot-local-work-tools.md`](zot-local-work-tools.md), SHA-256
`be8fdd758ca3efe62bf1058a7a6d21c41a47cdc2ed436a87c58aaa3a38f3608e`.

## Implementation

- `v0/agent/work_tools.ts` implements the canonical workspace resolver, component and symlink
  checks, UTF-8/64 KiB text boundary, atomic sibling replacement, exact edit validation, and
  bounded `/bin/bash` execution with clean environment, separate capture, timeout escalation,
  mandatory direct-child status/reaping, and an independently bounded post-exit/timeout capture
  grace when descendants retain pipes.
- `v0/agent/registries.ts` separates the exact corpus five-tool registry from the production
  `bash`, `edit`, `read`, `submit_json_result`, `write` registry.
- `v0/agent/runtime.ts` resolves one workspace per invocation and composes production tools only;
  eval runners import the corpus factory.
- Runtime/process fixtures, focused tests, Deno task permissions, and README document the
  invocation-as-authorization model and the fact that Bash is unrestricted trusted-local OS-user
  execution rather than a workspace sandbox. Process acceptance validates each prior work result,
  observes the final workspace file from the parent, and covers traversal/symlink rejection plus
  bounded timeout recovery.

## Requirement evidence

`agent_work_tools_test.ts` covers relative/in-root absolute paths, traversal and sibling-prefix
rejection, malformed Unicode/NUL, symlinks, directories, UTF-8 and exact byte boundaries, missing
parents, mode preservation, atomic failure cleanup, edit uniqueness/overlap/concurrency, Bash
argv/cwd/environment, separated output, truncation, signals, timeout escalation to SIGKILL for a
TERM-ignoring child, direct-child reaping, and fixed diagnostics.
`agent_runtime_test.ts` covers exact production definitions, causal work-tool rounds, ordered
multiple calls, terminal submission on request eight, max-step/no-ninth behavior, retry-zero, and
CLI channels. `agent_runtime_process_test.ts` runs an isolated Deno child with fake provider and
temporary workspace permissions only.

## Local verification

The following were run with the repository-pinned Deno 2.9.4 binary and no provider, network,
credential, production command, dependency/lockfile, persistent-state, or `_refs` operation:

- `deno task --config deno.v0.json agent:work-tools:test`: exit 0, 13 passed.
- `deno task --config deno.v0.json agent:runtime:test`: exit 0, 10 passed.
- `deno task --config deno.v0.json agent:runtime:process:test`: exit 0, 11 passed.
- `deno task --config deno.v0.json agent:test`: exit 0, 20 passed; `agent:transport:test`: exit 0,
  11 passed; `agent:acceptance:test`: exit 0, 10 passed; selection 8, JSON keys 6, corpus 9,
  offline eval 14, live fake 10, launcher 8 + 1 + 1 passed.
- `deno task --config deno.v0.json v0:check`: exit 0; `v0:fmt`: exit 0; `v0:lint`: exit 0;
  `v0:test`: exit 0, 164 passed; `v0:gate`: exit 0; `git diff --check`: exit 0.

The initial independent review was `NO-GO` with Blocker 0, P1 1, and P2 2. The single changed-lines
re-review confirmed both P2 fixes (Linux backslash path identity and process acceptance evidence)
but found the Bash direct-child reap portion of P1 incomplete. The owner final gate closed that
remaining P1 with direct evidence: a TERM-ignoring `exec sleep 5` returns bounded with
`signal:"SIGKILL"`, final status, and a failed post-return `kill -0` probe; the descendant-pipe
regression remains green. Final owner disposition is Blocker/P1/P2 zero.

## Deviations and remaining risks

No plan deviation, new dependency, provider path, corpus/scorer/report contract change, permission
expansion, or new production authorization was introduced. Bash can access outside the workspace,
network, and same-user files, and background descendants may survive timeout cleanup. Symlink
checks, snapshot reread, and rename do not eliminate hostile same-user TOCTOU or hard-link behavior.
File sync and rename provide atomic visibility but not directory-fsync crash durability.
