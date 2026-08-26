# Henji Harness

Henji Harness is a small trusted-local Deno agent harness. The active pre-alpha implementation is
the `v0` tree; older implementations and stopped experiments are retained under `archive/` only as
historical evidence.

## Current implementation

- Product source: [`v0/`](v0/)
- Tests: [`tests/v0/`](tests/v0/)
- Task configuration: [`deno.v0.json`](deno.v0.json)
- Current plans and results: [`docs/plans/`](docs/plans/)
- Resume state: [`.handoff/handoff.md`](.handoff/handoff.md)

Use the exact Deno 2.9.4 binary embedded in `deno.v0.json`. The main local commands are:

```text
deno task --config deno.v0.json agent:fixture
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --quiet --config deno.v0.json agent:run --task 'ARBITRARY TASK'
printf '%s\n' 'ARBITRARY TASK' | /home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --quiet --config deno.v0.json agent:run
deno task --config deno.v0.json agent:test
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --config deno.v0.json agent:runtime:test
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --config deno.v0.json agent:work-tools:test
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --config deno.v0.json agent:runtime:process:test
deno task --config deno.v0.json agent:transport:test
deno task --config deno.v0.json agent:acceptance:test
deno task --config deno.v0.json agent:selection:test
deno task --config deno.v0.json v0:check
deno task --config deno.v0.json v0:fmt
deno task --config deno.v0.json v0:lint
deno task --config deno.v0.json v0:test
deno task --config deno.v0.json v0:gate
```

`agent:acceptance` is the production provider task. Run it only on explicit user instruction; it is
not a local test. Local gates use fixtures and require no credential.

## Normal runtime (roadmap step 11)

The agent:run task accepts exactly one nonblank task, from --task TEXT or from non-TTY stdin.
Supplying both sources, an unknown or positional argument, invalid UTF-8, or input over 65,536 UTF-8
bytes fails before model or credential setup. The single-shot runtime advertises exactly these five
tools in stable name order: `bash`, `edit`, `read`, `submit_json_result`, and `write`. The versioned
corpus/evaluation registry retains the four toy domain tools separately and they are not advertised
by normal `agent:run`. JSON answers must use `submit_json_result` as the sole tool call in a batch;
the host canonicalizes the complete JSON value and prints it on stdout. Plain-text answers retain
the assistant final path.

`read`, `write`, and `edit` use the canonical invocation working directory as a fixed workspace.
Paths may be relative or absolute within that root, are component-checked, reject symlinks and
special files, and accept only well-formed UTF-8 text up to 65,536 bytes. Writes and edits use a
synced sibling temporary file and atomic rename; this gives atomic visibility but does not promise
directory-fsync crash durability or protection from hostile same-user races. `edit` applies up to
32 exact, unique, non-overlapping replacements against one original snapshot.

`bash` always runs `/bin/bash --noprofile --norc -c COMMAND` from the workspace with a clean fixed
environment (`PATH`, `LANG`, and `LC_ALL` only), separate 4,096-byte stdout/stderr capture, and a
30,000 ms default / 120,000 ms maximum timeout. The invocation itself authorizes local work; there
is no per-tool prompt or additional CLI flag. Bash is trusted-local OS-user execution, not a
workspace sandbox: it can access outside files, network, and descendants, and timeout cleanup
guarantees only the direct child is killed and reaped.

Before the first normal-runtime model request, the host optionally reads one standing-instruction
file directly under the canonical workspace: `AGENTS.md` is preferred over `AGENTS.MD`, and the
first present candidate wins. Only regular non-symlink files with valid UTF-8 text up to 16 KiB are
accepted; blank, NUL-containing, malformed, oversized, or unreadable files are silently skipped.
The accepted text is sent as one first-class `system` message on every provider request, outside
the user task and loop transcript. Discovery does not inspect ancestors, global/home state, child
directories, or other spelling variants, and does not broaden the existing `agent:run` workspace
read permission.

Success writes only the final assistant text to stdout (adding one newline when needed), with an
empty stderr. Failure writes one compact sanitized JSON record to stderr, with empty stdout. The
fixed profile may make up to eight provider requests and performs no application retry. agent:run is
therefore a production provider command: do not invoke it without explicit user instruction and do
not provide credentials to local tests or gates.

