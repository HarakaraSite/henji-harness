# Zot-first local work tools — implementation and verification plan

## Recommendation and assumptions

Concept **GO**. Replace only the normal production `agent:run` registry with a
trusted-local work registry containing `read`, `write`, `edit`, `bash`, and the
existing terminal `submit_json_result`. Split the existing corpus/evaluation
registry out of the production composition before changing the advertised
production tools. This keeps the four toy/domain tools available to fixtures,
fixed tasks, corpus scoring, offline evaluation, and live-fake evaluation,
without advertising them to a normal production invocation.

The implementation is an independent TypeScript implementation informed by Zot
pinned commit `9b7bb6a4f36bc8c8deb2cc5796a8f557f4fb7479` (MIT), especially:

- `_refs/zot/packages/agent/build.go`: default `read`/`write`/`edit`/`bash`
  composition and one cwd shared by the tools;
- `_refs/zot/packages/agent/tools/read.go`, `write.go`, `edit.go`, and
  `bash.go`: text-file, exact-replacement, shell, and bounded-result behavior;
- `_refs/zot/packages/agent/tools/bash_unix.go`: timeout cleanup motivation and
  descendant-process limitation;
- `_refs/zot/packages/agent/tools/permissions.go` and `sandbox.go`: canonical
  path comparison and the explicit warning that lexical shell checks are not a
  security boundary;
- the corresponding `tools_test.go`, `permissions_test.go`, and
  `sandbox_test.go` cases for relative paths, outside-root rejection,
  directory/binary rejection, exact edits, shell choice, nonzero exits, and
  symlink-aware scope checks.

Henji adopts the cohesive tool set and cwd-oriented usage, but deliberately
narrows this first slice to UTF-8 text files of at most 64 KiB, rejects symlinks
instead of following in-workspace symlinks, uses atomic sibling replacement for
file mutation, preserves stdout and stderr separately, and does not copy Zot's
image support, pagination, TUI preview, full-output temp logs, permission
manifest, confirmation UI, command allowlist, or claimed jail behavior. `_refs/`
remains comparison evidence, not source, runtime input, or a dependency.

The current environment is the trusted-local Linux development VM with Deno
2.9.4. The following local and reversible implementation choices are fixed for
this increment:

- the workspace root is the canonical `Deno.realPath(Deno.cwd())` resolved once
  per invocation;
- file tools accept a relative path or an absolute path already inside that
  root;
- paths are Linux paths; no Windows shell or path portability is added in this
  increment;
- successful production tool definition order remains the existing
  `Registry.definitions()` lexical order: `bash`, `edit`, `read`,
  `submit_json_result`, `write`;
- local work is authorized by the noninteractive `agent:run` invocation itself;
  there is no confirmation flag, prompt, durable consent, or per-call approval;
- the fixed OpenRouter profile, maximum eight model requests, application retry
  zero, terminal JSON semantics, CLI input contract, and CLI final/failure
  channel contracts remain unchanged.

There is no unresolved Why/What/Whether question. If the implementation cannot
preserve the registry separation, exact path boundary, atomic target
replacement, direct-shell reap, or existing terminal semantics without widening
dependencies, provider behavior, corpus data, or permissions beyond this plan,
stop and return a plan delta to the repository owner.

## Confirmed current state and required delta

- `v0/agent/runtime.ts` currently constructs the same five-tool registry used by
  the corpus and evaluation paths: `character_count`, `count_json_array_items`,
  `list_json_object_keys`, `submit_json_result`, and `uppercase_text`.
- `v0/eval/offline_corpus_runner.ts` and `v0/eval/live_corpus_runner.ts`, plus
  their tests and the transport tests, import `createRuntimeRegistry`; changing
  that factory in place would silently break the versioned corpus contract.
- Fixed step 5–10 and legacy/acceptance compositions construct their own domain
  registries directly and must remain behaviorally unchanged.
- `Registry` already provides stable lexical definition order, sanitized
  continuing tool errors, and the generic terminal dispatch boundary. `runAgent`
  already enforces sole-call terminal batches, successful `tool_terminal`
  completion, last-step terminal success, and maximum eight requests.
- `agent:run` currently has only provider env/net and literal `deno.v0.json`
  read permission. It has no general workspace write or subprocess permission.
- The normal CLI already validates argv/stdin before runtime construction, emits
  only final text on stdout, emits one generic allowlisted JSON failure on
  stderr, and never prints intermediate tool output to host stdout/stderr.
