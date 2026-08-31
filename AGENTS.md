# AGENTS.md

## Current phase

- Roadmap Step 82 (`docs/plans/daily-editor-no-lost-input.md`, SHA-256
  `a0be3aedc6e3612b123cdf92073dd3e4febf4da61d21323d4d7d113a9614d0fa`) is implemented. The bounded scalar multiline
  editor/history with mutation detachment, typed discard/signal transitions, bounded SS3 decoder,
  root-relative file index with iterator/drift bounds, fixed pending lanes, modern controller
  wiring, metadata/layout helpers, canonical prepared-workspace wiring, and sanitized restore
  result are present. Focused editor/render/controller suites pass 25/25, 11/11, and 47/47;
  pending/file-reference leaves pass 3/3 and 6/6; PTY 33/33, portable 2/2, persistent-session
  9/9, steering 7/7, and authoritative `v0:gate` passes 624/624 with topology 2/2,
  check/fmt/lint/diff green. Initial review P1 2/P2 4 was closed in the approved single closure;
  the narrow re-review is `GO` with Blocker/P1/P2 zero, and the owner independently reran focused
  suites and the full 624/624 gate. Do not run the separate provider-free representative acceptance
  without a new explicit Human Gate. No provider, network, credential, production command,
  persistent product state, dependency/lockfile, `_refs/`, push, tag, publish, or release operation
  was performed for Step 82. The reviewed increment is recorded by the user-authorized final commit.

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
  Blocker/P1/P2 zero. Broader streaming, extensions, RPC, subagents,
  self-revision, and milestone 100 hardening are later roadmap work.
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
- The Zot-first local work tools plan at
  `docs/plans/zot-local-work-tools.md`, SHA-256
  `be8fdd758ca3efe62bf1058a7a6d21c41a47cdc2ed436a87c58aaa3a38f3608e`, is implemented.
  Production `agent:run` now exposes `bash`, `edit`, `read`, `submit_json_result`, and `write`, while
  corpus/eval runners retain their separate five-tool domain registry. Work-tools 13, runtime 10,
  process 11, and the full v0 gate 164 tests pass. Initial review found P1 1/P2 2; the single
  re-review confirmed both P2 fixes but found the Bash reap portion of P1 incomplete. The owner
  final gate closed it with a direct TERM-ignoring/SIGKILL/reap regression and the full offline gate.
  Bash remains intentionally unsandboxed trusted-local OS-user execution; external isolation and
  complete descendant containment remain future work. No provider, network, credential,
  production command, dependency/lockfile, persistent-state, or `_refs/` operation occurred.
- The fixed work-tools real-model sentinel plan is
  `docs/plans/local-work-tools-real-model-sentinel.md` at SHA-256
  `feca254c45cc967bd4c9b089c460baba4f7d54a7b5a6cb98ff3914c404bf4e6e`. It plans a fixed
  five-request `write` / `read` / `edit` / `bash` / `submit_json_result` sentinel in a disposable
  workspace. Gate L is complete: direct 12, process 2, topology 1, and full v0 179 tests pass.
  Initial review found P1 1/P2 4; all were fixed, and changed-lines re-review is `GO` with
  Blocker/P1/P2 zero. Gate L used no credential, network, provider, or production task. The
  separately approved Gate S was then executed exactly once at revision `51916c8` and passed:
  model requests, external requests, tool calls, and tool results were all exactly 5; tool order was
  `write` / `read` / `edit` / `bash` / `submit_json_result`; the final workspace state was verified
  and the disposable workspace was removed. Retry, fallback, rerun, and follow-up were zero. Any
  further real-provider attempt remains a separate explicit Human Gate.
- The Zot-first workspace instruction plan at
  `docs/plans/zot-agents-context-discovery.md`, SHA-256
  `ca808291d0c2548f76cd0cd17b790960bd3ffbdb2e848ef325d41ffe7e5e107c`, is implemented.
  Normal `agent:run` discovers only a direct workspace `AGENTS.md` or `AGENTS.MD`, accepts bounded
  regular non-symlink UTF-8 text, and sends it as a first-class system instruction outside the
  transcript on every request. Instructions 8, topology 1, loop 22, transport 13, runtime 11,
  process 13, and the full v0 gate 195 tests pass. Initial review found P2 2 test-evidence gaps;
  both were fixed, and changed-lines re-review is `GO` with Blocker/P1/P2 zero. Global/ancestor
  discovery remains deferred because it would broaden the current workspace read contract. No
  provider, network, credential, production command, dependency/lockfile, or `_refs/` operation
  occurred.