## Fixed local work-tools sentinel

The Gate L sentinel is a fixed five-call acceptance child using the production model, loop, and
work-tool registry: `write`, `read`, `edit`, `bash`, then the sole terminal `submit_json_result`
call. It runs only in the dedicated dummy/fake-provider local tasks:

```text
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --config deno.v0.json agent:work-tools:sentinel:test
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --config deno.v0.json agent:work-tools:sentinel:process:test
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --config deno.v0.json agent:work-tools:sentinel:topology:test
```

The production-only `agent:work-tools:sentinel:credential-file` task is excluded from every local
gate. It reads the repo-external credential once, creates one mode-0700 disposable workspace, and
removes it after the bounded child run. Gate L never reads credential metadata or content, opens a
provider connection, or runs this production task; Gate S requires a separate explicit approval.

## Current baseline

Roadmap steps 8–10 are complete. Step 8 added deterministic `character_count` beside `uppercase_text` and enforces selection
of the task-matching tool. Before the cleanup, selection direct tests passed 8 cases, the full v0
suite passed 72 tests, and check, format, lint, gate, and diff check passed. The post-implementation
review found no Blocker or P1 and one P2 for a missing negative test. The later local-fix added a
well-typed but incorrect fixed `text` value to the negative table; direct selection and full offline
gates pass with the regression covered.

Roadmap step 9 adds `list_json_object_keys` and completed one real task against `deno.v0.json`:
the model selected the tool once and returned the 12 task names. The first result differed from the
compact tool JSON only by whitespace, so completion now compares the parsed string arrays. No retry
or second provider attempt was made; the current full local suite passes 78 tests.

Roadmap step 10 combines `list_json_object_keys` with `count_json_array_items`. A real model used
the two tools in order over three requests and returned `{"count":12}`. The first attempt stopped
after the list because character counting was not a natural continuation; the task was corrected to
count JSON-array items, then completed without further changes.

The active step 5–10 evidence is retained in `docs/plans/`. Roadmap step 11's normal CLI runtime is
specified in [`docs/plans/zot-first-cli-agent-runtime.md`](docs/plans/zot-first-cli-agent-runtime.md), with the
Zot-first local work-tool increment recorded in [`docs/plans/zot-local-work-tools-results.md`](docs/plans/zot-local-work-tools-results.md).
It accepts one task from argv or stdin, allows at most eight model requests, and performs no
application retry. Broader sessions, context management, skills, extensions, RPC, subagents,
self-revision, and dynamic provider/model selection remain later roadmap work.

## Versioned small task corpus

The current offline corpus is [`v0/corpus/task-corpus.v1.json`](v0/corpus/task-corpus.v1.json),
schema version 1 and corpus ID `henji-normal-cli-small-v1`. It contains exactly 24 canonical cases:
four final-only cases, four cases for each of the four single-tool categories, and four multi-tool
cases. The strict loader and case-local scorer are in [`v0/corpus/task_corpus.ts`](v0/corpus/task_corpus.ts).

Run its focused validation with:

```text
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --config deno.v0.json agent:corpus:test
```

The corpus validates only the literal `deno.v0.json` `fmt` and `lint` fixtures. This increment is
offline data validation and mechanical scoring only; it does not include an evaluation runner,
provider/model invocation, production command, score aggregation, or credential access.

## Archive

[`archive/`](archive/) is not active product source and is excluded from normal v0 commands:

- `archive/legacy-two-plugin/`: stopped source-direct two-plugin implementation and tests.
- `archive/safety-spikes/`: Spike 0–2 source, tests, configs, scripts, and evidence.
- `archive/history/`: superseded pre-alpha plans and results.

The archived implementations, spikes, and superseded plans are historical evidence that can be
reconsidered intentionally as future decisions are made. See [`archive/README.md`](archive/README.md)
for the retention boundary.

## Reference snapshots

[`_refs/`](_refs/) contains upstream snapshots used for comparison. It is reference material, not
product source or a dependency. A useful refresh records the upstream URL, pinned commit, license,
and comparison of adopted behavior in [`_refs/README.md`](_refs/README.md).
