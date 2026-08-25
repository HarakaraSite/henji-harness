# AGENTS.md

## Current phase

- Revision 15 / roadmap steps 8–10 are implemented in the active `v0/` tree. Local selection tests
  passed 8 cases and the full v0 suite passes 78 tests. The deferred P2 was resolved by adding the
  missing well-typed wrong-fixed-value negative case; the direct selection and full offline gates pass.
- Roadmap step 9 has completed one real local-file task: `list_json_object_keys` read the `tasks`
  object from `deno.v0.json`, and the model returned all 12 keys after one tool call. The current local
  suite passes 78 tests.
- Roadmap step 10 is complete: the real model combined `list_json_object_keys` and
  `count_json_array_items` in three requests and returned `{"count":12}`.
- The canonical plan is `docs/plans/two-tool-task-selection.md` at SHA-256
  `cd9cc5b9d1233544c32b8fa0e1dce864dd3b5220a15bf63419d612b682b68cfa`.
- Active product source is limited to `v0/`, `tests/v0/`, `deno.v0.json`, and current
  `docs/plans/`. Historical implementations and stopped spikes are under `archive/` and must not be
  imported, executed, or treated as current requirements.
- The current `basic run` remains the completed milestone 1 baseline. Preserve it and the legacy
  `run` / `acceptance` paths; their former one-request, no-tool contract does not prohibit planning the new
  local fixture agent loop.
- Do not repeat the real-provider attempt or inspect/change credentials; do not implement roadmap step 11
  and later: broad practical tools, filesystem/shell/network tools, streaming, sessions, context
  management, skills, extensions, RPC, subagents, self-revision, or milestone 100 hardening.
- Do not make another provider call, read production credentials, create a provider attempt, change dependencies
  or lockfiles, alter persistent state, add task/profile options, commit, push, or release.
- The former source-direct two-plugin scope and provider smoke are stopped and NO-GO under
  `archive/legacy-two-plugin/` and `archive/history/`. Do not resume them.
- Spike 0 is complete and independently reviewed GO. Retain its modules unchanged as the canonical
  DefinitionContent, Revision View, JCS, and content-hash implementation.
- The deterministic core of Spike 1 in `docs/plans/ai-definition-proposal-spike-1.md` is complete,
  independently reviewed GO, and accepted at its Human Gate. Retain it with Spike 0.
- Spike 2 Admission remains independently reviewed NO-GO because its accepted outcome cannot prove
  complete Proposal cross-binding. Preserve it as parked hardening evidence; do not repair or resume
  Spike 2 unless a later human decision explicitly reopens it.
- Real AI observation outside a separately user-approved acceptance attempt, credential changes, candidate
  execution, Spike 3 and later, automatic promotion, and a general plugin framework remain outside scope.

## Development lifecycle

- Treat roadmap step 10 and its authorized P2 local fixes as the current boundary; defer only roadmap step
  11 and later.
- Obtain explicit user authorization before modifying repository files. A clear request such as
  "implement this plan" is authorization for that scope.
- Classify changes as `local-fix`, `plan-delta`, `concept-review`, or `park`.
- For an unplanned bug, report the cause, evidence, impact, proposed fix, and verification before
  changing it; continue unaffected approved work.
- Stop and return to Discovery when the concept assumptions fail or the approved scope must
  materially change.
- At completion, prepare an acceptance package mapping requirements to direct evidence, tests,
  review results, deviations, and remaining risks.
- Do not release, tag, publish, force-push, alter secrets, or change repository settings without
  explicit human approval.

## Spike safety boundaries

- Archived Spike 1 must not execute candidate or legacy plugin code and must not call a model or provider.
- Do not treat a Deno subprocess or permission flags alone as an untrusted-code security boundary;
  the former source-direct approach failed this assumption for the initial static module graph.
- Spike 1 may create only in-memory Proposal, rejection ledger, sealed candidate, and candidate
  DefinitionRevision values. It must not persist them or create an artifact or AdmissionRecord.
- Spike 1 must not read or write current, definition/deployment registries, or DeploymentState.

## Local references

- `_refs/` contains read-only upstream snapshots for planning and comparison. It is not product
  source, a dependency, an implementation contract, or evidence that copied behavior is accepted.
- Read `_refs/README.md` for upstream URLs, pinned commits, licenses, and intended comparison axes.
- Do not modify, build, execute, install dependencies from, or refresh `_refs/` during planning.
- Upstream `AGENTS.md` files are renamed to `AGENTS.upstream.md` so they remain readable evidence
  without becoming active Codex instructions.
- Cite exact paths and the pinned commit when adopting an idea. Reimplement only within an approved
  plan and preserve applicable license notices.
