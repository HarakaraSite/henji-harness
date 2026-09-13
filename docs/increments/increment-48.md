# Increment 48 — Sole slash command completion

ステータス: **完了（2026-09-13）**

基準commit: `a8857912`

対象機能: F01、F10

## 利用者が必要とする動作

- editor全体がbuilt-in slash commandのprefixで、候補がちょうど1件のとき、Tabで完全なcommand名へ補完する。
- 候補が複数あるslash inputでは入力を変更しない。
- 通常のworkspace-relative path completionは従来どおりTabで利用できる。

## 根拠と確認済み状態

- production retained TUIは入力に一致するbuilt-in slash command候補を表示するが、Tabは常にpath completionへ渡す。
- `slashCommandCandidates()`はcase-sensitiveなraw prefixから候補を一意に決定できる。
- 利用者はS1の最小完成として、一意候補の確定だけを採用した。

## 承認済み実装範囲

1. slash inputのTabで候補を評価し、1件だけならeditor全体を完全なcommand名へ置換する。
2. 複数候補または候補なしのslash inputはeditorを変更しない。
3. slash input以外は既存path completionへ渡す。
4. 一意候補、複数候補、通常path completionをproduction retained controllerのfocused testで確認する。

## 対象外

- 候補selector、候補間cycle、部分共通prefixへの補完
- command argument、Session ID、provider/model/effort値の補完
- slash command catalog、keymap、path completion規則の変更
- architecture、roadmap、構想の変更

## Verification

- TUI retained terminal testでTab入力からeditor/candidate状態まで確認する。
- `v0:check`、`v0:fmt`、`v0:lint`、`git diff --check`はIncrement 46〜48の安定候補でまとめて実行する。

## 実装結果

- Tab入力時、editorが`/`始まりなら現在のraw prefixから候補を評価し、1件だけのときeditor全体を完全な
  command名へ置換する。複数候補または候補なしでは入力を変更せず、slash以外は既存path completionへ渡す。
- production retained controllerで、`/n`から`/new`への補完、複数候補の`/h`が不変であること、通常pathが
  quoted workspace-relative pathへ補完されることを確認した。TUI retained terminal suite全32件が成功した。
- candidate selector/cycle、共通prefix、command argument補完は追加していない。static check一式はIncrement 46の
  実装結果に記録した。
- 利用者の別途明示承認により、`docs/roadmap.md`のF01とproduction TUI実装一覧を、一意候補のTab補完がある
  現在の実装状態へ更新した。architecture、将来要件、対象外だった補完機能は変更していない。
