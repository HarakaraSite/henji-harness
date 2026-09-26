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
- 通常実行では、次のprobeを設計できる短いrequest単位のfact（provider、model、API、stepと物理request順、
  HTTP／error、解析失敗の項目と値の形）を保存・readback可能にする。toolの順番・引数・結果とruntime outcomeは
  semantic履歴を正本とし、raw request／response、SSE断片、parser transition全文は常設収集しない。
  詳細なrawが必要な場合は別probeで取得する。credential値とAuthorizationは記録しない。
- 成功基準は、人間がproduction経路で目的の機能を完了できることである。offline fixture、test件数、
  review結果、sanitized failure、機械的gate成功をその代替にしない。
- 利用者から明確な指示がない修正は、後方互換を要求しない破壊的変更として扱う。旧形式のmigration、
  converter、compatibility read、dual-read/write、fallbackを推測で追加しない。この既定はcontractと実装の
  切替方針であり、既存dataやfileを削除する許可は含まない。実データの削除は利用者の明示指示を必要とする。

## Product文書の正本

各文書を一列の優先順位として扱わず、次の担当領域の正本として参照する。

- 構想: [`docs/concepts/experience-driven-self-revision.md`](docs/concepts/experience-driven-self-revision.md)
  はproductの目的、Why、人間による採用境界を定義する。
- architecture: [`docs/architecture/henji-host-agent-worker.md`](docs/architecture/henji-host-agent-worker.md)
  は責務分担、状態所有、component境界、不変条件を定義する。
- roadmap: [`docs/roadmap.md`](docs/roadmap.md)は必要機能、実装状態、未実装範囲を管理する。
- 通常利用メモ: [`docs/experience/normal-use-inbox.md`](docs/experience/normal-use-inbox.md)は、通常利用で
  得た観測と、まだ個別incrementへ採用していない改善候補の正本である。記載だけでは採用または実装を
  意味しない。
- 個別increment: [`docs/increments/`](docs/increments/)の`increment-N.md`は、採用されたincrementの要件、
  対象範囲、計画、結果の正本である。

未採用候補はhandoffではなく通常利用メモへ記録する。個別incrementへ採用した項目は通常利用メモから
該当increment文書へ移し、完了史を未採用候補へ残さない。`.handoff/handoff.md`は現在地、次の一手、正本への
pointer、承認境界だけを保持し、product構想、改善候補、計画、完了履歴の保存先として使わない。

担当領域をまたぐ不整合を見つけた場合は、独自に一方へ寄せず、利用者の目的と明示要件を確認して該当する
正本を更新する。Why・What・Whetherを変える判断は利用者へ戻す。

### Product正本の変更承認

- 構想、architecture、roadmapの正本を修正する前に、変更対象、理由、意味上の変更内容を利用者へ提示し、
  明示的な承認を得る。
- 個別incrementの計画または実装に対する包括的な承認は、構想、architecture、roadmapを変更する承認として
  扱わない。これらの正本変更は、個別incrementの変更とは分けて承認を得る。
- 承認を得るまでは、必要な正本変更案を個別increment文書または利用者への報告に留め、構想、architecture、
  roadmapへ反映しない。

## Planning

- 機能の追加・変更・廃止では、対象ファイルを決める前に、利用者の操作から結果までの現行経路を確認する。
  関係する入口、状態の所有者、データの生成・保存・参照先を追い、変更の影響範囲を決める。
- 新しい状態や処理を増やすときは、既存の責務や経路と重複しないか、現行の利用者がいるかを確認する。
  経路を置き換えたり廃止したりするときは、使われなくなる処理と保存先も同じ変更の対象に含める。
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

## Surface change verification

- TUI Surfaceの変更（通常利用メモのS項目等）は、focused test、type check、format、lintに加えて、tmux上の
  production TUIで実経路を確認してから完了とする。offline testだけでは表示・操作の実経路を保証できず、
  過去にS関連の変更で複数の表示・操作bugを出している。
- tmux確認は隔離XDGで行い、実configへ`default-selection.json`等を書かない。確認した操作と観測は
  該当increment文書へ記録する。
- 実provider callを伴う確認は、対象・回数・保存先を提示して利用者の明示承認を得てから行う。

## 実行環境

- bash toolは実行ごとにprocess環境を継承しない（設定されるのはPATH・LANG・LC_ALLのみ）。`git push`など
  認証やuser設定を要する操作は、command内で`HOME=/home/agent`等の必要envを明示する。env未指定のpushは
  認証promptでhangする。
- git認証は`credential.helper=store`＋`/home/agent/.git-credentials`（0600）で解決する。認証情報の値は
  出力・記録しない。

## Continuation

- Current resumption state is maintained only in [`.handoff/handoff.md`](.handoff/handoff.md). Do not
  duplicate changing project status or next actions in this file.
- Keep product concepts, architecture decisions, roadmaps, implementation plans, and results in their
  respective documents. Use this file for repository-wide working rules and pointers to authorities.

## Historical records

- Resumption state records: [`.handoff/handoff.md`](.handoff/handoff.md)
- Former current-phase ledger preserved as historical evidence: [`docs/history/agents-current-phase-through-024071a.md`](docs/history/agents-current-phase-through-024071a.md)
