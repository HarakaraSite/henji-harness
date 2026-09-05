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

- Current resumption state is maintained in [`.handoff/handoff.md`](.handoff/handoff.md), whose Records contain only the active Worker acceptance, self-revision/first-experience choice, FR5 daily-use assessment, and dormant Spike2/operations transfer reconciliation topics. Preserved old checkpoints remain historical evidence.
- Accepted architecture: [`docs/architecture/henji-host-agent-worker.md`](docs/architecture/henji-host-agent-worker.md). It preserves the Host/Worker direction and adopts an experience-driven proof order after the pending Worker gate; resident Host, Stage 4, permanent I/O placement, and migration remain future scope unless an observed product need requires one.
- Worker foundation implementation and real-provider gate corrections are complete and reviewed provider-free. The separate [`agent-worker-real-provider-human-acceptance.md`](docs/plans/agent-worker-real-provider-human-acceptance.md) execution package is prepared with current official public model/pricing readback and an exact four-request provider-free preflight; its real-provider Human Gate remains unapproved and unexecuted.
- The experience-driven self-revision direction is adopted. It makes the actual-use evidence → revision candidate → normal-use comparison → adoption loop a product axis while leaving each implementation cycle and Human Gate separately scoped. See [`docs/plans/experience-driven-self-revision-proposal.md`](docs/plans/experience-driven-self-revision-proposal.md).
- FR5 integrated UI candidate results and concrete Cycle 1–3 corrections are recorded in [`docs/plans/fr5-integrated-human-ui-candidate-results.md`](docs/plans/fr5-integrated-human-ui-candidate-results.md) and [`docs/plans/fr5-human-observed-ui-correction-results.md`](docs/plans/fr5-human-observed-ui-correction-results.md). Conditional candidate acceptance and concrete human-confirmed corrections do not establish final daily-use adoption; F1 is parked as 工事中.
- Historical implementation and acceptance outcomes remain in their matching [`docs/plans/`](docs/plans/) results and Git history. Archived Spike2 remains dormant unresolved; later Definition/Revision/Admission implementation records have matching results and Git history, while external ownership/transfer remains unconfirmed.
- Existing action boundaries remain: provider/credential access, production `henji`, installed launcher/state, `_refs/`, and commit/push/tag/publish/release operations require the applicable explicit authorization.

## Historical records

- Resumption state and preserved old checkpoints: [`.handoff/handoff.md`](.handoff/handoff.md)
- Former current-phase ledger preserved as historical evidence: [`docs/history/agents-current-phase-through-024071a.md`](docs/history/agents-current-phase-through-024071a.md)
