# Increment 60 — 宣言catalog/defaultsの動的選択への反映

ステータス: **完了**

基準commit: `d231addc`（Increment 58配置。59/60は未commit）

計画日: 2026-09-17

対象: Increment 59で分割した範囲のうち、宣言`modelCatalog`/`defaults`を選択surfaceへ反映する部分。
新しいprovider idの追加はIncrement 60の対象に含めず、将来incrementへ送る（理由は下記）。

## 利用者が必要とする動作

- 宣言`providers/openrouter-responses.json`が、`openrouter-responses`のmodel catalog・既定model/effortを
  上書きし、TUIの`/model`・`/effort`・model picker・起動時既定へ反映される。
- 宣言がある場合、静的catalogのentryが選択surfaceへ漏れない。
- 宣言がない場合は従来のbuilt-in catalog/既定へ戻る。
- provider表示が`openrouter`と`openrouter-responses`を区別する。

## 計画（実装済み）

- `provider_runtime.ts`を追加し、Host起動時と各Worker generationで有効な宣言を設定する。
- `openrouter_model_catalog.ts`の`isOpenRouterResponsesModelSelection`/`selectOpenRouterResponsesModel`、
  `model_catalog.ts`の`defaultModelSelectionFor`/`modelCatalogEntryFor`/`searchModelsFor`を、宣言があれば
  そのcatalog/defaultsを使うようにした。
- `tui_cli.ts`は起動時に宣言をloadしてactive化し、`worker_bootstrap.ts`はstart commandの宣言をactive化する。
- `startup_orientation.ts`の表示providerを`openrouter-responses`として区別する。

## 対象外

- 宣言による**新しいprovider id**の追加（reserved idと、永続`ModelSelection` identityの一般化、Chat Completions
  adapterのprovider-agnostic化、Session/evidence validationの一般化が必要で、architecture判断を伴うため将来increment）。
- 動的model catalog取得、executable provider kind、built-in Completions廃止、OpenAI directのexternal化。

## Verification

- focused test（Increment 14のprovider testへ追加）: 宣言overrideで`defaultModelSelectionFor`が宣言defaultsを返し、
  `searchModelsFor`が宣言entriesのみを返し静的catalogが漏れず、`modelCatalogEntryFor`/`selectModelFor`が宣言entryを
  使うこと。increment-14の12 testはpassed。
- 実機確認: isolated XDG configに`providers/openrouter-responses.json`（catalog=`deepseek/deepseek-v4-pro-0813`、
  defaults=low）を置き、compiled standaloneを`--root-provider openrouter-responses`で起動。footerが
  `provider:openrouter-responses model:deepseek/deepseek-v4-pro-0813 low`を示すことを確認した（provider requestは
  行っていない）。
- 変更対象のtype check、format、lint、`git diff --check`。

## 規模見積り

runtime registry、catalog/selectionのoverride反映、起動配線、表示修正、testで**1〜2開発日相当**。

## 未実施

- authoritative `v0:gate`、commit、build、`dist/henji`/`~/.local/bin/henji`置換。
- 新しいprovider idの追加（将来increment）。