- The Zot-first project-local skills plan at `docs/plans/zot-skills-discovery.md`, SHA-256
  `9a514adce8932e54daca44f54bf401f647c29a77e64b660c4ab955b94343869c`, is implemented.
  Normal `agent:run` discovers bounded startup snapshots from `.zot/skills`, `.claude/skills`, then
  `.agents/skills`, appends only a compact manifest, and conditionally exposes a nonterminal `skill`
  tool. Skills 12, topology 3, runtime 12, process 14, and full v0 gate 213 tests pass. Initial
  review P2 3 and re-review's remaining evidence P2 were fixed; owner final disposition is
  Blocker/P1/P2 zero. No provider, network, credential, production command, dependency/lockfile,
  persistent product state, or `_refs/` operation occurred. TUI, global/home/manual skill
  management, reload, and permission enforcement remain deferred.
- The provider-neutral multi-turn/events prerequisite at
  `docs/plans/zot-provider-neutral-multi-turn-events.md`, SHA-256
  `663a1bd6634e1503978d0af3f24aecc899dd3b3acd64819fbfcd416cd71bdf0e`, is implemented.
  `runAgent` remains the one-shot compatibility wrapper; the new in-memory sequential session owns
  successful-turn transcript commits and emits synchronous completed lifecycle events. Session 14,
  loop 22, runtime 12, process 14, transport 13, and full v0 gate 227 tests pass. Initial review P2
  3 and the re-review's remaining test-evidence P2 were closed by direct regressions; owner final
  disposition is Blocker/P1/P2 zero. TUI, provider streaming, persistence, cancellation, and tool
  confirmation changes remain deferred. No provider, network, credential, production command,
  dependency/lockfile, persistent product state, or `_refs/` operation occurred.
- The Zot-first first TUI plan at `docs/plans/zot-first-tui.md`, SHA-256
  `60ba3fef3b261c754a1b060fa76d2b62086fb4433e179bb285eee97c146f1fd8`, is implemented.
  Explicit real-TTY-only `agent:tui` now provides in-memory multi-turn interaction, completed-event
  rendering, bounded strict UTF-8 input, busy-input discard, main-screen scrollback, and idempotent
  terminal restoration without changing `agent:run`. TUI direct 26, PTY 10, topology 3, and full
  v0 gate 266 tests pass. Initial review P1 1/P2 3 were fixed; the single re-review's remaining
  test-evidence P2 was closed by exact regressions and the owner final gate. Final disposition is
  Blocker/P1/P2 zero. No production TUI/provider/network/credential, dependency/lockfile, `_refs/`,
  commit, push, tag, publish, or release operation occurred.
- The internal Agent Definition runtime-composition increment is implemented at
  `docs/plans/agent-definition-composition-boundary.md`, SHA-256
  `226692cdc46f466460244dd6df655803831c30ecd06dad92a662f398367e6b55`. It introduces one
  pure internal default TypeScript Agent Definition with explicit OpenRouter profile and production
  registry declarations, evaluated once and materialized by the shared runtime without changing CLI
  or TUI behavior. Definition 2, runtime 18, OpenRouter 16, and full v0 277 tests pass. Initial
  review P2 3 evidence gaps were fixed, and the single changed-lines re-review is `GO` with
  Blocker/P1/P2 zero. No provider/network/credential/production command, dependency/lockfile,
  `_refs/`, commit, push, tag, publish, or release operation occurred.
- The built-in Definition selection increment is implemented at
  `docs/plans/builtin-agent-definition-selection.md`, SHA-256
  `10098e02a2d57897f647ad202aecfa9218934f83d215dd8d8ccf211884031e5e`. It adds exact
  compile-time `default` and `planner` definitions, shared startup `--agent` selection for CLI/TUI,
  and a non-sandbox planner capability set of `read`, conditional `skill`, and
  `submit_json_result`, while preserving omitted-selection behavior. Catalog 4, Definition 4,
  runtime 24, runtime process 17, TUI direct 29, TUI process 12, topology 3, and the full v0 gate
  297 tests pass. Initial review P2 2 were fixed, and the single changed-lines re-review is `GO`
  with Blocker/P1/P2 zero. No provider/network/credential/production command,
  dependency/lockfile, `_refs/` operation, commit, push, tag, publish, or release occurred.
