# Increment 66 — provider pickerのprovider検証修正

ステータス: **完了**

基準commit: `3af5a439`

計画日: 2026-09-18

対象: 通常利用で発見した不具合修正。`/provider`（および`/model`）でpickerが提示するproviderを選ぶと
TUIが致命的`output_failure`で終了する問題を修正する。Increment 65の回帰ではなく、provider identity一般化
（Increment 58/61/63）で`openrouter-responses`と宣言providerが選択肢へ入った時点から到達可能だった既存バグ。

## 原因

`v0/presentation/contract_intent.ts`の`presentationIntent`が、`select_provider`／`select_model`のproviderを
`'openrouter'`または`'openai'`の2値にハードコードして検証していた（2026-09-09導入）。一方
`providerIdsForSelection()`は`openrouter-responses`（および宣言provider）も返すため、pickerに出た
`openrouter-responses`を選ぶと`presentationIntent`が`PresentationDeliveryError`を投げ、controllerが
`output_failure`としてプロセスを終了していた。

観測証拠:

- source TUI（pty）で`/provider`→`openrouter-responses`選択→footerが更新されず
  `{"ok":false,"error":{"code":"output_failure"}}`、exit 1。同操作で`openai`はfooter更新・exit 0。
- Host直接API（`session.selectModel(defaultModelSelectionFor('openrouter-responses'))`）は`selected`で成功。
- instrument時のstack: `PresentationDeliveryError: agent event delivery failed` at `presentationIntent` →
  `TuiPresentationAdapter.dispatch` → `ControllerOverlay.applySelection` → `Controller.fail`。

## 利用者が必要とする動作

- pickerが提示したprovider（`openrouter-responses`および宣言providerを含む）を選ぶと、セッションが切替わり
  footerへ反映される。
- catalogに存在しないproviderをSurfaceが要求した場合は、致命的終了ではなく`rejected`として扱う。

## 計画

- `presentationIntent`のprovider検証を、2値allowlistではなく構造的検証（`boundedPresentationText`）へ変更する。
  catalog所属の検証はadapter/controller側のprovider解決に委ね、provider名の値域をpresentation contractへ
  持ち込まない。
- `select_provider`のprovider解決（`defaultModelSelectionFor`）が投げる未知providerを、既存の`select_model`と
  同様に`{ kind: 'rejected', reason: 'invalid' }`へ変換する（`tui_presentation_adapter.ts`と`tui/controller.ts`の
  両経路）。

## 対象外

- provider picker/model picker/effort pickerのUI、宣言providerの追加機能そのもの。
- Increment 65のslot binding、Increment 67以降の予定機能。

## Verification

- focused test: `presentationIntent`が`openrouter-responses`と宣言相当のprovider idを受け付けること、
  adapter経由で`openrouter-responses`への切替が`model_selection`を返すこと、未知providerが`rejected`に
  なること。
- 既存回帰: provider switching/model switchingの既存test、TUI overlay test。
- ptyによる手動確認: `/provider`→`openrouter-responses`でfooterが更新され終了コード0。
- type check、format、lint、`git diff --check`、authoritative `v0:gate`は安定候補で1回。

## 結果

- 修正: `presentationIntent`のprovider検証を構造的検証へ変更。`select_provider`のprovider解決失敗を
  `{ kind: 'rejected', reason: 'invalid' }`へ変換（`tui_presentation_adapter.ts`、`tui/controller.ts`）。
- 検証: 新規`tests/v0/increment_66_provider_picker_test.ts`（3件、`v0:test`へ追加）がpass。pty手動確認で
  `/provider`→`openrouter-responses`がfooter `provider:openrouter-responses`へ反映されexit 0。authoritative
  `v0:gate`（check/fmt/lint/test）exit 0。
- binary配置: 実装commit`29c900d8`から`henji:compile`。binary SHA-256
  `cf3abe3e0e9c4e267659329278d85e31cfa6409bf73450ddfcd5595e9e749c12`、build
  `9bcc9f2bd9992f6fba02c8e9449d1c0645c5ef8dec9edadfce66462abc687c28`、`sourceDirty=false`。installed
  launcher `~/.local/bin/henji`で`/provider`→`openrouter-responses`のfooter反映とexit 0を確認。