- The current local baseline is 154 full v0 tests. The completed real sentinel
  is historical evidence only; this plan authorizes no provider, network, or
  credential operation.

The required delta is therefore: introduce explicit corpus and production
registry factories, add four bounded local-work tool implementations plus shared
workspace/mutation/subprocess helpers, compose only the production factory in
`runRuntime`, update exact Deno permissions, and add local fixture/process
evidence without changing the provider-neutral loop contract.

## Exact common workspace and text contract

### Workspace root

At runtime construction, resolve `Deno.cwd()` once with `Deno.realPath`, require
it to be an existing directory, and store the absolute canonical result.
Production has no CLI option or environment variable to choose another root.
Direct/process tests may inject or establish a temporary cwd through the
existing test-only dependency seam; that seam is not exported as a product
option.

Every file call validates `path` before any file content is opened:

1. require a nonblank, well-formed Unicode string of at most 4,096 UTF-8 bytes;
2. reject NUL, unpaired UTF-16 surrogate code units, and unknown argument
   fields;
3. resolve relative input against the fixed root; normalize `.` and `..`; accept
   absolute input only when its normalized location is the root or a descendant;
4. compare components rather than using a raw string prefix, so a sibling such
   as `root-other` does not match `root`;
5. walk every existing component from the canonical root with `Deno.lstat`;
   reject any symbolic-link component, including a symbolic-link target;
6. for a missing write target, validate the longest existing parent, create
   missing directories only after that check, then revalidate the created parent
   chain before opening the sibling temp file.

`../` traversal and absolute paths outside the root fail before file
open/create. Internal symlinks are rejected even when their current destination
is inside the root. Hard links are not detected: `read` may observe one, while
atomic `write`/`edit` replaces only the addressed directory entry. That
same-user hard-link/TOCTOU limitation is a deferred trusted-local risk, not a
claimed sandbox breach.

For `read` and `edit`, the target must already exist and `lstat.isFile` must be
true. For `write`, an existing target must be a regular non-symlink file; a
missing target may be created. Directories, devices, sockets, FIFOs, and other
special nodes are rejected. The workspace directory itself is not a file target.

Text file bytes are bounded at 65,536 bytes. Decode with
`TextDecoder('utf-8', {fatal: true,
ignoreBOM: true})`; this retains a leading
UTF-8 BOM as U+FEFF. Reject invalid UTF-8 and decoded NUL. Do not normalize BOM,
CRLF/LF, trailing newline, Unicode normalization, or other content. New text
arguments must be well-formed Unicode without NUL and are encoded with
`TextEncoder`; the encoded form must fit the same 65,536-byte bound.

### Model-visible errors

New tools must catch host exceptions and expose only fixed diagnostic classes
through the existing registry prefix:

```text
invalid arguments: invalid <tool> arguments
invalid arguments: path must stay within workspace
invalid arguments: path must not contain a symlink
tool execution error: file not found
tool execution error: target is not a regular file
tool execution error: file exceeds 64 KiB
tool execution error: file is not valid UTF-8 text
tool execution error: local read failed
tool execution error: local write failed
tool execution error: local edit failed
tool execution error: bash could not start
```

Edit validation may add only `edit N oldText is empty`,
`edit N oldText was not found`, `edit N
oldText is not unique`,
`edit N does not change content`, and `edits overlap`, where `N` is the
one-based operation index. Do not include the supplied path, absolute root,
content excerpt, command, OS error text, stack, environment, credential, or temp
filename in a model-visible error. A local tool error remains a correlated
continuing tool result and can be repaired only by another model request inside
the existing bound. CLI terminal failures remain the current generic sanitized
JSON and must not copy tool diagnostics to host stderr.

## Exact tool schemas and results

All four schemas are object-root, declare `additionalProperties: false`, and are
serialized unchanged through the existing OpenRouter adapter.

### `read`

```json
{
  "type": "object",
  "properties": { "path": { "type": "string" } },
  "required": ["path"],
  "additionalProperties": false
}
```

Description: `Read one UTF-8 text file inside the workspace (maximum 64 KiB).`

The arguments object must contain exactly `path`. The tool reads one existing
regular file after all common path checks, stops at byte 65,537, and rejects an
oversized, invalid-UTF-8, NUL-containing, or special file. Success returns the
decoded file content exactly, including an empty string, BOM, line-ending style,
and trailing-newline state. It adds no path header, line numbers, JSON wrapper,
or synthetic newline. The model-visible result is therefore at most 65,536 UTF-8
bytes.

