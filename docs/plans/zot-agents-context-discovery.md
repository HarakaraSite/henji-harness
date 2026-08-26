# Zot-first AGENTS.md context discovery — implementation and verification plan

## Decision summary

Concept **GO, initial Human Gate pending**.

The next normal `agent:run` increment will optionally discover one bounded instruction file at the
canonical workspace root and pass it to every model request as a first-class system instruction.
It will not concatenate instructions with the user task or store them in the agent transcript.

This first slice adopts Zot's standing-instruction and system-prompt separation, with one deliberate
scope reduction: it reads only the invocation workspace's direct `AGENTS.md` candidate. It does not
read `$ZOT_HOME`, `$HOME`, filesystem ancestors, children, siblings, or a VCS root. Zot's full
global-to-root-to-cwd layering would require broadening the current Deno `--allow-read=.` boundary;
that is a separate product and permission decision, not an implementation detail hidden in this plan.

Planning base revision: `b9d4f01`.

## Current verified state

- `v0/agent/contracts.ts` gives `ModelRequest` only `transcript` and `tools`.
- `v0/agent/loop.ts` constructs each request from those values and retains a maximum of eight model
  requests with no application retry.
- `v0/agent/openrouter_model.ts` emits only user, assistant, and tool wire messages. It enforces a
  76 KiB serialized-message bound, a 256 KiB full-request bound, and a 1 MiB response bound.
- `v0/agent/runtime.ts` resolves the canonical workspace once, constructs the production five-tool
  registry and fixed OpenRouter model, and invokes the provider-neutral loop.
- `agent:run` already has `--allow-read=.` for its workspace file tools. This plan does not broaden
  that permission or add environment access.
- The normal CLI writes only final output to stdout on success and one sanitized JSON line to stderr
  on failure.
- Corpus/eval registries and runners are separate from the normal runtime.
- The local baseline is 179 tests. The fixed work-tools Gate S passed once at revision `51916c8` and
  is consumed; it will not be rerun by this increment.
- `_refs/deno-docs/`, `_refs/pi/`, and `_refs/zot/` are untracked read-only reference state and are
  not implementation or commit targets.

## Reference evidence and adoption decisions

The first reference is MIT-licensed Zot commit
`9b7bb6a4f36bc8c8deb2cc5796a8f557f4fb7479`.

| Pinned Zot evidence | Henji decision | Reason |
| --- | --- | --- |
| `_refs/zot/README.md`, persistent-instructions section: `AGENTS.md` augments the system prompt | Adopt | Standing instructions retain their real authority instead of becoming user-task text |
| `_refs/zot/packages/agent/build.go`, `loadAgentsContext` and `formatAgentsContext`: optional discovery, filename priority, blank/read-error skip, dedup, section formatting | Adopt with bounded contract | Best-effort context must not change normal stdout/stderr or become unbounded input |
| Same source: `$ZOT_HOME` first and filesystem root-to-cwd traversal | Defer | It requires implicit global state and ancestor read permission outside the canonical workspace |
| Same source: absolute host paths in section headings | Deviate | Henji sends only `./AGENTS.md` or `./AGENTS.MD`, avoiding host path disclosure |
| Same source: no explicit size, UTF-8, symlink, or special-file contract | Deviate | Local instruction input must remain finite and must not follow implicit filesystem indirection |
| `_refs/zot/packages/agent/build_test.go` | Adopt test shape | Discovery order and system composition should be directly observable offline |
| `_refs/zot/packages/agent/instruction_context.go` and its tests | Adopt ordering principle only | Startup metadata, extensions, and skills are outside this slice |
| `_refs/zot/README.md`: `--no-context-files`, `SYSTEM.md`, skills, sessions | Defer | They add unrelated CLI, persistent-state, or tool surfaces |

Implementation will be independent TypeScript. `_refs/` will not be imported, executed, changed,
refreshed, or treated as a dependency.

## Scope

In scope:

- optional workspace-root `AGENTS.md` discovery for normal `agent:run` only;
- strict bounded file selection, file-type, byte, decoding, and formatting contracts;
- an additive provider-neutral system-instruction field;
- propagation of one immutable instruction through all loop requests;
- OpenRouter `system` wire-message support;
- direct, transport, runtime, process, and topology tests using only local fixtures and fake provider;
- current README/results/lifecycle evidence and bounded read-only review.

Out of scope:

