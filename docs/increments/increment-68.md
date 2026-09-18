# Increment 68 — provider id整列とbuilt-in id移行

ステータス: **完了**

基準commit: `0d088f6a`

計画日: 2026-09-18

対象: provider idの命名を`{vendor}-{route}`へ揃える破壊的変更。roadmap Provider外部化の予定「built-in id削除と
Session影響の処理、既定解決不能時の入力ブロック」をこのincrementへ統合する。

## 利用者が必要とする動作

- picker/CLI/config上のprovider idが一貫する: `openrouter-chat`、`openrouter-responses`、`openai-chat`、
  `openai-responses`。
- 各idが正しいprotocol/adapter/endpoint/credentialへ解決される。
- `openai-chat`（OpenAI互換Chat Completions）がpickerから選べ、実providerでturnを完了できる。
- 旧id（`openrouter`、`openai`）を含む保存済みSession/evidence/default-selectionは黙って再解釈・変換せず、
  解決不能として明示される。TUIはクラッシュせず、人間が選び直せる。

## 計画

### idと接続

- built-in provider **id** を次へ変更する。
  - `openrouter` → `openrouter-chat`（protocol `openai-chat-completions`、endpoint `https://openrouter.ai/api/v1`、
    adapterは現行OpenRouter chat経路）
  - `openai` → `openai-responses`（protocol `openai-responses`、endpoint `https://api.openai.com/v1`、
    adapterは現行Responses経路）
  - `openrouter-responses` は据え置き。
  - `openai-chat` を追加（protocol `openai-chat-completions`、endpoint `https://api.openai.com/v1`、
    authProfile `openai-api-key`、OpenAI model catalog）。
- protocol enum（`openai-chat-completions`／`openai-responses`）とauthProfile id（`openrouter-api-key`／
  `openai-api-key`）は据え置き。endpoint由来のadapter分岐とcatalog/default解決を新idへ更新する。
- `provider-defaults.json`の宣言id、`roleDefaults`の`providerId`、`BUILTIN_PROVIDER_IDS`、`PROVIDERS`、
  `defaultModelSelectionFor`／`selectModelFor`／`isStoredModelSelection`／`isModelSelection`、built-in Definitionの
  基底model provider、`--root-provider`とpickerを新idへ更新する。

### Session・evidence・configの扱い

- 永続化済みのmodel selection provider idは変換・migrationしない。`openrouter`／`openai`は未知providerとして扱う。
- Session reopen/resumeで保存済みselectionが解決不能な場合は、typed failureとして明示し、黙って既定へ
  fallbackしない。
- `default-selection.json`が解決不能な場合は、無効なHost preferenceとして扱い、既定へfallbackする（新規Sessionは
  default解決から開始できる）。この差はincrement本文に記録する。
- TUIは解決不能時にクラッシュせず、failure statusを表示する。既定解決不能時の入力を明示的にブロックする挙動は
  本incrementの対象外とし、後続で扱う。

## 対象外

- protocol enumやauthProfile idの短縮、provider declaration形式・credential registryの変更。
- 既定解決不能時の入力ブロックUI、旧Sessionのmigration/dual-read。
- web-search subagent化（Increment 69）、tool same-identity override（Increment 70）。

## Verification

- focused test: 新旧idの集合、pickerが4 idを提示すること、各idのselectionがprotocol/catalogと一致すること、
  `openai-chat`のrequestがOpenAI互換Chat Completions endpointへ送られること、旧idのselectionが
  `isModelSelection`で拒否されること。
- 回帰: provider switching/model switching、Session resume、provider evidence、CLI引数、Responses/Chat両adapter。
- 実provider probe: `openai-chat`（OpenAI credentialがある場合）と`openrouter-chat`の1 turn。credentialが無い
  providerは対象外として記録する。
- type check、format、lint、`git diff --check`、authoritative `v0:gate`は安定候補で1回。

## Human Gate

実装前に、利用者は次を確認・承認する。