### `write`

```json
{
  "type": "object",
  "properties": {
    "path": { "type": "string" },
    "content": { "type": "string" }
  },
  "required": ["path", "content"],
  "additionalProperties": false
}
```

Description:
`Create or replace one UTF-8 text file inside the workspace. Missing parent directories
are created.`

The arguments object must contain exactly `path` and `content`; empty content is
valid. After the common checks, create missing parent directories with mode
`0755`. Build a sibling temp file with `createNew`, write all encoded bytes,
call file `sync`, apply the existing target's permission bits or `0644` for a
new target, close it, revalidate the target/parent path, and rename the temp
file over the target. Temp-file collision retries are bounded and temp cleanup
is best effort.

Success returns exactly this compact JSON text with keys in this order, using
the normalized workspace-relative forward-slash path and encoded byte count:

```json
{ "path": "relative/path.txt", "bytes": 123 }
```

The target is never exposed partially: a failure before rename leaves an
existing target byte-for- byte unchanged or leaves a new target absent. Newly
created parent directories may remain after a later failure. The sibling rename
is the atomic visibility boundary on this Linux filesystem; file `sync` is
performed, but directory fsync and whole-operation crash durability are not
promised.

### `edit`

```json
{
  "type": "object",
  "properties": {
    "path": { "type": "string" },
    "edits": {
      "type": "array",
      "minItems": 1,
      "maxItems": 32,
      "items": {
        "type": "object",
        "properties": {
          "oldText": { "type": "string" },
          "newText": { "type": "string" }
        },
        "required": ["oldText", "newText"],
        "additionalProperties": false
      }
    }
  },
  "required": ["path", "edits"],
  "additionalProperties": false
}
```

Description:
`Apply up to 32 non-overlapping exact replacements to one existing UTF-8 text file.
Each oldText must match exactly once in the original file.`

Validate every operation against the same original decoded text, not sequential
intermediate text. `oldText` must be nonempty, differ from `newText`, and occur
exactly once. Every string follows the common well-formed-Unicode/NUL rule.
Compute byte spans, reject overlaps, sort spans by source position, apply them
in one in-memory plan, and reject a final encoded file over 65,536 bytes. Line
endings and BOM outside replaced spans remain exact; replacements are not
newline-normalized.

Before commit, reread the target and require its bytes to equal the planned
original snapshot. Then use the same sibling-temp, file-sync,
permission-preservation, close, path-revalidation, and rename sequence as
`write`. A validation, concurrency, I/O, or rename failure leaves the target
unchanged; temp cleanup is best effort. This detects ordinary concurrent changes
but does not claim protection against a hostile same-user race between final
validation and rename.

Success returns compact JSON with this exact key order:

```json
{ "path": "relative/path.txt", "edits": 2, "bytes": 456 }
```

No preview/diff is persisted or emitted in this slice; direct tests compare the
resulting file.

### `bash`

```json
{
  "type": "object",
  "properties": {
    "command": { "type": "string" },
    "timeoutMs": { "type": "integer", "minimum": 1, "maximum": 120000 }
  },
  "required": ["command"],
  "additionalProperties": false
}
```

Description:
`Run one Bash command from the workspace. Default timeout 30000 ms; maximum 120000 ms.
stdout and stderr are captured separately and truncated.`

`command` must be nonblank after ECMAScript whitespace trim, must be well-formed
Unicode without NUL, and must be at most 16,384 UTF-8 bytes. Execute the
original untrimmed command verbatim. Omitted `timeoutMs` means 30,000; booleans,
fractions, zero, negatives, and values over 120,000 are invalid.

Shell resolution is deliberately fixed and independent of `$SHELL` and `PATH`:

```text
executable: /bin/bash
argv:       ["--noprofile", "--norc", "-c", command]
cwd:        canonical workspace root
stdin:      null
stdout:     piped
stderr:     piped
```

Every call starts again at the root; a `cd` affects only that shell. Use
`clearEnv: true` and pass only fixed non-secret values
`PATH=/usr/local/bin:/usr/bin:/bin`, `LANG=C.UTF-8`, and `LC_ALL=C.UTF-8`. In
particular, do not pass `HENJI_OPENROUTER_API_KEY`, the parent environment,
HOME, shell startup variables, or test dummy credentials.