- ancestor, global, home, VCS-root, recursive, or child-directory discovery;
- `$ZOT_HOME`, `SYSTEM.md`, `CLAUDE.md`, custom/append/disable prompt flags, diagnostics UI;
- skills, sessions, persistence, compaction, streaming/TUI, extensions, RPC, subagents;
- dynamic provider/model/tool selection, retry, fallback, or request-bound changes;
- corpus/eval behavior, work-tool behavior, sentinel behavior, or legacy/basic paths;
- sandboxing, dependency/lockfile changes, provider/network execution, credential access;
- `_refs/`, archive, sibling repositories, commit, push, tag, publish, or release.

## Exact discovery contract

### Boundary and selection

1. `resolveWorkspace()` returns the one canonical absolute workspace directory before discovery.
2. Discovery checks only that directory, in this exact case-sensitive priority:
   1. `AGENTS.md`
   2. `AGENTS.MD`
3. `NotFound` advances to the next filename. The first existing candidate is final for this
   invocation. If it is invalid, discovery yields no context and does not fall through to the
   lower-priority filename.
4. Parent, child, sibling, home, environment-derived, and VCS-derived paths are never considered.
5. `CLAUDE.md`, `agents.md`, `AGENT.md`, and other spelling variants are ignored.
6. Candidates are keyed by normalized absolute path for deduplication. Content hashes do not affect
   identity. The first slice has at most one effective candidate, but this rule preserves order if a
   later approved slice introduces layering.

First-present-wins prevents an invalid higher-priority file from being bypassed by a second spelling
with different instructions.

### File, byte, and text validation

- Use `lstat`; accept only a regular file.
- Skip symlinks even when their targets remain in the workspace.
- Skip directories, FIFO, sockets, devices, and all other special files.
- Read through a bounded byte reader that observes at most 16,385 raw bytes. More than 16,384 bytes
  skips the whole file; the implementation does not truncate it and does not use an unbounded
  whole-file text read.
- Recheck the opened handle's file type before accepting its content.
- Decode with `TextDecoder('utf-8', { fatal: true })`; malformed UTF-8 skips the file.
- Reject decoded NUL. Do not normalize Unicode or internal line endings.
- Apply ECMAScript `trim()`. Blank content is skipped; accepted content is the trimmed text.
- Per-file and aggregate content limits are both 16,384 UTF-8 bytes in this one-file slice.
- Formatter overhead and the user transcript remain subject to the existing 76 KiB message and
  256 KiB request bounds; those limits are not raised.

### Error and visibility contract

- Missing files are normal and yield no system instruction.
- Non-`NotFound` `lstat` failure, open/read/stat failure, invalid type, symlink, oversize content,
  invalid UTF-8, NUL, or blank content silently yields no context for that invocation.
- Discovery failures do not write to stdout/stderr, create a model-visible tool result, enter the
  transcript, or expose an OS error, absolute path, or content excerpt.
- Canonical workspace resolution failure keeps the existing runtime-failure behavior.
- The implementation bounds and closes every opened resource, including error paths.

This is a trusted-local feature, not a hostile-filesystem boundary. Rechecking the opened handle
reduces mistakes but does not eliminate all same-user races between path inspection and open.

## Exact system-instruction contract

### Provider-neutral request

Extend the request additively:

```ts
export interface ModelRequest {
  readonly systemInstruction?: string;
  readonly transcript: readonly Message[];
  readonly tools: readonly ToolDefinition[];
}
```

Do not add a system role to the `Message` union. System instructions are request-scoped input, not a
conversation event.

Add the same optional value to `AgentLoopOptions`. `runAgent` passes one immutable value to every
model request. When it is absent, existing request and transcript behavior is preserved. It never
appears in `LoopOutcome.transcript`, so user/assistant/tool adjacency and existing corpus evidence do
not change.

Only the normal runtime discovers and supplies this option. Existing call sites omit it.

### Exact formatted instruction

For an accepted lowercase file, generate exactly this text with no trailing newline:

```text
Project context instructions loaded from AGENTS.md. Follow them when working in this workspace.

## ./AGENTS.md

<trimmed content>
```

For the uppercase fallback, only the heading becomes `## ./AGENTS.MD`. With no accepted file, use
`undefined`; do not send an empty system message.

### OpenRouter wire contract

- Add a wire message `{ role: 'system', content: string }`.
- When present, messages are exactly `[system, ...encodedTranscript]` on every request.
- The system message appears exactly once per request and before the initial user message. It is not
  inserted between an assistant tool call and its correlated tool result.
