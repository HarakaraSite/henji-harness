# AGENTS.md

## Product-first development policy

This section is the highest-priority project policy for planning, implementation, testing, review,
diagnostics, and acceptance. It applies to the coordinating agent and every subagent. When another
repository document or prior practice conflicts with it, this section wins.

- Testはproduct機能と人間の利用可能性に従属する。testを通すために機能を狭め、正常な外部service
  responseを拒否し、fixtureを実仕様として扱わない。競合時は実利用経路、実行証拠、公式外部契約を
  先に確認し、誤ったtestを修正または削除する。
- 安全機構は機能が実環境で安定した後に別途扱う。機能安定前に考慮する安全性は、ユーザーが明示した
  API credentialとAuthorizationの露出防止だけである。一般的なhardening、fail-closed拒否、permission・
  入力・状態matrixを、依頼なしに設計、実装、test、reviewへ追加しない。
- 原因特定に必要なrequest、raw response、SSE event、provider metadata、parser transition、tool event、
  runtime outcome、request countは保存・readback可能にする。credential値とAuthorizationは記録しないが、
  仮想的なprivate-data懸念で他の診断証拠を省略またはsanitizationしない。
- 成功基準は、人間がproduction経路で目的の機能を完了できることである。offline fixture、test件数、
  review結果、sanitized failure、機械的gate成功をその代替にしない。

## Planning

- 計画は最初に、利用者が必要とする動作、根拠となる明示要件・実行証拠・公式外部契約、実際のproduct
  経路、未確認事項を定義する。test一覧、test件数、拒否条件、hardeningから計画を組み立てない。
- 各testは、先に定義された具体的なproduct動作または確認済みregressionへ対応させる。対応先と根拠を
  示せないtestは計画しない。test件数は成果の記録であり、目標、上限、完了条件にしない。
- 未観測のprovider variant、仮想的failure、境界値やfilesystem/permission permutationを推測で仕様化しない。
  外部挙動が不明なら公式文書または実行証拠を確認し、それでも不明なら未確認として残す。

## Implementation

- 実装agentは承認されたproduct動作を最短の実経路で成立させる。明示されていない安全機構、permission
  check、入力制限、上限、拒否条件、sanitization、fallback、cleanupを「念のため」に追加しない。
- 実装詳細に不確実性がある場合も、機能を狭める推測を選ばない。公式契約、現行source、実行証拠で
  解消できなければ、変更せずcoordinating ownerへ返す。
- Testは機能実装後、そのproduct動作が実経路で成立することを確認する最小限を追加する。test helperの
  都合をproduction interfaceやparser contractへ逆輸入しない。
- 計画外のproduct bugは、原因、観測証拠、利用者影響、修正案を報告し、勝手に修正しない。

## Review

- 通常reviewは、機能correctness、明示要件、公式外部契約、実利用経路、変更によるregression、具体的な
  test不足を確認する。一般的な安全性reviewは行わない。安全性reviewはユーザーが別途明示した場合だけ、
  指定範囲で実施する。
- Test不足は、変更された具体的product動作が未確認であるsource-to-impactを示せる場合だけfindingにする。
  testがないこと自体、未観測variant、将来の仮想的failure、網羅matrix不足をfindingにしない。
- Findingを採用するには、(1) 明示要件・実行証拠・公式契約の根拠、(2) current sourceから利用者影響までの
  経路、(3) test追加だけではないproduct上のcorrectness問題、の三つを必要とする。一つでも欠ければ
  coordinating ownerは採用しない。
- Evidence gapという独立severityやclosure queueを使わない。必要な機能確認が不足している場合は、どの
  product動作が未確認かを通常のreview本文へ記録し、仮想的case追加で閉じない。

## Verification efficiency

- 実装中は変更箇所のfocused test、必要なtype check、format、lint、`git diff --check`だけを使う。
  `v0:test`と`v0:gate`を途中確認に繰り返し使わない。