Drain stdout and stderr concurrently to EOF so neither pipe can deadlock. Retain
at most the first 4,096 bytes of each stream while continuing to drain discarded
bytes. Decode retained prefixes with UTF-8 replacement semantics for
malformed/truncated byte sequences. Do not stream tool output to the normal CLI
and do not write a full-output temp log.

On timeout, set `timedOut`, send SIGTERM to the direct Bash child, wait at most
250 ms for its status, then send SIGKILL if still running. Always await the
final child status and both stream drains before returning, so the direct child
is reaped. Clear timers on every exit path. Deno does not expose the
process-group control needed here to promise cleanup of arbitrary background
descendants; tests prove the direct shell is killed/reaped, and the descendant
limitation is reported as a risk.

Normal exit, nonzero exit, signal exit, and timeout are all successful tool
executions because they are observable command results, not dispatch failures.
Return exactly one compact JSON string with these keys in order:

```json
{
  "stdout": "...",
  "stderr": "...",
  "exitCode": 0,
  "signal": null,
  "timedOut": false,
  "stdoutTruncated": false,
  "stderrTruncated": false
}
```

`exitCode` is the Deno status code when `signal` is null and otherwise null.
`signal` is the Deno status signal string when present and otherwise null. A
timeout retains the actual final code/signal and sets `timedOut: true`.
Truncation booleans reflect bytes beyond each 4,096-byte retained prefix. The
worst-case JSON-escaped result remains below the current 76 KiB
serialized-message limit. Only failure to validate/spawn/capture/reap becomes a
correlated tool error with a fixed sanitized message.

## Security and Deno permission topology

The production task becomes exactly:

```text
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno run --no-prompt --allow-env=HENJI_OPENROUTER_API_KEY --allow-net=openrouter.ai --allow-read=. --allow-write=. --allow-run=/bin/bash v0/agent/runtime_cli.ts
```

The Deno parent is limited to provider credential read, `openrouter.ai`,
workspace filesystem access, and starting `/bin/bash`. File-tool checks are an
additional application boundary against accidental path escape and symlink
traversal.

`bash` is **not** confined by those parent Deno filesystem permissions. Once
Deno starts Bash, that subprocess has the host OS permissions of the current
user and can read/write outside the workspace, start other programs, use
inherited host network capability, and perform destructive actions. The fixed
cwd, fixed environment, command byte bound, timeout, and direct-child kill are
operational bounds, not a shell sandbox. No lexical command inspection,
denylist, subprocess Deno flag, or path resolver can turn arbitrary `bash -c`
into a complete confinement boundary. This is accepted only for the stated
trusted-local repository-work phase and must be explicit in
README/results/review.

The child receives no provider credential via environment, but it could still
access other same-user files or ambient services by explicit path/command.
Noninteractive invocation authorizes that capability for the run; no per-tool
prompt is added. Untrusted-code execution, multi-user service use, containers,
seccomp, namespaces, process groups, and a durable permission manifest are
deferred.

## Registry separation and runtime composition

Introduce explicit factories rather than repurposing the shared current factory:

- `createCorpusRegistry(readFile?)` retains exactly the current
  domain/evaluation definitions and lexical order: `character_count`,
  `count_json_array_items`, `list_json_object_keys`, `submit_json_result`,
  `uppercase_text`;
- `createProductionRegistry(workspace, seams?)` exposes exactly `bash`, `edit`,
  `read`, `submit_json_result`, `write` in lexical order;
- `runRuntime` resolves the workspace once, constructs only the production
  registry, constructs the same fixed OpenRouter adapter once, and calls
  `runAgent(..., {maxSteps: 8})` once;
- offline/live corpus runners, scripted evaluation, transport fixture requests,
  and relevant tests switch imports to `createCorpusRegistry` and retain the old
  definitions;
- fixed fixture, selection, JSON-key, multi-tool, acceptance, basic, and legacy
  paths retain their current direct registries and behavior.

Do not put toy/domain tools in the production factory, work tools in the corpus
factory, or a caller- selectable registry/tool filter in the CLI.
`submit_json_result` remains the same tool instance contract in both factories.
The loop, terminal batch policy, corpus JSON, corpus domain `TOOL_NAMES`,
scorer, report v2 schema, provider profile, endpoint, request bound, and
application retry policy do not change.

## CLI surface

The existing argv/stdin preflight and 65,536-byte task contract remain exact.
`agent:run` itself is the authorization; do not add `--yes`, `--allow-tools`, a
prompt, TTY interaction, or a confirmation event.

