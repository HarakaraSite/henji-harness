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

## 実装・検証結果（確定）

- authoritative `v0:gate`は2026-09-17に実行し、初回はIncrement 33のTUI起動順testで回帰を検出した。
  `tuiMain`が注入session factoryでも宣言読込を行っていたためで、注入時かつconfigRoot未指定では読み込まないよう
  修正した。修正後の再実行で全check/fmt/lint/testが成功した（再実行の理由は回帰修正）。
- 利用者の明示指示により、Increment 59/60の実装をcommit `871cfb6c`へ確定した。そのclean commitからbuild
  `7e2ee3d5a6cd30ebd1f4b91159b77ca02a71dca5637c60b2e287948cfbd91102`を生成し、`dist/henji`と
  `~/.local/bin/henji`を同一artifactへatomic置換した。両方のSHA-256は
  `c259eb397ca07e105eeb68fa6370a6090e2465169c7e8be8b94e0bd949865b43`で、導入版はsource
  `871cfb6ce4a50855113b93a4521e1929ee139de2`、`sourceDirty=false`を返した。tag、release、publishは行っていない。
- 新しいprovider idの追加は将来increment。
