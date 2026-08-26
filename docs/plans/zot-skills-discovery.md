# Zot-first project-local skills discovery — implementation and verification plan

## Decision summary

Concept **GO, initial Human Gate pending**.

The normal noninteractive `agent:run` will discover bounded project-local `SKILL.md` files once at
startup. It will add only a short manifest of callable skill names and descriptions to the existing
system instruction. Full skill bodies remain in an immutable in-memory snapshot and enter the model
transcript only after the model calls a new nonterminal `skill({name})` tool.

This slice is deliberately project-local. It does not read global/home/environment skill locations,
install built-ins, support manual slash-command invocation, reload skills, or claim to enforce skill
permission metadata. No current Deno permission is broadened.

Planning base revision: `eb351cc6484a93dd0439452721b15038095d5064`.

## Current verified state

- The normal runtime resolves one canonical workspace, optionally loads its direct `AGENTS.md`, and
  passes one immutable system instruction outside the transcript to at most eight model requests.
- The normal production registry exposes exactly `bash`, `edit`, `read`, `submit_json_result`, and
  `write`; corpus/eval use a separate registry.
- Registry definitions are name-sorted. `ToolInputError` and ordinary execution errors already have
  stable continuing-result classifications.
- OpenRouter messages are bounded at 76 KiB, full requests at 256 KiB, and responses at 1 MiB.
- `agent:run` already has `--allow-read=.`; direct project-local skill discovery needs no new read,
  environment, run, or network permission.
- No-context/no-skill success and failure preserve the current stdout/stderr contract.
- The current full offline gate passes 195 tests and independent review is GO.
- The fixed work-tools Gate S is consumed and will not be rerun by this increment.
- `_refs/deno-docs/`, `_refs/pi/`, and `_refs/zot/` are untracked reference state and are not
  implementation or commit targets.

## Zot reference and adoption decisions

The first reference is MIT-licensed Zot commit
`9b7bb6a4f36bc8c8deb2cc5796a8f557f4fb7479`.

| Pinned Zot evidence | Henji decision | Reason |
| --- | --- | --- |
| `_refs/zot/docs/skills.md` and `_refs/zot/README.md`: compact manifest plus on-demand `skill` tool | Adopt | Skill bodies do not consume every request before use |
| `_refs/zot/packages/agent/skills/skills.go`: native/compat locations, first-match-wins, final name sort | Adopt with project-only scope | It preserves ecosystem layout without implicit global state |
| Same source: global/home paths, `ZOT_AGENT_SKILLS`, and built-ins | Defer | They add hidden state or additional trust/permission contracts |
| Same source: optional name, basename fallback, description, disable flag | Adopt with strict validation | These are the minimum model-selection metadata |
| Same source: permissive YAML-like parsing and unbounded reads/counts | Deviate | Startup instruction input must be deterministic and finite |
| Same source: parses but does not enforce `allowed-tools` and `permissions` | Deviate: reject these fields | Henji must not imply an unenforced security boundary |
| `_refs/zot/packages/agent/skills/tool.go`: exact-name, nonterminal body loader | Adopt with strict schema and bounded static errors | It fits the current Registry and loop contracts |
| Same source: absolute paths in manifest/details | Deviate | Host absolute paths must not be model-visible |
| `_refs/zot/packages/agent/skills/invocation.go`: skill directory for relative references | Adopt only in tool result | Manual `/skill:` invocation remains out of scope |
| Zot build composition: manifest and tool use one discovery result | Adopt | One startup snapshot prevents manifest/lookup drift |

Implementation will be independent TypeScript. `_refs/` will not be imported, executed, changed,
refreshed, or treated as a dependency.

## Scope

In scope:

- three bounded project-local skill locations under the canonical workspace;
- strict deterministic `SKILL.md` metadata/body parsing;
- an immutable startup skill catalog and compact system manifest;
- one conditional, nonterminal `skill` tool in the normal production registry;
- composition with the existing workspace `AGENTS.md` system instruction;
- permission-free direct tests, fake-provider runtime/process tests, topology checks, README/results,
  full offline verification, and bounded review.

