# Increment 66 — provider切替UIの修正

ステータス: **完了**

基準commit: `3af5a439`

計画日: 2026-09-18

対象: 通常利用で発見した不具合修正（2件）。`/provider`（および`/model`）でpickerが提示するproviderを選ぶと
TUIが致命的`output_failure`で終了する問題と、provider/model選択の確認がfooter 1行目に残り続ける問題を修正する。
いずれもIncrement 65の回帰ではなく既存バグ。

## 原因

不具合1（致命的終了）: `v0/presentation/contract_intent.ts`の`presentationIntent`が、`select_provider`／
`select_model`のproviderを`'openrouter'`または`'openai'`の2値にハードコードして検証していた（2026-09-09導入）。
一方`providerIdsForSelection()`は`openrouter-responses`（および宣言provider）も返すため、pickerに出た
`openrouter-responses`を選ぶと`presentationIntent`が`PresentationDeliveryError`を投げ、controllerが
`output_failure`としてプロセスを終了していた。

観測証拠:

- source TUI（pty）で`/provider`→`openrouter-responses`選択→footerが更新されず
  `{"ok":false,"error":{"code":"output_failure"}}`、exit 1。同操作で`openai`はfooter更新・exit 0。
- Host直接API（`session.selectModel(defaultModelSelectionFor('openrouter-responses'))`）は`selected`で成功。
- instrument時のstack: `PresentationDeliveryError: agent event delivery failed` at `presentationIntent` →
  `TuiPresentationAdapter.dispatch` → `ControllerOverlay.applySelection` → `Controller.fail`。

不具合2（確認statusの残留）: 選択成功時に`ControllerOverlay.applySelection`が
`renderer.setStatus("provider X · model Y · effort Z")`を設定し、その後`ready`へ戻す処理が無い
（`v0/tui/controller_overlay.ts:413-418`、2026-09-10導入）。入力時の`refreshSlashCommandCandidates`は候補のみ
更新するため、footer 1行目は選択確認が主表示のまま残り、editorが`/`で始まると
`provider ... │ cmds: ... │ model ... │ effort ...`となり、roadmap F01の「cmdsを`ready`または`busy`の直後へ
表示」から外れる。

## 利用者が必要とする動作

- pickerが提示したprovider（`openrouter-responses`および宣言providerを含む）を選ぶと、セッションが切替わり
  footerへ反映される。
- catalogに存在しないproviderをSurfaceが要求した場合は、致命的終了ではなく`rejected`として扱う。
- provider/model切替の確認は次回のeditor入力で`ready`へ戻り、`/`入力時は`ready │ cmds: ...`となる。

## 計画

- `presentationIntent`のprovider検証を、2値allowlistではなく構造的検証（`boundedPresentationText`）へ変更する。
  catalog所属の検証はadapter/controller側のprovider解決に委ね、provider名の値域をpresentation contractへ
  持ち込まない。
- `select_provider`のprovider解決（`defaultModelSelectionFor`）が投げる未知providerを、既存の`select_model`と
  同様に`{ kind: 'rejected', reason: 'invalid' }`へ変換する（`tui_presentation_adapter.ts`と`tui/controller.ts`の
  両経路）。
- provider/model選択の確認statusを一時表示とし、次回のeditor入力時に`readyStatus()`へ戻す。turn開始時はnoticeを
  破棄し、busy中のsteering入力では変更しない。

## 対象外

- provider picker/model picker/effort pickerのUI、宣言providerの追加機能そのもの。
- Increment 65のslot binding、Increment 67以降の予定機能。

## Verification

- focused test: `presentationIntent`が`openrouter-responses`と宣言相当のprovider idを受け付けること、
  adapter経由で`openrouter-responses`への切替が`model_selection`を返すこと、未知providerが`rejected`に
  なること。provider選択確認が次回editor入力で`ready`へ戻ること。
- 既存回帰: provider switching/model switchingの既存test、TUI overlay test。
- ptyによる手動確認: `/provider`→`openrouter-responses`でfooterが更新され終了コード0。切替後`/`入力で
  footer 1行目が`ready │ cmds: ...`になること。
- type check、format、lint、`git diff --check`、authoritative `v0:gate`は安定候補で1回。

## 結果

- 不具合1の修正: `presentationIntent`のprovider検証を構造的検証へ変更。`select_provider`のprovider解決失敗を
  `{ kind: 'rejected', reason: 'invalid' }`へ変換（`tui_presentation_adapter.ts`、`tui/controller.ts`）。
- 不具合2の修正（利用者選択A）: `ControllerOverlay`が選択確認を適用したことをcontrollerへ通知し、controllerは
  次回のeditor入力時に（idle時のみ）`readyStatus()`へ戻す。turn開始時にnoticeを破棄。
- 検証: 新規`tests/v0/increment_66_provider_picker_test.ts`（3件、`v0:test`へ追加）と
  `tui_retained_terminal_test.ts`のprovider選択確認クリアtestがpass。pty手動確認で`/provider`→
  `openrouter-responses`がfooter `provider:openrouter-responses`へ反映されexit 0。authoritative `v0:gate`
  （check/fmt/lint/test）exit 0。
- binary配置: 最終実装commit`5536a893`から`henji:compile`。binary SHA-256
  `fc584309e620d91ecede7d2f48de0cf444d9a8f648fb04b2844f921ccb48d24b`、build
  `d5a5083cd84d5d3d7545fa07ec141800653e5bbf205d3b11285c258d92d363c2`、embedded runtime
  `8bbba492daa19e95ad852d9839b8f585fc900333ff1ee90061d93d7df2a9b520`、`sourceDirty=false`。installed
  launcher `~/.local/bin/henji`（実行中プロセスのためrenameで差替え）で`/provider`→`openrouter-responses`の
  footer反映、切替後`/`入力でfooter 1行目が`ready │ cmds: ...`になることを確認。
