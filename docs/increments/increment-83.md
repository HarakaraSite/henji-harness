# Increment 83 — streaming中のassistantラベルを完了後の色に揃える

ステータス: **実装・検証完了**

基準commit: `7a33ad8c`

計画日: 2026-09-19

実装日: 2026-09-19

対象: streaming中のassistant entry（label `assistant~`）にも、完了後の`assistant>`と同じassistant toneを
割り当てる。色の注入は既存どおり最終frameのみで、会話log・canonical transcript・Presentation eventは
plain textのままとする。Host-local表示のみの変更である。

## 利用者が必要とする動作

- assistant本文のstreaming中から、`assistant~`ラベルが完了後の`assistant>`と同じ色で表示される。
- 完了時に`assistant>`へ置き換わっても色は変わらない（色が「最後に付く」ように見えない）。
- 会話logの`text`、canonical transcript、Presentation event、`/history`へANSI sequenceを混入しない。

## 根拠

- 利用者観測（2026-09-19）: assistantの色が出力完了後に付くように見える。
- 原因は`conversation_renderer.ts`のtone判定がlabel完全一致`assistant>`のみで、streaming中のlabel
  `assistant~`（`state.ts:452`）が一致しないこと。完了時に`assistant>`へ置換（`state.ts:820`）されるため、
  色が完了時に初めて現れる。
- `redraw()`は`assistant_progress`ごとに実行され（`tui_renderer.ts:327-328`）、各frameでlabel spanへSGRを
  注入するため、toneさえ一致すればstreaming開始の最初のframeから着色される。

## 実装計画

1. `conversation_renderer.ts`のtone判定で、`assistant~`にも`assistant` toneを返す。
2. `tui_conversation_presentation_test.ts`に、streaming entryの`labelTone`が`assistant`で、frameに
   `\x1b[33massistant~\x1b[0m`が出ることを追加検証する。
3. focused test、`v0:check`、`v0:fmt`、`v0:lint`、`git diff --check`、authoritative `v0:gate`を実行する。

## 対象外

- 最終frameでstyleを注入する既存境界の変更。
- Markdownタグ着色・本文レイアウト（Phase B、Increment 84で扱う）。
- 色toneの追加、テーマ設定、Presentation contract・Session schemaの変更。

## Human Gate

2026-09-19、利用者はstreaming label色の是正を求め、その後のPhase B（assistant本文レイアウトと
Markdownタグ着色、`**bold**`はSGR1）を別incrementで進めることを承認した。

## 結果

- `conversation_renderer.ts`のtone判定を`assistant>`または`assistant~`で`assistant`へ揃えた。streaming開始の
  最初の描画から`assistant~`が黄色で表示される。
- focused testを追加し、streaming entryの`labelTone`とframeの`\x1b[33massistant~\x1b[0m`を確認した。

## Verification結果

- focused test: `tui_conversation_presentation_test.ts` 14件pass。既存のplain text境界test（layoutへANSIを
  混入しない）も維持。
- `v0:check`／`v0:fmt`／`v0:lint`／`git diff --check`／authoritative `v0:gate`を実行する。
- live provider、実TTY、compiled binaryは対象外。