Out of scope:

- global/home/ZOT_HOME/environment skill locations and built-in skills;
- manual `/skill:`, slash commands, skill list/install/update/reload UI, or hot reload;
- accepting or enforcing `allowed-tools`, `permissions`, or capability manifests;
- TUI, sessions/persistence, compaction, streaming, extensions/RPC, subagents;
- dynamic provider/model/tool selection, sandboxing, or retry changes;
- corpus/eval behavior, work-tool behavior, Gate S, legacy/basic behavior;
- dependencies/lockfiles, provider/network execution, credential access, `_refs/`, archive, siblings,
  commit, push, tag, publish, or release.

## Exact discovery contract

### Locations and deterministic traversal

For canonical workspace `W`, search these case-sensitive locations in this priority order:

1. `W/.zot/skills`
2. `W/.claude/skills`
3. `W/.agents/skills`

For each location:

1. Accept only a non-symlink directory after `lstat`. Missing, unreadable, symlink, or non-directory
   locations are silently skipped.
2. Observe at most 129 direct entries. With 128 or fewer, sort entry names by JavaScript code-unit
   order. If a 129th entry exists, skip the entire location so enumeration order cannot select a
   nondeterministic subset.
3. Consider only entry names matching the identifier contract below. Recheck each candidate as a
   non-symlink directory.
4. Check only `<location>/<directory>/SKILL.md`. Do not recurse, accept alternate filename case, or
   accept a `SKILL.md` directly in the location root.
5. Require the path and opened handle to both report a regular, non-symlink file.
6. Observe at most 65,537 raw bytes. More than 65,536 bytes skips the file; never truncate it.
7. Process candidates in location priority and sorted directory order. First valid unique skill name
   wins. An invalid candidate does not reserve its name.
8. A valid `disable-model-invocation: true` candidate reserves its name but appears in neither the
   manifest nor model-callable lookup. A lower-priority same-name skill cannot revive it.
9. Stop after 24 callable skills or 512 KiB of aggregate formatted tool results. The remaining lower-
   priority candidates are not adopted.

Directory basenames and effective skill names must match:

```text
^[a-z0-9][a-z0-9._-]{0,63}$
```

Identifiers are ASCII, 1–64 bytes, and case-sensitive.

### File, UTF-8, and resource behavior

- Fatal UTF-8 decoding; accept and remove one UTF-8 BOM.
- Reject NUL and ill-formed Unicode. Do not normalize Unicode or internal line endings.
- Every opened handle is closed on success and all error paths.
- Directory/file/parse/limit errors are silent at startup. They do not enter stdout, stderr, the
  manifest, a tool result, or persisted evidence, and do not reveal OS errors or absolute paths.
- This is a trusted-local best-effort boundary, not complete hostile same-user TOCTOU protection.

## Exact frontmatter and body contract

A valid file must begin on its first logical line with exact `---` and contain a later standalone
exact `---` closing line. LF and CRLF are accepted. Leading blank/text, delimiter suffixes, missing
closing delimiter, comments, indentation, nested structures, and multiline scalars are rejected.

Frontmatter is limited to 4 KiB and recognizes only:

- `name`: optional; the directory basename is the fallback;
- `description`: required;
- `disable-model-invocation`: optional, default `false`.

Rules:

- Unknown or duplicate keys are invalid. This includes `allowed-tools`, `allowed_tools`, and
  `permissions`, because the current runtime would not enforce them.
- `name` and `description` accept a plain scalar or a scalar enclosed by matching single or double
  quotes. Escapes, tags, anchors, aliases, and inline comments are not interpreted.
- `description` is trimmed, nonblank, one logical line, valid text, and at most 160 UTF-8 bytes.
- The disable value is only unquoted lowercase `true` or `false`.
- The body is all text after the closing delimiter, ECMAScript-trimmed. It must be nonblank.
- No templates, includes, automatic reference reads, Unicode normalization, or line-ending
  normalization occur.
- A candidate is callable only if its fully formatted success tool result is at most 65,536 UTF-8
  bytes.

## Immutable snapshot contract