- The bounded synchronous planner delegation increment is implemented at
  `docs/plans/bounded-planner-delegation-tool.md`, SHA-256
  `5f8da680dabc7223d6320c5129c0350ed64fe7b0f7d613a4a44a7a9f5d26570d`. It adds one
  nonrecursive `delegate_to_planner` capability to `default`, with one child per accepted parent
  turn and provider-neutral parent 8 / child 8 / aggregate 16 request admission. Child execution
  reuses frozen startup context and the existing read-only planner registry. Delegation 16,
  runtime 35, runtime process 18, TUI direct 30, and the full v0 gate 326 tests pass. Initial
  review P2 3 were fixed, and the single changed-lines re-review is `GO` with Blocker/P1/P2 zero.
  The three consecutive Definition increments were committed together as `e4e3acf`. No
  provider/network/credential/production command, dependency/lockfile, `_refs/` snapshot
  operation, push, tag, publish, or release occurred.
- The fixed planner-delegation real-model sentinel Gate L is implemented at
  `docs/plans/planner-delegation-real-model-sentinel.md`, SHA-256
  `a6e0ccc655411ebb3b2d0700cca6f3ce3f767648e69297423c8361c364a0b07c`. Its dedicated
  guarded child proves the fixed `parent` / `child` / `parent` causal path with parent 2, child 1,
  and aggregate/external 3 requests; the launcher preserves the repo-external credential and
  disposable-workspace boundary. Direct 15, process 2, topology 1, and the full v0 gate 344 tests
  pass. Initial review found P2 5; the single changed-lines re-review closed four and found one
  narrow failure-tuple P2, which exact third-phase regressions and the owner final gate closed.
  Final disposition is Blocker/P1/P2 zero. Gate L used no credential/provider/network/production
  task, dependency/lockfile, `_refs/`, push, tag, publish, or release. The separately approved Gate S
  was then executed exactly once at revision `2d9f149`: it aborted with
  `model_adherence_failure` after 1/3 external requests, before tool dispatch or a second request;
  child count was 1, workspace removal succeeded, and retry/fallback/rerun/follow-up were zero.
  A separately approved diagnostic one-shot reproduced the same sanitized 1/3 failure and proved
  that the model returned the exact sole `delegate_to_planner` call and task. The false negative was
  caused by the sentinel's `exactKeys` checks rejecting OpenRouter-added message metadata
  (`reasoning`, `reasoning_details`, `refusal`) and tool-call `index`. The owner-only temporary raw
  body and all diagnostic instrumentation were removed; the restored direct 15, process 2, and
  topology 1 suites pass. Both attempts are consumed. Any fix or further provider attempt requires
  a new explicit Human Gate. The separately approved local guard fix at
  `docs/plans/planner-delegation-sentinel-response-guard-fix.md`, SHA-256
  `e0da29834e6d474356acdc7dc3c6438df90e0e1d6fb4a746349442adc1e6cd57`, is now implemented.
  It accepts provider metadata through adapter-consistent semantic projection while retaining sole
  delegation, parsed exact task, exact finals, zero final tool calls, call correlation, and 2/1/3
  bounds. Direct 21, process 2, topology 1, and full v0 350 tests pass; independent review is `GO`
  with Blocker/P1/P2 zero. No credential/network/provider/production command or additional real
  attempt occurred during the local gate. The separately approved post-fix one-shot at commit
  `64ad889` then passed the exact causal sentinel: parent 2, child 1, aggregate/external 3,
  delegation call/result 1/1, order `parent` / `child` / `parent`, validated planner final/causal
  order/transcript, workspace verified/removed true, and retry/fallback/rerun/follow-up zero. It was
  not rerun. Any further provider attempt remains a separate explicit Human Gate.
- The provider-neutral cancellation increment is implemented at
  `docs/plans/provider-neutral-cancellation.md`, SHA-256
  `2e7de535ce3979f79b0d46515e076a67e9e76da6654c2cd0788e688e755bdfab`. Every accepted
  session turn owns a fresh signal propagated through parent/planner/model/tools; cancelled drafts
  are not committed, busy TUI Escape returns to the same session after safe settlement, and busy
  Ctrl-C/SIGINT or SIGTERM/SIGHUP exit only after settlement. Cleanup failure poisons the session
  and takes fatal exit precedence. Cancellation 18, work-tools 19, TUI process 15, and full v0 377
  tests pass. Initial review found P1 2/P2 2; the single changed-lines re-review closed the three
  implementation findings and left two evidence P2s, which exact signal-cleanup PTY regression and
  inventory correction closed at the owner final gate. Final disposition is Blocker/P1/P2 zero.
  No provider/network/credential/production command, dependency/lockfile, `_refs/` operation,
  commit, push, tag, publish, or release occurred.