1. idは`openrouter-chat`／`openrouter-responses`／`openai-chat`／`openai-responses`とし、`openrouter`／`openai`は
   互換aliasなしで削除する。
2. `openai-chat`を同梱declarationとして追加し、OpenAI model catalogを`openai-chat-completions` protocolで使う。
3. 旧idを含む保存済みSession/evidenceは解決不能として明示し、自動migration・fallbackしない。
   `default-selection.json`の解決不能は無効preferenceとして既定へfallbackする。
4. protocol enumとauthProfile idは据え置く。
5. `openai-chat`の実provider probeに必要なOpenAI credentialの利用可否を、実行直前に確認する。

## 結果

- id変更: built-in provider idを`openrouter-chat`／`openrouter-responses`／`openai-chat`／`openai-responses`へ。
  `openrouter`／`openai`は互換aliasなしで削除。`openai-chat`を同梱declaration（protocol
  `openai-chat-completions`、endpoint api.openai.com）として追加。protocol enumとauthProfile idは据え置き。
- 解決: `BUILTIN_PROVIDER_IDS`／catalog／selection／default解決／adapter分岐／provider-defaults.json／
  roleDefaults／built-in Definition model provider／resource identity／CLI／pickerを新idへ。`openai-chat`は
  active declarationsが無い場合もbundled declarationへfallbackして解決する。
- Session/evidence: 旧idは未知providerとして扱い、変更・migrationしない。旧providerState/evidence provider
  （'openrouter'→'openrouter-chat'）も同様に破壊的変更。
- 検証: `increment_14`にid集合・旧id拒否・`openai-chat`のrequest URL（api.openai.com/v1/chat/completions）
  のfocused testを追加。`v0:gate`（check/fmt/lint/test）exit 0。
- 実provider probe（利用者許可）: isolated XDGで`openrouter-chat`（deepseek/deepseek-v4.1-flash/high）と
  `openai-chat`（gpt-5.6-sol/none）の1 turnが成功（`INC68_PROBE_OK`）。
- `openai-chat`の制約（probeで観測）: OpenAI Chat Completionsはfunction tools併用時に`reasoning_effort`が
  `none`以外だとHTTP 400（"Function tools with reasoning_effort are not supported ... use /v1/responses or set
  reasoning_effort to 'none'"）。agentは常にtoolsを渡すため、`openai-chat`のgpt-5.6-sol/luna/terraは
  `defaultEffort`を`none`にした。gpt-6-astraは`none`を持たず`openai-chat`ではtool turnに使えない（未解決の
  フォローアップ候補）。
- 既知の帰結（利用者判断C）: Increment 68のproviderState/evidence provider改名により、旧`providerState.provider:
  'openrouter'`を持つ既存provider evidence行はvalidatorで不正となり、`providerEvidence.list()`が
  `provider_evidence_invalid`を投げる。互換read（案A）やskip（案B）は採用せず、**旧state DBを切捨てる**方針を
  利用者が選択。repository workspace（`/home/masat.guest/src/henji-harness`）のstate root
  `~/.local/state/henji-harness/v1/967fa641…`を削除し、次回起動から新規historyを開始する。他workspaceのstate DBは
  残しており、旧chat evidenceを含む場合は同様にlist readbackが失敗するため、必要時に同様の切捨てを行う。
- binary配置: 実装commit`fb066aa4`から`henji:compile`。binary SHA-256
  `e5a97e963d2f9ebdf4bfb6f1778d01bace0acda3ab88aaa87804c6c9ceba31a7`、build
  `cb0ced4cde802f05ae2e6a7776c2ce93e2d3577f95ace3db8a7a3a2d18a9a454`、embedded runtime
  `c665e31aaeb352670278af8ebe359e35c415ba14a47ded2d58ac1e9b5c7f052`、`sourceDirty=false`。installed launcher
  `~/.local/bin/henji`で、isolated `default-selection.json`に`openrouter-chat`および`openai-chat`を置いた
  `henji run`が`INC68_BIN_OK`を出力。
