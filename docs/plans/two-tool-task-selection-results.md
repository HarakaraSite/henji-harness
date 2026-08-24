# Henji Harness roadmap step 8 local results

## Scope

- Revision 15 / roadmap step 8 deterministic two-tool task selection.
- Approved plan: `docs/plans/two-tool-task-selection.md`
- Plan SHA-256: `cd9cc5b9d1233544c32b8fa0e1dce864dd3b5220a15bf63419d612b682b68cfa`
- Provider calls: 0. Credentials were not read or inspected.

## Changed files

- `v0/agent/tools.ts`: deterministic `character_count`.
- `v0/agent/two_tool_task_selection.ts`: fixed two-task registry and guarded selection.
- `tests/v0/two_tool_task_selection_test.ts`: permission-free success and failure coverage.
- `deno.v0.json`: direct selection task and v0 gate integration.
- `docs/plans/two-tool-task-selection-results.md`: this package.

## Evidence

- `character_count` counts Unicode code points with `Array.from(text).length`; `Henji 🐣` returns
  compact JSON `{"count":7}`.
- Both tools are advertised. Each fixed task may dispatch only its matching tool exactly once.
- Unknown, wrong, multiple, malformed, second-step tool calls, and wrong final responses terminate
  without retry, repair, fallback, or a third model call.
- Selection direct: 8 passed.
- `v0:check`: passed.
- `v0:fmt`: passed, 25 files.
- `v0:lint`: passed, 23 files.
- `v0:test`: 72 passed.
- `v0:gate`: passed.
- Implementation-time `git diff --check`: passed.

## Review

Post-implementation review: `NO-GO` with Blocker 0, P1 0, P2 1.

Deferred P2: the negative table lacks a well-typed but incorrect fixed value such as
`{text: "different"}`. The implementation rejects that value, but a regression from exact-value
checking to schema-only checking would not be caught by the current eight tests. The user explicitly
deferred this P2 in order to prioritize repository organization. No real-provider selection was
tested or authorized.