Successful assistant-final and terminal-JSON runs retain exit 0, final text plus
the existing trailing-newline rule on stdout, and empty stderr.
Read/write/edit/bash results, command output, paths, transcript, counters, and
tool traces are never copied to host stdout/stderr. A successful tool round
followed by model failure continues to produce empty stdout and the existing
one-line generic `agent_failure` JSON on stderr with observed counters only.
Preflight, missing credential, transport, max-step, and unexpected exception
behavior remain unchanged and sanitized.

## File ownership after approval

Implementation ownership is limited to:

- new `v0/agent/work_tools.ts`: common workspace/path/text/mutation helpers and
  the four tool implementations;
- new `v0/agent/registries.ts`: explicit production and corpus registry
  factories;
- `v0/agent/runtime.ts`: canonical workspace resolution, production-only
  composition, and test seam;
- `v0/agent/tools.ts` only if a narrow exported sanitizer/helper is needed;
  existing toy and terminal tool contracts otherwise remain unchanged;
- `v0/eval/offline_corpus_runner.ts` and `v0/eval/live_corpus_runner.ts`: import
  the corpus factory;
- `tests/v0/agent_runtime_test.ts`: fake-provider direct composition/CLI tests;
- `tests/v0/agent_runtime_process_test.ts` and
  `tests/v0/fixtures/runtime_process_fixture.ts`: actual subprocess CLI matrix
  and topology;
- new `tests/v0/agent_work_tools_test.ts`: temp-workspace direct file/bash
  contract tests;
- existing offline/live/transport tests only where their registry-factory import
  and exact old definition assertion must be renamed;
- `deno.v0.json`: exact production/focused permissions and check/gate coverage;
- `README.md`: normal five-tool contract, workspace behavior, no-confirmation
  rule, and truthful bash warning;
- new `docs/plans/zot-local-work-tools-results.md`: local acceptance package;
- repository owner only: current phase/result update in `AGENTS.md` and one
  concise checkpoint in `.handoff/handoff.md` after the gate.

Do not change contracts/loop/provider code without direct evidence and a
reviewed local plan delta. Do not change corpus JSON, corpus tool
names/scoring/report schemas, provider profile/endpoint, credential launcher or
operations credential document, dependencies/lockfiles, prior plans/results,
archive, `_refs/`, persistent state, or sibling repositories.

## Ordered implementation increments

### 1. Separate registries without behavior change

Add `registries.ts`, move the current five-definition composition into
`createCorpusRegistry`, switch eval/transport consumers to that explicit
factory, and add `createProductionRegistry` with the final five names. Initially
stub or inject the work tools only as needed to type-check the factory; do not
mutate corpus semantics.

Verification for this increment:

- exact production order is `bash`, `edit`, `read`, `submit_json_result`,
  `write` on every fake provider request;
- exact corpus order remains the current five domain/submission definitions;
- production excludes all four toy/domain names and corpus excludes all four
  work-tool names;
- fixed direct registries remain untouched;
- submission schema/description/terminal result remains byte-for-byte
  compatible.

### 2. Implement the common path and atomic text-file boundary

Implement canonical root resolution, exact argument validation, component
containment, symlink and special-file rejection, fatal text decoding, byte
limits, sibling-temp creation/sync/mode/rename, concurrency check, and sanitized
errors. Then implement `read`, `write`, and `edit` on that shared boundary.

Temp-workspace direct tests cover:

- relative and in-root absolute success; `.` normalization; traversal, outside
  absolute, sibling prefix, NUL, unpaired surrogate, and overlong path
  rejection;
- target and intermediate symlinks to both inside and outside destinations;
  missing-parent write;
- directory and at least one non-regular node rejection;
- empty/exact 65,536/65,537-byte files; valid UTF-8, invalid UTF-8, NUL, BOM,
  LF/CRLF, and trailing newline preservation;
- write create/replace, parent creation, mode rule, exact summary, target
  unchanged on injected pre-rename failure, and no temp artifact after ordinary
  failure;
- edit single/multiple/out-of-order replacement,
  empty/not-found/non-unique/no-op/overlap rejection, all-edits-against-original
  semantics, final-size bound, exact summary, and target unchanged on
  validation/concurrency/injected commit failure;
- only normalized workspace-relative paths appear in success summaries and no
  supplied/absolute path or injected OS marker appears in error text.

### 3. Implement and bound Bash execution

