# Increment 67 — Responses APIの`auto` effort修正

ステータス: **完了**

基準commit: `236e6f38`

計画日: 2026-09-18

対象: 通常利用で発見した不具合修正。`openrouter-responses`（および宣言Responses provider）で、catalog上
`auto`を既定effortとするモデルを選ぶとprovider requestがHTTP 400で失敗する問題を修正する。provider identity
一般化以降の既存バグで、Increment 65/66とは無関係。

## 原因

`v0/agent/provider/openai_responses_model.ts`がResponses APIリクエストへ常に
`reasoning: { effort: selection.effort }`を送っていた。OpenRouter Responses APIは`reasoning.effort`として
`max|xhigh|high|medium|low|minimal|none`のみ受理し、`auto`を拒否する。Henjiのcatalogは`qwen/qwen3.8-flash`等で
`auto`を既定effortとして持つため、その選択で全turnがHTTP 400になる。Chat Completions経路は`auto`時に
`reasoning_effort`を省略しており、Responses経路だけ非対称だった。

観測証拠（session `8ec44778`、execution `3af6c21a`、state DB read-only）:

- diagnostic: `stage:"http", code:"http_error", httpStatus:400`、`POST https://openrouter.ai/api/v1/responses`。
- response body:
  `{"error":{"code":"invalid_prompt",...},"metadata":{"raw":"[{\"code\":\"invalid_value\",...,\"path\":[\"reasoning\",\"effort\"],\"message\":\"Invalid option: expected one of \\\"max\\\"|\\\"xhigh\\\"|\\\"high\\\"|\\\"medium\\\"|\\\"low\\\"|\\\"minimal\\\"|\\\"none\\\"\"}]"}}`
- request bodyに`reasoning`が含まれる（effort `auto`）。

## 利用者が必要とする動作

- `openrouter-responses`（および宣言Responses provider）でeffort `auto`のモデルを選んでもturnが成功する。
- 明示effort（`high`等）は従来どおり`reasoning.effort`として送られる。

## 計画

- `openai_responses_model.ts`で`selection.effort === 'auto'`のとき`reasoning`フィールドを省略する（provider既定に
  委ねる）。`include: ['reasoning.encrypted_content']`はreasoningと独立なため維持する。
- focused test: Responses経路で`auto`は`reasoning`を送らないこと、明示effortは送ることを確認。

## 対象外

- Responses APIの他のパラメータやcatalogのeffort値域。
- provider picker UI、Increment 65/66の修正、Increment 68以降の予定機能。

## Verification

- focused test: `auto`選択のResponses request bodyに`reasoning`が無いこと、明示`high`では
  `reasoning: { effort: 'high' }`が送られること。
- 既存回帰: Responses/provider switchingの既存test。
- 実provider probe: isolated環境で`openrouter-responses`/`qwen/qwen3.8-flash`/`auto`の1 turn。
- type check、format、lint、`git diff --check`、authoritative `v0:gate`は安定候補で1回。

## 結果

- 修正: `openai_responses_model.ts`でeffort `auto`時に`reasoning`を省略。明示effortは従来どおり。
- 検証: `increment_14_multi_provider_test.ts`のIncrement 67 testがpass。authoritative `v0:gate` exit 0。
- 実provider probe（利用者許可）: isolated XDGで`openrouter-responses`/`qwen/qwen3.8-flash`/`auto`を
  `initialModelSelection`に指定し、production physicalI/Oで1 turn実行。`ok:true`、`finalText`は指定どおり
  `RESPONSES_AUTO_PROBE_OK`。HTTP 400は再発しなかった。
- binary配置: 実装commit`fd616c79`から`henji:compile`。binary SHA-256
  `4e0bc0acf6874b898f4b46a195c07d22c3303757bb28c2094e5e963d21e77fa6`、build
  `4759ce1e842b9d6ea1abe065ec103fce67990daebfe1dc6aed8e4afaaf39041c`、embedded runtime
  `3df03fb074c7699f06c2e9d7f428fdd8aa04c81f2d5730b3a792fcd74ff55170`、`sourceDirty=false`。installed launcher
  `~/.local/bin/henji`で、isolated `default-selection.json`に同selectionを置いた`henji run`が
  `RESPONSES_AUTO_PROBE_OK`を出力しexit 0。