- The provider-neutral persistent session/history increment is implemented at
  `docs/plans/provider-neutral-persistent-session-history.md`, SHA-256
  `cc66f20c1f2100fae867cb3a85867b5af90eb1cd7a6a70d9cc8aafd1b73c00fb`. TUI default autosave,
  `--continue`, exact `--session`, and `--no-session` use repo-external workspace-partitioned
  state with canonical schema-v1 full parent transcripts; `agent:sessions` provides metadata-only
  list and confirmed delete, while `agent:run` remains nonpersistent. Bounds, nonblocking locks,
  synced-temp atomic replacement, durable rollback, current instruction/skill rediscovery, and
  bounded replay are covered by focused offline store, process, TUI, management, and topology
  tests. Focused store/process/TUI/management/topology counts are 12/3/1/2/2; `agent:session` 14,
  context 15, cancellation 18, planner delegation 16, runtime 35/18, TUI 35/15/3, transport 16,
  and loop 22 all pass; full v0 is 417 tests. The changed-lines review closure added exact
  rollback, lstat size, bounded-scan, invalid-date, replay, awaitable-close, root-blankness, and
  launcher-argv regressions. Residual evidence closure added prospective 512-entry allocation
  capacity, first-turn AgentSession rollback-remove poisoning with preserved ghost JSON, and
  real-child immediate TUI empty-exit cleanup regressions; final owner disposition is Blocker/P1/P2 zero.
  No provider/network/credential/production task, dependency/lockfile, `_refs/`, commit, push, tag,
  publish, or release operation occurred.
- The provider-neutral tool-progress increment is implemented at
  `docs/plans/provider-neutral-tool-progress-events.md`, SHA-256
  `192c49fc094a8c6256e639a27e376247aa25779f326a0449a1498827b632e196`. It fixes one
  execution-only `tool_progress` event with accumulated textual snapshots bounded to 8,192 UTF-8
  bytes and 64 accepted updates per call. Only production Bash emits progress; TUI rendering is
  replaceable live state, while final results, transcript, counters, persistence, provider wire,
  and completed scrollback remain unchanged. Initial plan review's sole multibyte-boundary P2 was
  resolved by the exact largest-complete-code-point 4,000-byte per-stream prefix contract and
  within/across-read regressions. Finding closure added busy-TUI cancel-before-redraw and
  await-settlement coverage, delayed Bash capture/cleanup precedence and exact independent bounds,
  plus no-sink, canonical persistence-byte, and clean replay regressions. Final owner closure also
  routes signal-listener redraw failure through guarded crash settlement before restore. Focused
  progress/session/store/work-tools/TUI-direct/TUI-process/topology suites pass 7/15/13/25/40/16/4
  and full v0 passes 439 tests. Check, format, lint, and diff checks pass; the owner final gate
  independently reran TUI 40 and full 439 and closed at Blocker/P1/P2 zero. No provider/network/credential/
  production task, dependency/lockfile, `_refs/`, commit, push, tag, publish, or release operation
  occurred.
- The provider-neutral assistant streaming increment is implemented at
  `docs/plans/provider-neutral-streaming.md`, SHA-256
  `694cb7cc08f0e06b333acf6acc61a1f6992f538730b5d63f9577931bef061732`. It keeps one
  completed `ModelResult` authoritative while normal parent/planner OpenRouter models use bounded
  Chat Completions SSE and the TUI receives live-only accumulated assistant snapshots. `agent:run`
  remains final-only; partial text/tool calls never enter transcript, dispatch, counters, context,
  persistence, or planner envelopes. The initial changed-lines review found Blocker 0/P1 0/P2 4;
  one plan-scoped finding-closure pass added bounded usage-frame validation, gated SSE progress
  failure/cleanup regressions, and delayed multi-chunk controller/PTY evidence. Focused streaming,
  TUI direct, TUI process, and full offline tests now pass 15/15, 44/44, 18/18, and 460/460;
  re-review P1 closure now permits provider-added usage metadata while retaining required counters;
  the narrow final re-review is `GO` with Blocker/P1/P2 zero. `v0:check`, `v0:fmt`, `v0:lint`,
  `git diff --check`, and the owner final `v0:gate` pass; the gate includes full offline 460/460. No
  provider/network/credential/production command, dependency/lockfile, `_refs/` change, push, tag,
  publish, or release occurred. The increment was committed after the final gate.

