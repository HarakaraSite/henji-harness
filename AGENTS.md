# AGENTS.md

## Current phase

- Revision 15 / roadmap steps 8–10 are implemented in the active `v0/` tree. Local selection tests
  passed 8 cases and the full v0 suite passes 78 tests. The deferred P2 was resolved by adding the
  missing well-typed wrong-fixed-value negative case; the direct selection and full offline gates pass.
- Roadmap step 9 completed a real local-file task: `list_json_object_keys` read the `tasks` object
  from `deno.v0.json`, and the model returned all 12 keys after one tool call. Roadmap step 10 then
  combined `list_json_object_keys` and `count_json_array_items` in three requests and returned
  `{"count":12}`.
- The canonical plan is `docs/plans/two-tool-task-selection.md` at SHA-256
  `cd9cc5b9d1233544c32b8fa0e1dce864dd3b5220a15bf63419d612b682b68cfa`.
- Active product source is in `v0/`, `tests/v0/`, `deno.v0.json`, and current `docs/plans/`.
  The current `basic run` remains the completed milestone 1 baseline, and the legacy `run` /
  `acceptance` paths retain their existing behavior.
- The normal CLI runtime for roadmap step 11 is specified in
  `docs/plans/zot-first-cli-agent-runtime.md` and is implemented in the active tree. Its direct
  offline suite passes 14 tests and the full v0 gate passes 92 tests; independent review is GO with
  Blocker/P1/P2 zero. Broader tools, streaming, sessions, context management, skills, extensions,
  RPC, subagents, self-revision, and milestone 100 hardening are later roadmap work.
- The next proposed increment is the test-only normal CLI offline process E2E in
  `docs/plans/normal-cli-offline-process-e2e.md`. Its local implementation, offline validation,
  results, and bounded review are user-approved. It does not authorize a production provider
  command or credential access.

## Development lifecycle

- Use the user-provided requirements, repository plans, this file, and the current handoff as the
  working sources of truth. Inspect existing changes before editing and preserve work by other agents.
- Report an unplanned bug with its cause, evidence, impact, proposed fix, and verification before
  changing it. At completion, prepare an acceptance package mapping requirements to evidence, tests,
  review results, deviations, and remaining risks.
- Read or change production credentials only with explicit human approval, and never display or record
  credential values.
- Run production provider commands only on explicit user instruction; keep them out of local tests and
  gates. Production attempts are single, observable operations with no automatic retry.
- Destructive repository operations require explicit human approval. Push, tag, release, publish,
  and force-push also require explicit human approval.

## Historical evidence

- `archive/` contains stopped implementations, spikes, and superseded plans as historical evidence.
  Spike 0 and the deterministic core of Spike 1 were independently reviewed GO; Spike 2 Admission
  remains independently reviewed NO-GO because its accepted outcome cannot prove complete Proposal
  cross-binding. These outcomes inform future decisions and are not current product requirements.

## Local references

- `_refs/` contains upstream snapshots for planning and comparison. It is reference material, not
  product source, a dependency, or an implementation contract.
- A useful refresh records the upstream URL, pinned commit, applicable license, and comparison of any
  adopted behavior in `_refs/README.md`. Upstream `AGENTS.md` files are renamed to
  `AGENTS.upstream.md` so they remain evidence without becoming active repository instructions.
- Cite exact paths and the pinned commit when adopting an idea, reimplement it within the approved
  plan, and preserve applicable license notices.