- With no context, serialized messages remain byte-for-byte compatible with the current request.
- Adapter preflight requires a nonblank, well-formed, NUL-free string. An invalid injected value is
  `invalid_input` with zero external requests.
- The existing 76 KiB serialized-message and 256 KiB request bounds include the system message and
  fail before credential resolution/fetch when exceeded.
- Model/profile, tools, streaming mode, completion bound, timeout, credential source, and retry
  behavior do not change.

## File ownership and changes

- New `v0/agent/agent_instructions.ts`
  - constants, bounded filesystem seam, candidate selection, validation, deduplication, and exact
    formatter;
  - production defaults use Deno APIs; direct tests inject an in-memory seam.
- `v0/agent/contracts.ts`
  - add only optional `ModelRequest.systemInstruction`.
- `v0/agent/loop.ts`
  - add optional immutable system instruction to loop options and every request.
- `v0/agent/openrouter_model.ts`
  - add system wire type, validation, first-position encoding, and existing-bound enforcement.
- `v0/agent/runtime.ts`
  - discover once after workspace resolution and before registry/model loop execution;
  - add only a test seam needed for instruction filesystem injection; no product option/env.
- New `tests/v0/agent_instructions_test.ts`
  - permission-free selection, bounds, decoding, file-type, error, and formatter tests.
- `tests/v0/agent_loop_test.ts`
  - prove identical system instruction on every request and absence from transcript/outcome.
- `tests/v0/agent_openrouter_model_test.ts`
  - prove system-first wire, no-context compatibility, causal second request, and prefetch failures.
- `tests/v0/agent_runtime_test.ts`
  - prove normal-runtime-only composition with existing five tools/max eight/no retry.
- `tests/v0/fixtures/runtime_process_fixture.ts`
  - add a fake-provider mode that validates system-first request bodies and later tool transcript.
- `tests/v0/agent_runtime_process_test.ts`
  - use an actual disposable workspace instruction file and assert output/process behavior.
- New `tests/v0/agent_instructions_topology_test.ts`
  - assert unchanged `agent:run` read boundary, no new env/ancestor permission, focused gate wiring,
    and exclusion of provider/credential tasks.
- `deno.v0.json`
  - add permission-free `agent:instructions:test`;
  - add topology test with read permission only for `deno.v0.json`;
  - add sources/tests to check and both focused tests exactly once to the local gate;
  - do not alter the production `agent:run` permission/profile/network contract.
- `README.md`
  - document selection, 16 KiB, UTF-8/file-type, silent-skip, system-role, and workspace-only scope.
- New `docs/plans/zot-agents-context-discovery-results.md`
  - implementation acceptance package created only after implementation.
- `AGENTS.md` and `.handoff/handoff.md`
  - repository owner updates measured phase/review/checkpoint state only after the local gate.

Do not change corpus/eval source or data, work tools, sentinel/credential launchers, legacy/basic
paths, dependencies, lockfiles, `_refs/`, archive, or sibling repositories.

## Ordered implementation sequence

1. Save this plan, compute its SHA-256, and stop at the initial Human Gate.
2. Implement bounded discovery and permission-free direct tests first.
3. Add the provider-neutral request/loop option and prove all-step propagation outside transcript.
4. Add the OpenRouter system role and prove exact first/second request encoding and prefetch bounds.
5. Connect discovery only at the normal runtime composition root.
6. Add actual-process evidence for filesystem permission, system-first body, channel contract, and
   natural process exit.
7. Add topology wiring and user-visible documentation.
8. Run focused and full offline verification plus `git diff --check`.
9. Create results and update lifecycle records using measured results only.
10. Run one bounded independent read-only review; fix accepted in-scope findings and perform at most
    one changed-lines re-review.
11. Present the acceptance package. Do not run a provider sentinel or commit automatically.

## Verification matrix