- Review前のfull gateは要求しない。reviewerもfull gateを実行しない。
- 承認済み計画が要求する場合、安定候補に対するauthoritative `v0:gate`はcoordinating ownerが一回だけ
  実行する。失敗時はfocused確認で原因を特定し、再実行には具体的理由を必要とする。

## Current work

- FR5 human-observed UI correction Cycles 1 and 2 are implemented under
  `docs/plans/fr5-human-observed-ui-correction.md`; results are in the matching `-results.md`.
  Normal conversation no longer displays request/evidence/readback lines, full read output, or raw
  tool JSON. Tool activity uses one concise entry, assistant streaming settles to `assistant>`, the
  footer advances the real committed turn without duplicate identity, and cursor cell placement is
  corrected for ASCII/Japanese/edit/wrap cases. Direct user use confirmed the concise tool path and
  improved long Japanese input, and exposed main-screen redraw snapshots in terminal scrollback.
  Cycle 2 now enters alternate screen before the first retained frame, restores the original screen
  on exit, and omits editor draft bytes from the normal footer while retaining pending semantics.
  Direct human use confirmed redraw isolation, PageUp/PageDown, Ctrl-L latest, and Ctrl-D original
  screen restoration. It then exposed two concrete defects: U+FF15 fullwidth `５` was counted as
  one display cell, and oldest PageUp jumped latest when startup rows lacked conversation identity.
  Both are locally corrected with fullwidth/halfwidth-specific cell widths and first-conversation
  anchoring. Functional review is GO with Blocker/P1/P2 zero; focused Cycle 1/2 tests 10/10 and
  check/fmt/lint/diff are green. No additional full gate was run. Next is direct user recheck of
  paste/backspace/insertion with `直近５コミットの` and oldest PageUp. F1 remains out of scope and
  Cycle 3 must not start until that feedback is received.
- The fixed output-limit expansion in `docs/plans/fixed-output-limit-expansion.md` is implemented.
  The normal parent/planner profile is now owned under `v0/agent/`, separated from the legacy
  `v0/model.ts` budgeted path, and requests 65,536 completion tokens. Completed answers,
  saved/restored user/assistant text, and TUI entries use 1 MiB; the planner-to-parent JSON envelope
  uses 2 MiB; serialized next-request messages use 5 MiB and the enclosing request 6 MiB; raw SSE
  remains 1 MiB. Pi/Zot are reference information only, with model-specific limits, incremental
  SSE, full-message flow, and token-based compaction deferred. Initial functional review's P1
  (planner result blocked by the former 76 KiB next-request limit) was fixed and narrow re-review is
  GO. Owner `v0:gate` ran once: current 9/9 + provider 9/9, check/fmt/lint green. No provider,
  credential, launcher/state, legacy budget, `_refs/*`, dependency, or commit operation occurred.
- Gate 1 general-agent production acceptance is accepted. The initial execution stopped after the
  PTY driver submitted a multiline prompt at its first newline; its partial turn then reached a
  planner `MAX_TOKENS` / `unsupported_finish_reason` after 5 HTTP-200 requests and did not commit.
  The user explicitly authorized one fresh rerun. It completed three committed turns in session
  `61297b14-c023-4c25-8cc6-f4db61b42e4f`, exactly one planner consultation, the required parent
  file work, exact final files, two clean exits, same-session `--continue`, and Ctrl-T history.
  Rerun requests were 8/4/4 = 16, all HTTP 200, with 28,524 reported tokens and USD 0.028308 cost.
  Full accounting and evidence IDs are in
  `docs/plans/gate-1-general-agent-production-acceptance-results.md`. FR2–FR4 and Gate 1 are
  complete; next is FR5 integrated human UI candidate assessment. Both executions' retained state
  remains; cleanup, additional provider attempts, product/test/launcher changes, `_refs/*`, and
  commit/push/tag/publish/release require separate authorization.