The skill module represents at least:

```ts
interface DiscoveredSkill {
  readonly name: string;
  readonly description: string;
  readonly sourceDirectory: string;
  readonly body: string;
  readonly toolResult: string;
}

interface SkillCatalog {
  readonly skills: readonly DiscoveredSkill[];
  readonly manifest?: string;
}
```

- `sourceDirectory` is workspace-relative, for example `./.zot/skills/code-review`.
- Public catalog values contain no absolute path.
- Final callable skills are sorted by effective name.
- Arrays/maps are defensively copied or immutable.
- Discovery reads and formats each body once. Tool execution never rereads the filesystem. Edits,
  deletion, or symlink swaps during the run affect only the next `agent:run` invocation.

## Manifest and system-instruction composition

With one or more callable skills, generate this exact format, sorted by name and without a trailing
newline:

```text
Available project skills. When a request matches one, call `skill` with its exact name to load the saved instructions.
- code-review — Review a recent change. (source: ./.zot/skills/code-review)
```

- Manifest limit: 8 KiB after UTF-8 encoding.
- It contains no disabled skill, body, frontmatter, invalid candidate, absolute path, or discovery
  diagnostic.

Let existing accepted workspace instruction be `A` and skill manifest be `M`:

- neither: `undefined`;
- `A` only: `A` unchanged;
- `M` only: `M`;
- both: `${A}\n\n${M}`.

This one immutable string is passed outside the transcript to every model request. Skill bodies do
not appear in the system instruction, task, tool definition, or transcript before a successful
`skill` tool result. Existing 76 KiB message and 256 KiB request limits remain unchanged and apply
after composition.

## Exact `skill` tool contract

Register the tool only when the callable catalog is nonempty:

```json
{
  "name": "skill",
  "description": "Load the saved instructions for one project skill listed in the system manifest.",
  "inputSchema": {
    "type": "object",
    "properties": { "name": { "type": "string" } },
    "required": ["name"],
    "additionalProperties": false
  }
}
```

- Arguments must be exactly `{name:string}` and the name must satisfy the identifier contract.
- Lookup is case-sensitive exact match.
- Invalid shape/name throws `ToolInputError("expected an object with only a valid skill name")`,
  producing:

```text
invalid arguments: expected an object with only a valid skill name
```

- Valid but unknown/disabled names throw static `Error("skill not found")`, producing:

```text
tool execution error: skill not found
```

The error never echoes the requested name, catalog, candidates, paths, or content.

Success returns this exact startup-formatted text with no trailing newline, bounded to 65,536 UTF-8
bytes:

```text
# Skill: code-review

Review a recent change.

Skill directory: ./.zot/skills/code-review
Resolve relative paths in these instructions from that directory.

---

<body>
```

The result is nonterminal and may be called more than once. It enters the normal tool-result
transcript and is visible to the next model request. Relative references are not automatically read;
the model may use existing tools relative to the supplied workspace-relative directory.

With no callable skill, the registry remains exactly five tools. With skills, stable sorted order is
`bash`, `edit`, `read`, `skill`, `submit_json_result`, `write`. Corpus/eval remain their existing
separate five-tool registry.

## File ownership and changes

- New `v0/agent/skills.ts`
  - constants, filesystem seam, bounded traversal/read, strict parser, dedup/reservation, immutable
    snapshot, manifest, tool-result formatter, and `createSkillTool`.
- `v0/agent/agent_instructions.ts`
  - add only a pure helper composing optional AGENTS instruction and optional skill manifest;
  - retain existing discovery behavior and avoid a reverse dependency on the skill module.
- `v0/agent/registries.ts`
  - conditionally add the skill tool to the production registry only; do not change corpus factory.
- `v0/agent/runtime.ts`
  - after workspace resolution, discover AGENTS and skills once, compose system context, construct the
    matching registry, and invoke the loop;
  - add only direct-test filesystem seams; no product option or environment source.
- New `tests/v0/agent_skills_test.ts`
  - permission-free discovery/parser/limit/manifest/tool tests.