- The provider-neutral context-management increment is implemented at
  `docs/plans/provider-neutral-context-management.md`, SHA-256
  `46eaf7a396e8add4dbd080414d854a8cbc579ce0999c43738d1b444335916e83`. The pure context view
  estimates stable JSON as UTF-8 bytes, triggers at 65,536 message bytes, and replaces only
  beneficial older tool-result text with the fixed 39-byte marker until 49,152 or candidates are
  exhausted. Full transcripts, event/outcome payloads, cancellation, parent/planner isolation,
  request admission, and provider wire behavior remain unchanged. `AgentSession` exposes a
  committed-only defensive metrics snapshot and the TUI renders it only after settled turns return
  to ready. Focused context 15 and TUI 34 tests pass; full v0 396 tests pass; check, format, lint,
  and diff checks are green. Four initial review P2 evidence gaps and two re-review evidence P2s
  are closed by exact target-stop/49,152 landing, same-session rollback, parent/child
  budget/cancellation and fake-wire-boundary, delayed-TUI, and zero-read rejected/fatal or busy
  exit-intent regressions. Final owner disposition is Blocker/P1/P2 zero. No provider/network/
  credential/production command, dependency/lockfile, `_refs/` operation, commit, push, tag,
  publish, or release occurred.
- The provider-neutral bounded mid-turn steering increment is implemented at
  `docs/plans/provider-neutral-mid-turn-steering.md`, SHA-256
  `021dd5c40db4d2f2412d35a1e3ff079d580782884a51f63c2f56ca202ba3872c`. It permits one
  NUL-free 65,536-byte steering message per active parent turn, consumed only after a complete
  nonterminal tool batch and before an eligible next parent request. Final, terminal, max-step,
  cancellation, and failure discard unconsumed steering; ordinary next-turn queueing remains
  deferred. The additive schema-v1 causal parser retains version/keys/limits/canonical bytes while
  counting completed parent turns rather than raw user messages. Initial plan review's sole P1
  identified the prior persistence incompatibility; the revised narrow re-review is `GO` with
  Blocker/P1/P2 zero. The initial implementation Human Gate is approved; owner/loop/session/store/
  TUI implementation is now present. Focused steering 7, session-store 15, TUI direct 48, TUI
  process 20, TUI topology 4, and full offline v0 test 475 pass; `v0:check`, `v0:fmt`, `v0:lint`,
  and the full `v0:gate` pass. Initial implementation review P2 4 were fixed by exact cancellation,
  output-failure, lifecycle/store/PTY evidence, and rollback guidance; the narrow re-review is `GO`
  with Blocker/P1/P2 zero. The coordinating owner independently reran the final `v0:gate`, including
  475/475 full offline tests. The reviewed increment was committed after the final gate. No provider,
  network, credential, production command, dependency/lockfile, `_refs/`, push, tag, publish, or
  release operation occurred. The increment is commit `3aeb48e`.
- The optional roadmap increment is implemented at
  `docs/plans/bounded-next-turn-queue.md`, SHA-256
  `9a9e5d42a8024a23c2a45a2a62b852f6c0012c378d05d8ec358b8539a6fc1831`. It proposes one
  controller-local, memory-only ordinary follow-up slot for the real-TTY TUI: busy Enter remains
  steering, busy Alt+Enter queues one later ordinary parent turn, and only successful durable
  settlement drains it. Cancellation, failure, exit, EOF, and shutdown drop pending text; the
  automatically started turn cannot refill the slot but retains fresh steering and the existing
  per-turn planner/cancellation/request-budget ownership. The initial plan review's persistence P1
  and xterm-timeout P2 were corrected; the single narrow re-review is `GO` with Blocker/P1/P2 zero.
  The initial implementation Human Gate is approved and the controller/input/renderer, direct,
  persistence, and PTY implementation is present. Focused decoder/render/controller/session-TUI
  suites pass 17/10/41/4; residual evidence adds sub-50-ms split xterm PTY, rejected refill plus
  fresh automatic-turn steering PTY, max-step, persistence-commit, and crash/close regressions.
  The PTY and topology suites pass 25/4 using the repository `agent:tui:process:test` task's
  `/usr/bin/script` permission. Full offline `v0:test` and closure `v0:gate` both pass 503/503,
  with `v0:check`, `v0:fmt`, `v0:lint`, and `git diff --check` green.
  Initial implementation review P2 3 were closed; the narrow re-review left one evidence-only P2,
  and the separately approved residual evidence closure added the exact split-PTY/fresh-steering/
  max-step/persistence-commit/crash-close regressions. Owner final disposition is Blocker/P1/P2 zero.
  Independent owner verification observed two one-off pre-existing PTY process-status failures in
  different cases; isolated repetitions (steering 3, signals 5), the complete PTY suite, and the final
  full 503-test gate all passed, with no source change for the non-reproducing harness observations. No
  provider/network/credential, production command, actual persistent state, dependency/lockfile,
  `_refs/`, push, tag, publish, or release operation occurred for this plan. The reviewed increment
  is commit `8a10be9`.
