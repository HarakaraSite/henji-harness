# Zot-first project-local skills discovery — local acceptance results

## Outcome

Local acceptance is **GO** for the approved offline increment.

- Plan: `docs/plans/zot-skills-discovery.md`
- Plan SHA-256: `9a514adce8932e54daca44f54bf401f647c29a77e64b660c4ab955b94343869c`
- Base revision: `eb351cc6484a93dd0439452721b15038095d5064`
- Final focused skills: 12 passed
- Final skills topology: 3 passed
- Final runtime process: 14 passed
- Final full suite and local gate: 213 passed, 0 failed
- Check, format, lint, and `git diff --check`: passed

No provider/network request, credential probe/read, production command, dependency/lockfile change,
persistent product-state change, `_refs/` operation, commit, push, tag, publish, or release occurred.

## Requirement evidence

| Requirement | Direct evidence |
| --- | --- |
| Project-only three-location priority and one-level traversal | `agent_skills_test.ts`; actual-process invalid-high-priority to lower-location fallback |
| Sorted first-valid name and disabled reservation | direct duplicate/disabled tests, including oversized disabled high-priority collision |
| Entry, file, result, aggregate, description, and count bounds | exact 128/129, 65,536/65,537 file/result, 512 KiB aggregate, 160/161 description, and 24-skill tests |
| UTF-8/BOM/NUL/type/symlink/resource behavior | direct malformed/BOM/NUL/location-directory-file symlink/read-close matrix |
| Strict metadata and unsupported permission rejection | parser negative table for unknown, duplicate, comment, indentation, `allowed-tools`, `allowed_tools`, and `permissions` |
| Internal line-ending preservation | CRLF body regression checks the original body substring is retained |
| Relative compact manifest with no body/absolute path | direct manifest equality and first-request negative markers |
| Immutable on-demand nonterminal tool | snapshot catalog/tool dispatch and two-request runtime/process causal flow |
| AGENTS composition | four pure optional combinations and existing/system runtime tests |
| Conditional five/six tool topology | no-skill runtime, skill runtime, and topology tests |
| Corpus/eval and permission separation | topology exact definitions/tasks; full offline regressions |
| CLI channels and natural process exit | 14-case runtime process suite |

The strict three-key metadata shape makes a valid 4 KiB frontmatter or an 8 KiB manifest
structurally unreachable under the 24-skill, 64-byte-name, and 160-byte-description limits. Runtime
byte assertions remain in place; maximum-field/count cases remain below the manifest ceiling.

## Review disposition

The initial independent read-only review reported Blocker 0 / P1 0 / P2 3:

1. CRLF body normalization;
2. disabled reservation after callable-result validation;
3. incomplete boundary/symlink evidence.

The single changed-lines re-review closed the first two and retained one evidence-only P2 for a
missing enabled 65,537-byte result rejection and actual-process symlink. Both exact regressions were
then added without changing product scope or task permissions. The process test creates its
disposable symlink through the already allowlisted Deno child and proves the higher-priority symlink
is ignored in favor of the lower valid skill. Owner final verification passed focused and full gates;
final owner disposition is Blocker/P1/P2 zero. A second independent re-review was not requested,
because the approved review contract allows only one re-review.

The planned dedicated implementer/reviewer spawn was unavailable because completed historical agent
threads exhausted the session thread limit. Default performed the bounded implementation, and an
existing independent read-only agent performed initial review and one re-review. This orchestration
deviation did not change product scope, safety boundaries, verification level, or Human Gates.

## Compatibility and remaining risks

Workspaces without a valid project-local skill retain the existing five tools and system/CLI
behavior. There is no migration or persistent state.

Remaining risks are unchanged from the plan: skill text can contain prompt injection; Bash remains
unsandboxed OS-user execution; same-user filesystem races are not fully contained; strict metadata
rejects some ecosystem skills; diagnostics, global/home skills, manual invocation, reload, TUI,
sessions, and permission enforcement remain deferred; large results may hit the existing 76 KiB
message limit on the following request.