Implement exact schema/description, fixed shell/argv/cwd/env, concurrent bounded
capture, exit/signal mapping, timeout escalation, timer cleanup, and
direct-child reap. Keep command output inside the tool result only.

Direct/process tests use the temporary workspace and fixed Bash only, and cover:

- cwd starts at the root for each call; Bash arrays/conditionals prove actual
  Bash rather than sh;
- fixed environment contains the three declared variables and omits
  dummy/provider credential markers and an injected parent marker;
- separated stdout/stderr, exit 0, nonzero exit, signal exit, empty output,
  malformed UTF-8 replacement, exact 4,096-byte boundaries, and both truncation
  flags;
- default timeout, explicit valid timeout, invalid bounds, SIGTERM completion,
  SIGKILL escalation, and awaited direct-child status within a bounded harness
  deadline;
- blank, NUL, unpaired-surrogate, oversized, unknown-field, and wrong-type
  arguments never spawn;
- spawn/capture/reap exceptions become fixed diagnostics without command, cwd,
  env, OS error, or stack leakage.

The test does not claim that a background grandchild is killed; it records that
limitation.

### 4. Compose normal runtime and preserve terminal/CLI behavior

Use the production factory in `runRuntime` and preserve one model/registry/loop
construction, maximum eight model requests, no retry, and the current CLI output
mapper. Extend the offline fake-provider scripts to execute representative
`read`, `write`, `edit`, and `bash` rounds and a successful sole
`submit_json_result` call.

Direct tests prove:

- definitions and schemas are exact on every request and no toy/domain
  definition leaks;
- a representative write/read/edit/bash sequence observes causal
  filesystem/command results;
- one response with multiple nonterminal work calls remains ordered under the
  current sequential dispatch contract;
- invalid args, path error, I/O error, nonzero Bash exit, and timeout remain
  recoverable within the request bound;
- a successful terminal submission on request eight starts no ninth request;
- eight nonterminal responses still execute the last local batch and return
  `max_steps` with eight fetches only;
- missing credential and first/later transport failure retain retry zero and
  sanitized counters;
- no per-tool prompt or additional CLI flag exists.

### 5. Add actual process topology evidence

Run the existing runtime CLI through an actual Deno subprocess from a newly
created temp workspace, with fake fetch/dummy credential injected inside the
fixture. The child receives only temp-root read/write and `/bin/bash` run
permission; it receives no provider net permission and no real credential. Cover
argv and stdin final-only success, a terminal JSON result after real work-tool
calls, file side effects inside the temp root, traversal/symlink failure
recovery, Bash stdout/stderr, timeout/direct reap, preflight failure, runtime
failure sanitization, and natural process exit.

Literal topology assertions prove:

- the production task has exactly the env/net/workspace read/write/Bash
  permissions stated above;
- the focused fake-provider child has no net permission and no ambient
  environment;
- local gate segments include focused tests once and include neither
  `agent:run`, `agent:acceptance`, live sentinel/canonical, nor
  credential-launcher production tasks.

### 6. Integrate documentation and local evidence

Update README with the five production tools/order, exact text/path limits,
atomic-visibility caveat, fixed Bash contract, invocation-as-authorization,
unchanged final-only stdout/stderr behavior, and the explicit statement that
Bash is unrestricted OS-user execution rather than a workspace sandbox.

Create `docs/plans/zot-local-work-tools-results.md` recording the approved plan
path/SHA, any reviewed local delta, changed files, requirement-to-evidence
mapping, exact command exits/pass counts, both registry definition lists,
path/atomicity/timeout evidence, maximum request evidence, provider/network/
credential activity zero, review findings/disposition, deviations, rollback
status, and remaining risks. It must not contain raw provider, credential,
command-sensitive, or temp absolute-path data.

The repository owner updates `AGENTS.md` only after final local evidence is
known and appends one handoff checkpoint. No requirement text is duplicated into
handoff.

### 7. Bounded read-only review

After implementation and local verification, request an independent read-only
review bounded to 30 minutes and stop it after 10 minutes without new evidence.
Review traces:

- production/corpus registry separation and exact stable definitions;
- path component/symlink/special-file enforcement and sanitized model errors;
- byte/encoding/newline boundaries and no partial target visibility;
- temp cleanup, mode behavior, concurrency detection, and stated crash/TOCTOU
  limits;
- fixed Bash executable/argv/cwd/env, no credential inheritance, capture bounds,
  timeout escalation, direct reap, and truthful lack of shell confinement;