- The first bounded milestone 100 hardening increment is implemented under
  `docs/plans/milestone-100-offline-gate-integrity.md`, SHA-256
  `78466a3737fd66d01e2a3b1a61e5937f740871cba366469793141701f78fa32a`. It replaces the ambient
  read/write/run/env/net full-suite rerun with 43 exact permission-bounded leaf tasks owning 45
  direct test files, including the central topology test. `v0_test.ts` passes 32/32 under exact
  `/tmp`, extension-source, pinned-Deno, and IPv4-loopback permissions with no environment access.
  The topology contract snapshots exact per-leaf permissions and targets plus exact `v0:check`,
  `v0:fmt`, and `v0:lint` executable/flag/target commands, rejects unsafe shell grammar and
  production/provider/credential reachability, and uses independent outer and inner edges so its
  own omission fails closed. Its mutation table covers duplicate existing permissions and both
  composition cycle shapes. The owner-approved reviewer-GO topology expectation deltas cover eight
  existing topology assertions. Direct `v0:test` passes 505/505 and owner `v0:gate` passes 507/507;
  check, format, lint, and diff checks are green. Initial implementation review found P1 1/P2 3;
  the single approved finding-closure pass added strict maintenance snapshots, restored exact-once
  assertions, and direct permission/cycle/chain mutations. Narrow re-review closed all findings and
  is `GO` with Blocker/P1/P2 zero. The coordinating owner independently reran central topology 2/2
  and full `v0:gate` 507/507; final owner disposition is Blocker/P1/P2 zero. No product source,
  provider/network credential, production command, dependency/lockfile, `_refs/`, push, tag,
  publish, or release operation occurred. The reviewed increment was committed after the final gate.
- Roadmap step 76 is implemented under `docs/plans/agent-definition-resource-identity.md`, SHA-256
  `d27878f34ed90893f371084aa8886d9bd1db31209aaed23502306a1d6560cc42`, with results in
  `docs/plans/agent-definition-resource-identity-results.md`. Built-in `default` and `planner`
  now expose internal canonical model/instruction/skill/tool/subagent identities plus the sole
  data-only `maxSteps` selection parameter. Strict grammar/order, exact topology correlation,
  bidirectional skill-manifest coherence, frozen shape, non-exposure, and pre-materialization
  parent/lazy-child validation are covered. Focused definition/runtime/planner/selection/topology
  suites pass 12/12, 38/38, 16/16, 4/4, and 2/2; direct `v0:test` passes 516/516 and owner
  `v0:gate` passes 518/518, with check, format, lint, and diff check green. Initial plan review P2 4 and narrow re-review are GO with
  Blocker/P1/P2 zero; the implementation review's two evidence-only P2s were closed in the approved
  single closure pass (canonical resolved mutations and direct envelope/parameter shape cases), with
  no production defect. The single narrow re-review is `GO` with Blocker/P1/P2 zero; the owner
  independently reran Definition 12/12 and full `v0:gate` 518/518, so final owner disposition is
  Blocker/P1/P2 zero.
  Step 77 manifest, serialization, versioning, and digest remain out of scope. No provider,
  network, credential, production command, dependency/lockfile, persistent state, `_refs/` change,
  commit, push, tag, publish, or release occurred.
- Roadmap step 77 is implemented in the active tree under `docs/plans/agent-definition-resolved-manifest.md`,
  SHA-256 `9321cbb783844261647c6479757a1a17196eef67ae2771a0ba2bb58151456d3c`. It adds the internal
  immutable schema-v1 manifest with exact compact UTF-8/domain-separated SHA-256 known answers and
  single-sourced Step 76 topology validation. Parent and admitted lazy planner validation precede
  materialization; persistent TUI preparation precedes store list/open/allocate/lock/write, and record
  validation precedes materialization. Focused manifest/definition/runtime/planner/session/store/
  persistent-TUI/TUI-direct/topology suites pass 9/12/46/16/15/15/8/68/2; direct `v0:test` and
  owner `v0:gate` each pass 537/537, with check/fmt/lint/diff check green. Initial implementation
  review found Blocker 0/P1 1/P2 2; one approved closure pass added exact topology, snapshot and
  Definition invariance/shape evidence, runtime causal/failure/nonleakage coverage, and persistent
  artifact/invalid-resume regressions. The sole narrow changed-lines re-review closed all findings and
  returned `GO`, Blocker/P1/P2 zero. The owner independently reran manifest 9/9 and authoritative full
  `v0:gate` 537/537 with diff check green; final owner disposition is Blocker/P1/P2 zero. The reviewed
  increment is recorded by the user-authorized final integration commit. No provider/network/credential/
  production command, dependency/lockfile, actual persistent product state, `_refs/` operation, push,
  tag, publish, or release occurred.