- `tests/v0/agent_runtime_test.ts`
  - conditional six-tool composition, immutable snapshot, exact system composition, five-tool no-
    skill compatibility.
- `tests/v0/fixtures/runtime_process_fixture.ts`
  - actual workspace skill and fake-provider skill-call flow.
- `tests/v0/agent_runtime_process_test.ts`
  - actual paths, priority/symlink rejection, relative source, channels, and natural exit.
- New `tests/v0/agent_skills_topology_test.ts`
  - production permission, no global/env source, gate wiring, corpus separation, and provider-task
    exclusion.
- `tests/v0/agent_loop_test.ts` only if current generic evidence does not directly prove the skill
  result's nonterminal causal/max-step behavior.
- `deno.v0.json`
  - add permission-free `agent:skills:test` and a topology test reading only `deno.v0.json`;
  - add new files to check and focused tasks exactly once to the local gate;
  - do not alter production `agent:run` permissions or provider/credential tasks.
- `README.md`
  - document project paths, priority, limits, strict metadata, disable behavior, snapshot, manifest,
    tool, relative source, and no-skill compatibility.
- New `docs/plans/zot-skills-discovery-results.md`
  - measured implementation/review acceptance package.
- `AGENTS.md` and `.handoff/handoff.md`
  - owner-only measured phase/checkpoint updates after local gate and review.

Do not change OpenRouter wire contract, CLI parsing/output, work tools, corpus/eval source/data,
sentinel/credential launchers, legacy/basic paths, dependencies/lockfiles, `_refs/`, archive, or
sibling repositories.

## Ordered implementation

1. Save this plan, compute its SHA-256, and stop at the initial Human Gate.
2. Implement the pure parser, bounded discovery, and snapshot formatter with permission-free tests.
3. Add manifest and conditional skill tool, proving success/error/disable/dedup/source/snapshot
   behavior directly.
4. Add the pure AGENTS/manifest composer and prove all four optional-input combinations.
5. Wire only the normal registry/runtime and prove five-tool/no-skill and six-tool/skill cases.
6. Add actual-process evidence: first request contains only manifest, second contains the skill result,
   channels remain stable, and the child exits naturally.
7. Add topology/config wiring and README.
8. Run focused, related regression, full offline gate, and `git diff --check`.
9. Create results and lifecycle records from measured evidence only.
10. Run one bounded independent read-only review. Fix accepted in-scope findings and perform at most
    one changed-lines re-review.
11. Present the acceptance package. Do not run a provider sentinel or commit automatically.

## Verification matrix

| Requirement / failure mode | Direct evidence |
| --- | --- |
| Exact three locations, priority, project-only | direct location matrix and process parent/home markers |
| One-level sorted traversal | unsorted entries, nested files, non-directory entries |
| 128/129 location-entry bound | exact boundary and full-location skip |
| Directory/file symlink and special rejection | lstat/open-stat matrix and actual process symlink |
| 65,536/65,537 raw bytes and close | observed-byte/resource assertions |
| UTF-8/BOM/NUL/frontmatter/body | parser positive/negative table |
| Name, 160-byte description, keys | exact boundaries and malformed table |
| First valid name wins | same/cross-location frontmatter name collisions |
| Disabled name reservation | high-priority disabled plus lower enabled duplicate |
| 24 skills, 512 KiB aggregate, 8 KiB manifest | exact boundary cases |
| No absolute path/body before use | captured first request negative-marker assertions |
| Exact AGENTS+manifest composition | full system string equality |
| Conditional tool | no-skill exact five; skill exact sorted six |
| Tool schema/errors/success | Registry dispatch equality |
| 64 KiB tool result | exact accepted/rejected boundary |
| Startup snapshot | post-discovery file mutation does not alter result |
| Relative source | native/Claude/Agents success results |
| Nonterminal causality | request 1 manifest/tool call; request 2 tool result/final |
| Eight requests/no retry/current bounds | existing tests plus final-step skill-call regression if needed |
| Corpus/eval separation | exact corpus definitions and topology |
| CLI channels/natural exit | actual child stdout/stderr/exit/deadline |
| Permission boundary | `agent:run --allow-read=.` unchanged; no home/env grant |
| Gate S preservation | local gate excludes production/credential tasks |

