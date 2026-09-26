# Increment 85 — recoverable stopの可視化とprovider deadline延長

ステータス: **実装・検証完了（正本更新含む）**

基準commit: `a2a56f52`

計画日: 2026-09-19

実装日: 2026-09-19

## 利用者が必要とする動作

- recoverable（cancelled／max_steps／contract_failure）でturnが終わったとき、editorを勝手に書き換えず、
  停止理由と`/recover`の案内をstatusへ表示する。入力は`/recover`で明示的に取り出す。
- provider requestの既定deadlineを180,000 msにする（従来120,000 ms）。`run`を含む全経路に効く。
- 会話log、canonical transcript、`/history`、Presentation contractは変更しない。

## 根拠

- 利用者報告（2026-09-19）: 何もしていないのに`[recovered input; edit or resubmit]`が出る。調査の結果、
  `b19b5dd2`（2026-09-07）が追加した自動`popRecovery()`（`controller.ts`）が、recoverable stopの理由statusを
  復元メッセージで上書きしていた。元の`d00b5129`（2026-08-31）はeditorを空のまま`ready`にし、Ctrl-Rの
  明示操作で復元していた。
- 同条件の再現（isolated XDG、`openrouter-responses`／`deepseek/deepseek-v4.1-flash`／`high`）で
  `provider deadline exceeded`（120秒）に到達し、高effortのweb調査turnでは既定120秒が短いことを確認。
  利用者指示（2026-09-19）で180,000 msへ変更する。
- 恒久diagnosticの欠如（却下transcriptがdurable eventから縮約される）は別問題として通常利用メモB5に記録済み。

## 実装計画

1. `controller.ts`のsettlementから自動`popRecovery()`を削除し、recoverableではeditorを変更しない。
2. recoverableのstatusを`<reason>; recoverable input available; use /recover`（side-effect警告があれば付記）へ
   統一する。
3. `DEFAULT_PROVIDER_TIMEOUT_MS`を180,000へ変更し、test・roadmap F02・architecture・`v0/agent/README.md`を
   整合させる。
4. focused test（TUIのrecover flow）、`v0:check`／`fmt`／`lint`／`git diff --check`／authoritative `v0:gate`。

## 対象外

- proposal却下理由のdurable diagnostic（B5の別項目）。
- Host runtime tunablesの設定ファイル化（通常利用メモE3、別increment）。
- e2e child deadlineやbash toolの120,000 ms上限（別用途）。

## Human Gate

2026-09-19、利用者は自動復元をやめて明示`/recover`へ戻すこと、およびprovider deadlineを120→180へ変更する
ことを指示した。roadmap F01/F02・architectureの該当記述更新を承認した。

## 結果

- `controller.ts`のsettlementから自動復元を削除した。recoverableではeditorを変更せず、statusへ
  `cancelled; recoverable input available; use /recover`等を表示する。`/recover`でrecovery laneから取り出す。
- `DEFAULT_PROVIDER_TIMEOUT_MS = 180_000`へ変更した。
- roadmap F01/F02・TUI節、architectureのrecoverable/deadline記述、`v0/agent/README.md`、
  `increment_13` testを更新した。通常利用メモB5に由来を追記し、E3（runtime config）を追加した。

## Verification結果

- focused test: `tui_retained_terminal_test.ts`のcancel→`/recover`→resubmit、occupied editorの`/recover`、
  `/recall`との分離がpass。`increment_13` timeout test pass。
- `v0:check`／`fmt`／`lint`／`git diff --check`／authoritative `v0:gate` exit 0。
- 実TTY・compiled binaryは未確認（安定候補で別途）。

## B5の原観測と切り分け（2026-09-19）

通常利用メモの整理（2026-09-26）に伴い、B5の原観測をここへ移した。以下のsource位置、storage制約、
自動復元の動作は2026-09-19時点の記録である。自動復元は本incrementで停止し、recovery laneはIncrement 97で
廃止した。却下transcriptの保存・readbackはIncrement 94で対応済みである。具体的なvalidator不合格理由と
元の却下原因は未解決であり、現在の残件は通常利用メモB5を参照する。

- 観測（2026-09-19、利用者報告）: 特に操作していないのに`[recovered input; edit or resubmit]`が表示される。
- 確認（2026-09-19、DB read-only）: Session `54d65ea7`（workspace `967fa641…`、turn 1、task「denoとnodeを比較したい
  情報をwebで集めて比較表と総評をして」）はexecution `e0e9cf4f`で`outcome=contract_failure`／
  `stop_reason=contract_failure`／`error=commit proposal invalid`。provider request 9回（web_search aux 2回を含む
  7 model steps）、14 messages、約5分41秒。
- 原因: `worker_host_session.ts:1826`の`proposalRecord(message)`が`undefined`（`validateSessionRecordV6`不合格）と
  なり`commit proposal invalid`としてfailed settlement。`controller.ts:1772`のrecoverable判定（`contract_failure`）で
  自動`popRecovery()`が走り、入力がeditorへ戻って当該メッセージが出る。元の理由status
  （`agent failure; recoverable input available`）は直後の復元メッセージで上書きされる。
- 制約: `sqlite_history_store.ts:3745`の`durableEventPayload`が`commit_proposal`を`{kind,correlation,nextTurn}`へ
  縮約保存するため**却下されたtranscriptをDBから直接読めない**。`execution_messages.content_digest`は全行nullで
  transcript本文もjoinできない。exactなvalidator不合格理由は未取得。
- 影響: recoverable stopの理由が見えず、原因不明の自動復元に見える。数分走ったturnの成果がcanonical採用されず、
  入力を再投入する必要がある。
- 対応候補（要判断・未修正）: (a) 同じtaskをisolated XDG＋実providerで再現し却下理由を捕捉する、(b) reject時に
  validator不合格理由をdurable diagnosticへ残す、(c) recoverable statusに元のstop理由を残し上書きしない。
- 再現（2026-09-19、isolated XDG・実provider・`openrouter-responses`／`deepseek/deepseek-v4.1-flash`／`high`、
  `agent:run`）: 同じtaskを実行すると`contract_failure`になったが**別原因**で、`model contract failure: provider
  deadline exceeded`（transport/provider_timeout、modelStep 5、steps=5、tools=8、requests=7、diag
  `2f5b0ee4…`）。`proposalRecord`の不合格dumpは発火せず、**`commit proposal invalid`は再現せず**（model出力依存・
  非決定）。同じrecoverable contract_failureのため入力自動復元は同様に起きる。120秒のrequest deadlineが高effort
  のweb調査turnで到達する点は別の観測。
- 正本候補: `v0/agent/worker/worker_host_session.ts`（commit validation）、`v0/tui/controller.ts`（auto-recovery status）。
- 関連: increment-85（自動復元を停止理由表示へ変更）、increment-97（recovery lane削除で`/recover`を廃止）。
- 由来（2026-09-19、git履歴）: 自動復元は後付け。`d00b5129`（2026-08-31）はeditorを空のまま`ready`にし
  Ctrl-Rの明示操作で復元、`b19b5dd2`（2026-09-07）が`controller.ts`の自動`popRecovery()`を追加、`58d908d1`で
  Ctrl系機能キーを削除し以降は`/recover`が明示操作。理由statusを復元メッセージが上書きするのはこの追加による。
