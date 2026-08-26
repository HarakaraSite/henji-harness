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
- The test-only normal CLI offline process E2E in
  `docs/plans/normal-cli-offline-process-e2e.md` is implemented. Its focused suite passes 9 tests
  (6 process matrix cases and 3 harness-safety cases), the full v0 gate passes 101 tests, and the
  changed-lines re-review is GO with Blocker/P1/P2 zero. It did not run a production provider
  command or access credentials.
- The 24-case versioned corpus in `docs/plans/small-task-corpus.md` is implemented. Its focused
  suite passes 9 tests, the full v0 gate passes 110 tests, and the changed-lines re-review is `GO`
  with Blocker/P1/P2 zero after the canonical fixture-tuple P2 was fixed. This increment did not
  add an eval runner or invoke a model/provider, production command, or credential access.
- The offline eval runner in `docs/plans/offline-corpus-eval-runner.md` is implemented. Its focused
  suite passes 14 tests, the default CLI returns one completed 24/24/24/0 report, the full v0 gate
  passes 124 tests, and changed-lines re-review is `GO` with Blocker/P1/P2 zero after three P2 fixes.
- The next increment is planned in `docs/plans/live-corpus-evaluation.md` at SHA-256
  `700d8427a9ea976d454d6b2d88d3f4920575ddd2447fb96122d5cd9e10400ef8`. Gate A local
  implementation, permission-free tests, full offline verification, and bounded review are complete.
  The focused live suite passes 10 tests, the full v0 gate passes 134 tests, and changed-lines
  re-review is `GO` with Blocker/P1/P2 zero after four P2 fixes. The one authorized six-case sentinel
  command was consumed and aborted with `provider_missing_credential` before any external request;
  it was not retried. The repo-external credential launcher is planned in
  `docs/plans/repo-external-credential-launcher.md` at SHA-256
  `c8841539fea5ec10479c81c77da53bab0713707d80cdad3b46a7e87a4fe9afd9`. Its local-only
  implementation is complete: direct 8, process 1, topology 1, and full v0 144 tests pass. Initial review's
  sole P1 was resolved by the reviewed local plan delta granting only `--allow-sys=uid` for the fixed owner
  check; changed-lines re-review is `GO` with Blocker/P1/P2 zero. No real credential or provider command was
  used during the local gate. The separately authorized new one-shot sentinel was consumed at launcher
  preflight with `credential_invalid`: child spawn 0, external requests 0, and no retry/rerun/follow-up.
  The user confirmed multiple terminal newlines as the structural cause and approved a parser local-fix that
  strips only terminal LF/complete CRLF sequences. Direct 8/process 1/topology 1/full 144 remain green, and
  parser review is `GO` with Blocker/P1/P2 zero. Do not inspect or change the credential or create another
  attempt without a new explicit approval. The separately approved post-fix sentinel completed all six cases
  with external requests 12/12: 5 passed and `v1.multi-tool.fmt.explicit` failed only because its correct JSON
  value was wrapped in a Markdown fence (`oracle_json_malformed`); errors/not-run were zero and it was not
  rerun. Gate C is ineligible, and aggregation/statistics and persistence remain outside scope.
- The Pi-style terminal JSON submission plan at
  `docs/plans/pi-style-json-result-submission.md`, SHA-256
  `56fcfc5044993db7ede70ed88ded5931cc15d8500869d7b94815e0e59bda143e`, is implemented.
  `submit_json_result({json:string})` is the fifth fixed runtime tool; successful sole calls end with
  `tool_terminal` and no follow-up request. Offline/live writers emit report v2 while retaining v1
  read validation, and corpus domain-tool scoring remains separate from submission evidence. Agent 20,
  offline 14, live fake 10, and the full v0 gate 154 tests pass. Initial review found four P2s plus a
  test gap; the single re-review confirmed the implementation fixes and left one test-only P2, which
  the final owner gate closed with exact delayed-abort regressions and Blocker/P1/P2 zero. No provider,
  network, credential, production command, corpus data, dependency/lockfile, or persistent-state
  operation was used during the local gate. The separately approved Pi-style one-shot sentinel then
  completed 6/6 passed with 12/12 external requests: all four JSON cases used successful terminal
  submissions and both text cases used assistant finals. It was not retried or rerun. Any further
  real-provider attempt remains a separate explicit Human Gate.

## Development lifecycle

- Use the user-provided requirements, repository plans, this file, and the current handoff as the
  working sources of truth. Inspect existing changes before editing and preserve work by other agents.
- Report an unplanned bug with its cause, evidence, impact, proposed fix, and verification before
  changing it. At completion, prepare an acceptance package mapping requirements to evidence, tests,
  review results, deviations, and remaining risks.
- Read or change production credentials only with explicit human approval, and never display or record
  credential values.
- The repo-external OpenRouter credential location and non-secret metadata are recorded in
  `docs/operations/openrouter-credential.md`. Consult that document instead of rediscovering or
  moving the file; do not read its contents without explicit approval.
- Run production provider commands only on explicit user instruction; keep them out of local tests and
  gates. Production attempts are single, observable operations with no automatic retry.
- Do not require a fresh provider-pricing lookup before a bounded small test. Refresh official pricing
  and calculate a cost ceiling when high token use, many requests, or otherwise material spend is
  reasonably expected. Check model availability or API/tool contracts separately when their current
  behavior is uncertain; do not turn that contract check into a routine price check.
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