## Exact local verification commands

Use the repository-pinned Deno 2.9.4 binary:

```text
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --config deno.v0.json agent:skills:test
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --config deno.v0.json agent:skills:topology:test
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --config deno.v0.json agent:instructions:test
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --config deno.v0.json agent:test
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --config deno.v0.json agent:transport:test
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --config deno.v0.json agent:runtime:test
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --config deno.v0.json agent:runtime:process:test
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --config deno.v0.json agent:corpus:eval:test
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --config deno.v0.json agent:corpus:eval:live:test
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --config deno.v0.json v0:check
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --config deno.v0.json v0:fmt
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --config deno.v0.json v0:lint
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --config deno.v0.json v0:test
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --config deno.v0.json v0:gate
git diff --check
```

Do not execute `agent:run`, `agent:acceptance`, live sentinels, or credential-file tasks during this
local gate.

## Review and acceptance

Initial read-only review is limited to the changed diff and 30 minutes. If no new evidence, tool
result, or interim conclusion appears for 10 minutes, stop and return the verified scope. Review the
trusted-local Deno 2.9.4 environment with workspace skill text treated as untrusted model instruction,
not executable host configuration.

Report Blocker/P1/P2 for:

- global/home/env discovery, permission expansion, recursion, or symlink following;
- unbounded enumeration/read, resource leak, or nondeterministic partial adoption;
- body/absolute path leakage into the manifest or first request;
- manifest/tool snapshot drift or tool-time filesystem reread;
- disabled/duplicate priority failure;
- unsupported permission metadata appearing enforced;
- tool-result overflow or Registry error-contract drift;
- AGENTS composition, tool causality, 76/256 KiB bound regressions;
- no-skill, corpus/eval, five-tool, eight-request/no-retry, CLI, or Gate S regression.

After accepted fixes, perform at most one changed-lines re-review, limited to 15 minutes and existing
finding closure. Local GO requires Blocker/P1/P2 zero.

The results package records the plan hash, requirement-to-test mapping, exact commands/counts,
review disposition, deviations, remaining risks, and zero provider/credential operations. It must not
record a user's real skill body, absolute paths, credentials, or private instruction content.

## Compatibility, rollback, and risks

There is no migration or persistent state. A workspace without a valid project-local skill retains
the current system instruction, five tools, wire behavior, and CLI channels.

Rollback removes the skill module/tests/tasks/docs and restores the additive runtime/registry/system-
composer wiring. It does not reset the worktree, remove user skill files, or touch provider state,
credentials, corpus/eval, Gate S evidence, or `_refs/`.

Remaining risks:

- Project-local skills can contain prompt injection; semantic sanitization is not attempted.
- Bash remains unsandboxed OS-user execution. Skill permission fields are rejected, not enforced.
- Filesystem `lstat`/open races are not complete hostile same-user containment.
- Silent-skip diagnostics are unavailable without later UI work.
- Strict frontmatter is not full YAML and rejects some Zot/Claude/Agents ecosystem skills.
- Global/home skills, built-ins, manual invocation, and reload are unavailable.
- Startup snapshot means edits appear only on the next run.
- A large skill result may make the next request hit the existing 76 KiB message limit. This slice
  does not truncate, compact, or raise that limit.

## Human Gate

Implementation requires explicit user approval of this plan and its SHA-256, including:

1. the three project-local locations and priority;
2. one-level sorted bounded traversal and first-valid-name-wins;
3. strict metadata with unsupported `allowed-tools`/`permissions` rejected;
4. disabled skills reserving names but being unavailable to the model;
5. limits of 24 skills, 128 entries/location, 64 KiB/file/result, 512 KiB aggregate, 8 KiB manifest;
6. startup snapshots and on-demand nonterminal tool results with relative source directories;
7. local fake-provider/offline verification only.

Approval does not authorize provider/network execution, credentials, dependencies/lockfiles,
`_refs/`, commit, push, tag, publish, or release.