| Requirement / failure mode | Direct evidence |
| --- | --- |
| Exact filenames, priority, workspace-only, no ancestors | in-memory tree plus process parent/sibling markers |
| First-present wins; invalid lowercase cannot expose uppercase fallback | invalid/blank/oversize lowercase plus valid uppercase negative table |
| Regular file only; symlink/special skip | direct file-node matrix and actual process symlink case |
| UTF-8, BOM, blank, NUL | separate decoder cases |
| 16,384 accepted; 16,385 skipped; bounded close | boundary and read/close seam assertions |
| Read errors remain best effort and invisible | injected lstat/open/read/stat errors plus process output assertions |
| Exact first-class system role | OpenRouter body equality: system then user |
| Tool-call causality | second request is system/user/assistant-tool/tool, with one system message |
| Not user text and not transcript | captured loop request and `LoopOutcome.transcript` assertions |
| No-context compatibility | current transport body remains user-first with no system |
| Existing message/request bounds | system-inclusive 76 KiB/256 KiB failure before credential/fetch |
| Normal runtime only | runtime request has system while corpus/eval tests remain unchanged |
| Fixed profile/tools/eight requests/no retry | existing exact runtime/transport assertions stay green |
| stdout/stderr and natural process exit | actual child success/failure channel assertions |
| Permission boundary | topology asserts `--allow-read=.` unchanged and no ancestor/env grants |
| Gate S preservation | sentinel files/tasks unchanged; local gate excludes production/provider tasks |

Tests will remain layered: discovery direct tests own file semantics, transport tests own wire
encoding, runtime tests own composition, process tests own actual permissions/channels, and topology
tests own config drift.

## Exact local verification commands

Use the repository-pinned Deno 2.9.4 binary:

```text
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --config deno.v0.json agent:instructions:test
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --config deno.v0.json agent:instructions:topology:test
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --config deno.v0.json agent:test
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --config deno.v0.json agent:transport:test
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --config deno.v0.json agent:runtime:test
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --config deno.v0.json agent:runtime:process:test
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --config deno.v0.json v0:check
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --config deno.v0.json v0:fmt
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --config deno.v0.json v0:lint
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --config deno.v0.json v0:test
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --config deno.v0.json v0:gate
git diff --check
```

Do not execute `agent:run`, `agent:acceptance`, a live sentinel, or any credential-file task during
this local gate.

## Review and acceptance package

The initial read-only review is limited to the changed diff and 30 minutes. If no new evidence,
tool result, or interim conclusion appears for 10 minutes, stop and return the verified scope. The
realistic environment is trusted-local Deno 2.9.4; the context file is untrusted local text.
Adversarial same-user filesystem races, supply-chain compromise, and untrusted-code containment are
outside this review.

Report Blocker/P1/P2 for:

- system text entering user content or transcript;
- system ordering breaking tool-call/result causality;
- unbounded reads, path/content leakage, resource leaks, or channel drift;
- permission broadening beyond the workspace;
- behavior drift in corpus/eval or no-context requests;
- weakened 76 KiB/256 KiB, five-tool, eight-request, or no-retry contracts.

After accepted fixes, perform at most one changed-lines re-review, limited to 15 minutes and existing
finding resolution. Local GO requires Blocker/P1/P2 zero.

The results package maps every requirement to files/tests, records exact command outcomes and counts,
the plan SHA-256, review disposition, Zot deviations, remaining risks, and zero provider/credential
operations. It must not record instruction contents from a user's real workspace.

## Compatibility, rollback, and remaining risks

There is no migration or persistent state. A workspace without an accepted instruction file retains
the current wire behavior.

Rollback removes the discovery module/tests/tasks/docs and restores the optional request/loop field,
system wire encoding, and runtime composition. It does not reset the worktree or touch user files,
credentials, provider state, corpus/eval, sentinel evidence, or `_refs/`.

Remaining risks:

- `AGENTS.md` is intentionally model instruction and can contain prompt injection; this feature does
  not semantically sanitize it.
- Silent skip gives no user diagnostic for invalid/unreadable/oversize files; diagnostics are later.
- `lstat`/open races are not a complete hostile same-user boundary.
- Workspace-only discovery omits monorepo ancestors and global instructions.
- Oversize instructions are skipped, never truncated.
- System text consumes the existing message budget; large later transcripts may reach the existing
  `limit_exceeded` outcome sooner. Context compaction and bound changes are later work.

## Human Gate

Implementation requires explicit user approval of this plan and its SHA-256. Approval must include
these five decisions:

1. read only the canonical workspace root, not ancestors or global state;
2. prefer `AGENTS.md`, then `AGENTS.MD`, with first-present-wins;
3. accept only regular non-symlink UTF-8 text up to 16 KiB and silently skip invalid/read failures;
4. send it as a first-class system instruction outside the transcript on every request;
5. perform only local fake-provider/offline verification, with no credential/provider/sentinel run.

If ancestor/global layering is required instead, do not approve this plan; return to planning for an
explicit permission/workspace contract. Approval does not authorize provider/network access,
credential reads, dependencies/lockfiles, `_refs/` changes, commit, push, tag, publish, or release.
