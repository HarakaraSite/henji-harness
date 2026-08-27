# Provider-neutral persistent session/history results

## Acceptance summary

The approved plan is implemented in the active `v0/` tree. Persistent TUI sessions use a
workspace-digest-partitioned state root, canonical schema-v1 full parent transcripts, nonblocking
index/session locks, bounded scans and file sizes, and synced sibling-temp atomic replacement.
`--continue`, exact `--session`, default autosave, and `--no-session` are wired through the TUI;
`agent:sessions list` and confirmed exact delete are metadata-only management operations.
`agent:run` remains nonpersistent and planner child history is not stored.

The changed-lines review findings were closed narrowly: launcher argv is preserved through the
preparse, non-NotFound first-turn rollback failures poison instead of disappearing, lstat rejects
zero and over-limit files before read, replay passes only the bounded selected suffix, every
indexed operation uses one index-locked 512-entry-per-namespace scan, invalid calendar dates are
fail-closed, empty close cleanup is awaited, and shell/TypeScript root blankness agrees while
retaining legal absolute roots containing shell-safe spaces. The residual evidence findings are
also closed: allocation re-scans after orphan cleanup and rejects a prospective 513th session or
lock entry, a real AgentSession first-turn durable install poisons after injected rollback-remove
failure while preserving the ghost JSON, and a real child-process immediate TUI exit proves the
session directory and per-session lock are absent.

## Evidence mapping

| Requirement | Evidence |
| --- | --- |
| Canonical schema, strict bytes, causal messages, bounds | `v0/agent/session_store.ts`, `tests/v0/agent_session_store_test.ts` |
| State-root precedence and workspace partition | `selectStateRoot`, `workspaceDigest`, store direct tests |
| Nonblocking cross-process locking | `tests/v0/agent_session_process_test.ts`, pinned Deno task |
| Metadata-only list and exact confirmed delete | `v0/agent/session_cli.ts`, `tests/v0/agent_session_cli_test.ts` |
| TUI selector grammar and launcher topology | `v0/agent/tui_cli.ts`, both launchers, topology test |
| Full transcript hydration and bounded replay | `AgentSession` initial record path and renderer replay |
| Durable commit/rollback and lock close | `AgentSession` persistence port and store handle |
| Offline verification | focused tasks, `v0:check`, `v0:fmt`, `v0:lint`, `v0:test`, `v0:gate`, `git diff --check` |

## Verification

The pinned-Deno focused tasks passed with these counts: `agent:session-store:test` 12,
`agent:session:process:test` 3, `agent:session:tui:test` 1, `agent:sessions:test` 2,
`agent:sessions:topology:test` 2, `agent:session:test` 14, `agent:context:test` 15,
`agent:cancellation:test` 18, `agent:planner-delegation:test` 16, `agent:runtime:test` 35,
`agent:runtime:process:test` 18, `agent:tui:test` 35, `agent:tui:process:test` 15,
`agent:tui:topology:test` 3, `agent:transport:test` 16, and `agent:test` 22. The standalone
`v0:test` passed 417/417. The final `v0:gate` passed 417/417 and also completed `v0:check`,
fmt (104 files), and lint (101 files); standalone `v0:check`, `v0:fmt`, `v0:lint`, and
`git diff --check` were green as well. Shell syntax (`sh -n`) passed for both launchers, and the
launcher process matrix passed exact fixed child argv for every selector and flag order. The
earlier topology assertion was updated to the approved launcher task and its focused test passed
3/3.

All tests use disposable `/tmp` roots and leave no `henji-session-*` directory. No provider,
network, credentials, production task mode, dependency/lockfile, `_refs/`, commit, push, tag,
publish, or release activity is part of this increment. Final owner disposition is
Blocker/P1/P2 zero; no stop condition or unplanned bug remains.

## Deviations and risks

No product-scope deviation was authorized. Remaining plan risks are plaintext history and hostile
same-user access, no directory-fsync durability claim, rollback failure indeterminacy, hard 8 MiB
refusal, full-history memory cost, POSIX launcher assumptions, ordinary unlink semantics, and
manual handling of unknown orphan artifacts. Corrupt records are preserved and rejected/skipped;
there is no repair, migration, truncation, pruning, retry, or automatic deletion policy.
