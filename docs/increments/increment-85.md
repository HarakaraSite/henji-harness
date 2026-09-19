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