- Deno task permissions and absence of production commands from local gates;
- existing terminal submission, max-eight/no-ninth, retry-zero, and CLI channel
  compatibility;
- corpus/eval/legacy regression evidence and scope exclusions.

One changed-lines-only re-review is bounded to 15 minutes. GO requires
Blocker/P1/P2 zero. A shared contract change, new permission, dependency,
provider path, corpus/scorer/report change, or unresolved finding returns to the
repository owner as a plan delta; do not silently widen the implementation.

## Exact local test and gate commands

Add focused tasks with these exact permission shapes (the implementation may
place both direct suites in one task only if the literal permissions and gate
coverage remain equivalent):

```text
agent:work-tools:test = /home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno test --no-prompt --allow-read=/tmp --allow-write=/tmp --allow-run=/bin/bash tests/v0/agent_work_tools_test.ts
agent:runtime:test = /home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno test --no-prompt --allow-read=/tmp --allow-write=/tmp --allow-run=/bin/bash tests/v0/agent_runtime_test.ts
agent:runtime:process:test = /home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno test --no-prompt --allow-run=/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno --allow-read=deno.v0.json,/tmp --allow-write=/tmp tests/v0/agent_runtime_process_test.ts
```

Add the new source/test files to the literal `v0:check` and `v0:gate` check
list. Keep `v0:fmt` exactly
`deno fmt --check --config deno.v0.json v0 tests/v0`, `v0:lint` exactly
`deno lint --config deno.v0.json v0 tests/v0`, and the broad full-suite
`v0:test` task unchanged. Include each focused task exactly once in `v0:gate`.

After implementation, execute this local-only sequence using the
repository-pinned Deno 2.9.4 binary:

```sh
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --config deno.v0.json agent:work-tools:test
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --config deno.v0.json agent:runtime:test
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --config deno.v0.json agent:runtime:process:test
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --config deno.v0.json agent:test
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --config deno.v0.json agent:transport:test
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --config deno.v0.json agent:acceptance:test
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --config deno.v0.json agent:selection:test
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --config deno.v0.json agent:json-keys:test
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --config deno.v0.json agent:corpus:test
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --config deno.v0.json agent:corpus:eval:test
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --config deno.v0.json agent:corpus:eval:offline
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --config deno.v0.json agent:corpus:eval:live:test
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --config deno.v0.json v0:check
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --config deno.v0.json v0:fmt
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --config deno.v0.json v0:lint
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --config deno.v0.json v0:test
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --config deno.v0.json v0:gate
git diff --check
```

Do not execute `agent:run`, `agent:acceptance`, live sentinel/canonical, the
credential-file launcher, a credential probe, or any provider/network command.
Tests use only temp fixtures, scripted/fake provider responses, dummy
credentials, and the fixed local Bash executable.

## Acceptance matrix

| Requirement / failure mode  | Required observable evidence                                                                               |
| --------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Production definitions      | every fake request has exactly `bash/edit/read/submit_json_result/write` in lexical order                  |
| Corpus/legacy compatibility | corpus requests retain the old five definitions; fixed registries and 24-case scores remain green          |
| Workspace resolution        | one canonical root per invocation; relative/in-root absolute accepted; traversal/outside/sibling rejected  |
| Symlink/special nodes       | target/intermediate links and directory/device/FIFO cases rejected before content access/mutation          |
| Text/size boundary          | empty, BOM, LF/CRLF, trailing newline, UTF-8, NUL, 65,536/65,537-byte cases                                |
| Write atomic visibility     | create/replace/parents/mode/summary; injected failures leave old target or absence intact                  |
| Edit all-or-none            | unique non-overlapping original-snapshot replacements; concurrency/failure leaves target intact            |
| Bash invocation             | fixed executable/argv/root cwd/fixed env; Bash syntax and clean credential omission                        |
| Bash result mapping         | separated output, 4 KiB bounds, truncation, exit/nonzero/signal/timeout exact JSON                         |
| Kill/reap                   | timeout sends TERM then KILL if needed and awaits direct status/pipe drains under deadline                 |
| Model errors                | correlated fixed diagnostics contain no supplied path/content/command/OS/temp/credential marker            |
| Invocation authorization    | no prompt/flag/event; normal CLI invocation alone permits tool calls                                       |
| Terminal JSON               | sole successful submission ends immediately, including request eight, with no follow-up                    |
| Request/retry bounds        | maximum eight fetches, no ninth, no automatic retry/fallback/repair                                        |
| CLI channels                | only final assistant/canonical JSON on stdout; generic one-line failure on stderr; tool output never leaks |
| Permission topology         | exact parent Deno flags; fake gates have no provider/network/real credential; Bash warning documented      |
| Full regression             | focused suites, offline 24/24, live fake suites, check/fmt/lint/full gate, diff check all pass             |