- Baselineはcommit `024071a`。旧`tests/v0/`は
  `/tmp/henji-tests-v0-pre-minimal-reset-20260902`へ復元可能に退避され、current offline suiteは6件。
- Step 83 production retryは一回のprovider requestで
  `response_parse/response_error/data_after_terminal`となった。Turn 2/3、retry、fallback、rerunは未実施。
  raw provider payloadは保存されなかった。FR0/FR1 local implementationは、公式OpenRouter accounting
  frame互換、credential/Authorizationを入力に持たないraw provider evidence、diagnostic相関、read-only
  list/showを追加した。実provider shapeは次の明示Human Gateまで未確認である。
- Canonical planning inputは
  `/tmp/planner-inputs/henji-fr0-fr1-product-baseline-provider-stream-compatibility.md`。計画書は
  `docs/plans/fr0-fr1-product-baseline-provider-stream-compatibility.md`。initial functional reviewのProduct
  P2 2件を局所修正し、single narrow re-reviewはGO、Blocker/P1/P2 0。owner authoritative `v0:gate`は
  一回で成功し、current smoke 6件とfunction-derived provider confirmation 7件、check/fmt/lintがgreen。
  commit `da30077`後のfresh functional reviewでP2 2件を検出し、artifact/link durability分離とaccounting
  frameのsingle terminal transitionへ局所修正。narrow re-reviewはGOで、stable candidate変更を理由に行った
  correction gateも一回で成功した。追加commitは未実施。
- Provider/credential、production `henji`、installed launcher/state、`_refs/*`、commit/push/tag/publish/releaseは
  別の明示許可なしに操作しない。
- 次のHuman Gate計画は`docs/plans/fr1-real-provider-human-acceptance.md`。product-source baseline
  `d6e737a`のinstalled production経路で旧失敗Turn 1だけを一度実行し、実tool完了とprovider evidence
  readbackを確認した。6 requestは全てHTTP 200、tool順`read/write/read/edit/bash`、final、turn commit、
  exact files、single terminal transition、raw evidence readbackが成功し、実費はUSD 0.0055785。Human Gateは
  消費済みで、retry/fallback/追加turnは0。workspace/session/evidenceは保持し、cleanupは未承認。
- Revision 46 D0 auditはDisposition B。計画書は
  `docs/plans/d0-internal-agent-definition-seam.md`、SHA-256
  `b5a578dfc9cbb457793c0b3073099380b803e8c7c70789626765e919f2fe04fe`。採用gapは、Definitionの
  resource一覧とactual Registry presetの二重正本、resolved Definition内のhost object、internal
  identity/topologyの`default | planner`閉包の3件。承認済み実装で3件を閉じ、実Definition capabilityから
  Registry/manifestを導出するdata-only compositionとinternal declared-topology admissionを追加した。
  initial review P1 1件はsynthetic Definitionが実runtime pathを通らない不足で、局所修正後のsingle narrow
  re-reviewはGO。owner authoritative `v0:gate`は一回で成功し、current offline 14/14と
  check/fmt/lint/diffがgreen。結果は`docs/plans/d0-internal-agent-definition-seam-results.md`。
- Revision 47 Gate 1 execution packageは
  `docs/plans/gate-1-general-agent-production-acceptance.md`、SHA-256
  `0919f776a9dd14036163d7f6d5cdba0d33b63322292bb20ef12d3ce6f4c36ecb`。post-D0 installed
  production TUIでFR2〜FR4を一つの3-turn taskとして確認する。parent最大24＋planner最大8＝32
  application requests、公式価格による理論上限USD 1.990656、Human Gate ceiling USD 2.00。
  planning complete、plan integration commitとprovider-free preflight後の本人Human Gate待ち。

## Historical records

- Durable policy and checkpoints: `.handoff/handoff.md`
- The former 714-line current-phase ledger: `docs/history/agents-current-phase-through-024071a.md`