- Roadmap step 78 is implemented in `docs/plans/agent-definition-local-comparison-variant.md`,
  SHA-256 `4d134e26ea4e96fffa43997e085b3d900c1a108a06eb0fb963dc691be919b72d`, with results in
  `docs/plans/agent-definition-local-comparison-variant-results.md`, SHA-256
  `de25f3fbd8d394c34d1861ca28d03fd722165b61609efe445c17d3da4727adde`. It adds exactly one internal
  compile-time variant, `default-max-steps-4`, derived from one evaluation of `default` with
  `maxSteps` as the sole 8→4 axis. Public `BuiltinAgentId`, `--agent`, CLI/TUI and runtime selection
  remain exact `default`/`planner`. Schema-v1 keeps its codec/domain while its finite internal manifest
  ID set gains the variant, bound to default topology and exact maxSteps 4; all six known answers pass.
  Focused comparison/manifest/definition-selection/definition/runtime/runtime-process/TUI/TUI-topology/
  offline-topology suites pass 6/10/4/12/49/18/68/4/2. The approved single closure pass added
  direct-only exactly-once evaluator evidence, the complete mechanical drift matrix, and public
  CLI/TUI/runtime nonleakage evidence. Direct `v0:test` and authoritative `v0:gate` pass 547/547,
  with `v0:check`, `v0:fmt` (115 files), `v0:lint` (112 files), and `git diff --check` green.
  The sole narrow changed-lines re-review confirmed all three initial evidence P2s closed and returned
  `GO`, Blocker/P1/P2 zero. The owner independently reran comparison 6/6, runtime 49/49,
  definition-selection 4/4, topology 2/2, and authoritative full `v0:gate` 547/547; final owner
  disposition is Blocker/P1/P2 zero. The reviewed increment is recorded by the user-authorized final
  integration commit. No provider/network/credential/production command, dependency/lockfile, external
  persistent state, `_refs/` operation, push, tag, publish, or release occurred.
- Roadmap step 79 is planned in
  `docs/plans/agent-definition-replay-envelope-execution-record.md`, SHA-256
  `e5327c39e01adb89569375051705135319b40de525b3c0127f910d6974a4300f`. It fixes an internal
  schema-v1 replay envelope with canonical workspace/model/budget/transcript/manifest inputs and a
  domain-separated full SHA-256 identity, plus a normalized schema-v1 execution record identified by
  deterministic `runOrdinal`. Actual duration remains an observation and is excluded from identity and
  record-sameness rules; token usage and cost remain explicit `unsupported`. The pure recorder is not
  connected to runtime, events, session, persistence, provider, CLI/TUI, or the deferred Step 80 runner.
  Initial planning review found P1 2 in clock-start timing and partial tool-batch correlation; both were
  corrected, and the sole narrow re-review is `GO` with Blocker/P1/P2 zero. Product source, tests, task
  configuration, implementation verification, provider/network/credential/production command,
  dependency/lockfile, `_refs/`, commit, push, tag, publish, and release remain untouched. Initial
  implementation requires a separate Human Gate.