## Compatibility, migration, rollback, and operations

This is state-free and requires no data migration. The intentional product
compatibility change is only the tools advertised by normal production
`agent:run`: toy/domain tools disappear there and local work tools appear. Task
input, provider/profile, maximum requests, retry policy, terminal JSON,
assistant final text, stdout/stderr, exit codes, and sanitized failure schema
remain compatible. Corpus/eval report v2, corpus data, domain-tool scoring,
fixture/fixed tasks, acceptance, and legacy paths retain their existing
registries.

Rollback removes `work_tools.ts` and its tests, restores `runRuntime` to the
corpus-style factory, removes `registries.ts` by restoring the old
imports/factory, restores the old `agent:run` permission literal, and reverts
only this increment's README/results/phase/checkpoint changes. Do not reset the
worktree, rewrite historical evidence, delete temp/user data outside test-owned
temp directories, touch credentials, or modify `_refs/`.

There is no persistent operational service. Temp mutation files are sibling
files cleaned on normal success/failure; a process crash can leave a hidden temp
file, and no automatic startup sweep is added. Provider production use remains a
separately explicit operation under the repository lifecycle.

## Completion conditions

- Production and corpus registries are explicitly separated with the exact
  definition sets above.
- All four work tools implement the exact schemas, bounds, path, encoding,
  atomicity/failure, and subprocess contracts in this plan.
- No production tool call requires interactive confirmation or a new CLI flag.
- Existing fixed model/profile, eight-request/no-retry policy, terminal JSON
  behavior, and CLI channel contract are unchanged.
- Temp/direct/process tests use fake provider/dummy credential only and prove
  distinct failure modes without duplicating lower-level loop/adapter
  permutations already covered.
- The exact local command sequence, offline 24-case evaluation, full v0 gate,
  and diff check pass without a provider/network/credential operation.
- Results map each acceptance row to evidence and state Bash's true OS-user
  authority and remaining kill/path risks.
- Independent review returns GO with Blocker/P1/P2 zero.

## Remaining and deferred risks

- Arbitrary Bash can access outside the workspace, use the current user's OS
  authority, start descendants, and use network. The Deno parent flags and
  file-tool resolver do not sandbox it.
- Timeout guarantees only that the direct Bash child is killed and reaped;
  background descendants may survive. Process-group/container hardening is
  deferred.
- Symlink component checks, snapshot reread, and rename reduce mistakes but do
  not eliminate hostile same-user TOCTOU or hard-link behavior.
- File sync plus rename gives atomic visibility, not full directory-fsync crash
  durability; a crash can leave a sibling temp file or created parent directory.
- The 64 KiB text-only contract excludes large files, binary data, images, and
  paginated reads.
- A large/escape-heavy model tool-call argument can still approach the existing
  provider transcript message cap before tool validation; the adapter's existing
  76/256 KiB bounds then fail safely.
- Fake provider/process evidence does not prove real-model tool selection or
  safe command choice.
- Streaming/TUI, sessions, context discovery, skills, extensions, RPC,
  subagents, self-revision, dynamic provider/model/tool selection, persistent
  state, untrusted-code sandboxing, command allowlists, permission manifests,
  and milestone hardening remain deferred.

## Human Gate

**Stop here. Implementation requires explicit user approval of this plan.**

Approval authorizes only the registry separation, local work-tool
implementation, exact Deno task permission changes, temp-fixture/fake-provider
direct and process tests, README/results/owner phase updates, full local
verification, and bounded read-only review described above.

Approval does not authorize reading/changing a real credential, executing
`agent:run` or any other production provider command, network/provider requests,
live sentinel/canonical or credential- launcher execution, dependency/lockfile
changes, corpus/scorer/report changes, persistent agent state, `_refs/`
changes/execution, archive/sibling changes, destructive operations outside
test-owned temp fixtures, commit, push, tag, publish, or release. Any later
real-provider attempt remains a new explicit Human Gate with a fixed
command/task/request/cost/stop contract and retry/rerun/follow-up zero.
