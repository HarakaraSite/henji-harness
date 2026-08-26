# Zot-first AGENTS.md context discovery — implementation results

Plan: `docs/plans/zot-agents-context-discovery.md`  
Plan SHA-256: `ca808291d0c2548f76cd0cd17b790960bd3ffbdb2e848ef325d41ffe7e5e107c`

## Implementation outcome

The approved local slice is implemented in the normal `agent:run` composition only. The runtime
resolves its canonical workspace once, checks `AGENTS.md` and then `AGENTS.MD` in that directory,
and passes one bounded accepted file as an optional provider-neutral system instruction. The system
instruction is not a `Message` and is not retained in `LoopOutcome.transcript`.

Discovery accepts only regular, non-symlink files, observes at most 16,385 raw bytes, accepts at
most 16,384 UTF-8 bytes, rejects malformed UTF-8, NUL, and blank content, and silently skips all
invalid or failed reads. The first present candidate wins, including when its content is invalid.
The OpenRouter adapter emits exactly one first-position `system` message on every request when the
instruction is present, while no-context requests retain their existing wire shape. Existing
message and request bounds still include the system message.

## Requirement-to-evidence map

| Requirement | Implementation and direct evidence |
| --- | --- |
| Workspace-only exact selection | `v0/agent/agent_instructions.ts`; `agent_instructions_test.ts` selection, ignored spelling, and first-present cases; process fixture uses an actual disposable workspace file. |
| Regular non-symlink and special-file rejection | `agent_instructions_test.ts` file-type matrix and opened-handle type recheck; actual process symlink-primary case. |
| 16 KiB bounded read | `agent_instructions_test.ts` exact 16,384 acceptance, 16,385 rejection, observed-byte, and close assertions. |
| UTF-8, BOM, NUL, blank handling | `agent_instructions_test.ts` decoder cases. |
| Silent filesystem failures | `agent_instructions_test.ts` lstat/open/read/stat failure cases; process tests assert stable stdout/stderr channels. |
| Provider-neutral separation | `contracts.ts`, `loop.ts`; `agent_loop_test.ts` proves identical propagation and absence from transcript/outcome. |
| System-first transport ordering | `openrouter_model.ts`; `agent_openrouter_model_test.ts` proves exactly-once system ordering on first and causal second requests. |
| Prefetch validation and bounds | `agent_openrouter_model_test.ts` proves invalid system input, the 76 KiB message bound, and a system-tipped 256 KiB full request fail before credential/fetch. |
| Normal-runtime-only composition | `runtime.ts`; `agent_runtime_test.ts` and existing corpus/eval suites remain separate. |
| Five tools, eight requests, no retry | Existing runtime tests plus the context runtime test retain the fixed five-tool profile, max-eight behavior, and request counts. |
| Process channels and permissions | `runtime_process_fixture.ts`, `agent_runtime_process_test.ts`, and `agent_instructions_topology_test.ts` prove system-first body, symlink-primary rejection, parent/sibling non-discovery and non-leakage, final-only channels, natural exit, unchanged `agent:run`, and no ancestor/global permission. |
| Gate wiring | `deno.v0.json` includes the source files and the two focused instruction tasks exactly once in `v0:gate`; the topology test checks the literals. |
| User documentation | `README.md` documents selection, limits, validation, silent skip, system role, and workspace-only scope. |

## Verification

All commands used the repository-pinned Deno 2.9.4 binary. Results below are from the completed
local run on 2026-08-26:

- `deno task --config deno.v0.json agent:instructions:test`: 8 passed.
- `deno task --config deno.v0.json agent:instructions:topology:test`: 1 passed.
- `deno task --config deno.v0.json agent:test`: 22 passed.
- `deno task --config deno.v0.json agent:transport:test`: 13 passed.
- `deno task --config deno.v0.json agent:runtime:test`: 11 passed.
- `deno task --config deno.v0.json agent:runtime:process:test`: 13 passed.
- `deno task --config deno.v0.json v0:check`: passed; 61 files checked.
- `deno task --config deno.v0.json v0:fmt`: passed; 58 files checked.
- `deno task --config deno.v0.json v0:lint`: passed; 58 files checked.
- `deno task --config deno.v0.json v0:test`: 195 passed, 0 failed.
- `deno task --config deno.v0.json v0:gate`: passed; all focused and full offline steps completed,
  with 195 tests passed and 0 failed.
- `git diff --check`: passed.

No production provider command, network request, credential read, live sentinel, dependency or
lockfile change, persistent-state operation, `_refs/` operation, commit, push, tag, or release was
performed. The existing unrelated working-tree changes were preserved.

Initial independent review returned NO-GO with Blocker 0 / P1 0 / P2 2. Both findings were test-
evidence gaps: system-tipped full-request pre-credential accounting, and actual filesystem evidence
for symlink-primary rejection plus ancestor/sibling non-discovery. The focused fixes added those
regressions without changing product source, permissions, or contracts. One bounded changed-lines
re-review confirmed both findings closed and returned `GO`, Blocker 0 / P1 0 / P2 0. The repository
owner independently reran instructions 8, transport 13, process 13, and the full 195-test gate.

## Deliberate deviations and remaining risks

The implementation intentionally does not adopt Zot's global or ancestor instruction layering,
`$ZOT_HOME`, `SYSTEM.md`, or absolute host-path headings. Those behaviors require a separate
workspace and permission contract. Invalid files are silently skipped by design, and the feature
does not semantically sanitize instruction text; accepted text is trusted-local model input. The
`lstat`/open sequence reduces ordinary mistakes but is not a hostile same-user race boundary.
System text consumes the existing message budget, so large context can reach the existing limits
sooner; compaction and diagnostics remain out of scope.