- Roadmap step 79 implementation is present in the active tree with results in
  `docs/plans/agent-definition-replay-envelope-execution-record-results.md`. Pure bounded replay
  values/messages, schema-v1 replay envelopes with fixed workspace/envelope identities, normalized
  execution records, and a poisoned finite-state recorder are implemented without runtime/session/
  provider integration. The focused replay suite passes 13 tests, the Step 77 manifest regression
  passes 10 tests, and offline topology passes 2 tests. Related focused suites pass comparison 6,
  session-store 15, session 15, runtime 49, TUI direct 68, TUI process 25, and topology 4; direct
  `v0:test` and authoritative `v0:gate` each pass 560/560. `v0:check`, `v0:fmt` (120 files),
  `v0:lint` (117 files), and `git diff --check` pass. The approved closure pass fixed initial
  implementation review NO-GO findings P1 3/P2 2. The approved residual closure fixed the sole
  narrow changed-lines re-review residuals (Blocker 0/P1 1/P2 2): all caller-owned primitive
  identities are snapshotted before asynchronous manifest validation, envelope task/path text uses
  the shared strict Unicode contract, fresh recorder evidence reaches terminal/reference/value
  validation branches, and the topology test performs actual four-module source inventory checks.
  No further review pass was performed. The owner independently reran replay 13/13, offline topology
  2/2, manifest 10/10, and authoritative full `v0:gate` 560/560; all residuals are Closed and final
  owner disposition is Blocker/P1/P2 zero. Provider token usage and cost remain explicit `unsupported`
  values. There is no plan delta or unplanned bug. The reviewed increment is recorded by the
  user-authorized final integration commit. No provider/network/credential/production command,
  persistent state, dependency/lockfile, `_refs/`, push, tag, publish, or release operation occurred.

- Roadmap step 80 is implemented locally under `docs/plans/agent-definition-fresh-runtime-comparison.md`,
  SHA-256 `eeb8e9da5116ce34aaeaea045e072d0cbfac1fe88fb65c4ae72b2c2fb2ded414`. It derives separate
  `default` and `default-max-steps-4` replay envelopes from one versioned offline case, executes fresh
  scripted runtimes, correlates normalized records, and renders one bounded plain-text comparison.
  The Step 79 schema remains unchanged; only maxSteps-derived parent/aggregate ceilings differ, while
  planner/external/wall ceilings remain shared. The permission-free focused comparison and loop tests
  pass 12/12 and 26/26, and the topology task passes 2/2. Full focused regressions pass (definition
  12/12, resolved-manifest 10/10, comparison-variant 6/6, replay-record 13/13, runtime 49/49 plus
  process 18/18, TUI 68/68 plus process 25/25 and topology 4/4); direct `v0:test` and `v0:gate`
  each pass 578/578, with `v0:check`, `v0:fmt` (123 files), `v0:lint` (120 files), and diff check
  green. The single re-review left two evidence-only P2s; the approved residual evidence closure
  and final narrow correction added actual second-run failure coverage, delayed partial-second
  injection after recorded second-run model progress, and fail-closed unresolved local imports.
  The owner independently reran comparison 12/12, topology 2/2, and authoritative full gate
  578/578; all findings are Closed and final disposition is Blocker/P1/P2 zero. No provider, network,
  credential, production command, persistence, dependency/lockfile, `_refs/`, commit, push, tag,
  publish, or release operation occurred.

- Roadmap step 81 is implemented locally under `docs/plans/portable-launch-startup-orientation.md`,
  SHA-256 `6000e27210305845032e74f2ccecc04ce1c03b6f6c1e84e30beed673ea251a09`, with results in
  `docs/plans/portable-launch-startup-orientation-results.md`. The normal TUI now has the portable
  `deno task --quiet --config deno.v0.json agent:tui` entry, PATH/exact-Deno-version preflight, and
  an immutable post-manifest startup orientation shared through prepared/materialized runtime
  state. Startup remains credential/fetch/tool-free through input acceptance and request-time
  credential verification is unchanged. Focused startup orientation/portable PTY/runtime/topology
  suites pass 8/8, 2/2, 51/51, and 2/2; the full offline `v0:test` chain and authoritative
  `v0:gate` pass 591/591 (topology 2/2), with check, format, lint, and diff check green. The
  approved implementation-review closure adds four-mode lifecycle/cleanup evidence, complete
  orientation-before-input PTY synchronization, launcher failure/admission sanitization, invalid
  startup effect-zero matrices, and CLI/TUI common-field correlation.
  The single narrow re-review confirmed all four initial P2 findings Closed and returned GO;
  the owner independently reran focused orientation 8/8, portable PTY 2/2, runtime 51/51,
  persistent TUI 9/9, and authoritative `v0:gate` 591/591. Final disposition is Blocker/P1/P2
  zero. The separately approved representative no-task acceptance was consumed once in a disposable
  checkout/state root: all 12 orientation lines rendered, empty Ctrl-D exited 0, terminal controls
  restored, session JSON/per-session lock/temp counts were zero, and the disposable root was removed.
  No retry or rerun occurred. The reviewed Step 81 increment is recorded by the user-authorized
  final integration commit. No provider/network/credential/production command, actual persistent
  product state, dependency/lockfile, `_refs/`, push, tag, publish, or release operation occurred.

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
