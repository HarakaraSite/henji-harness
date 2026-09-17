# Handoff

## Records

### Increment 51〜62 — instruction CLI、OpenRouter Responses、provider宣言・一般化、Responses replay

- 状態: Increment 62は完了・配置済み。Responses replay stateを`ResponsesProviderState
  { provider: string; replayItems; model? }`へ一般化し、生成元provider＋modelと一致するときだけreplayItemsを
  戻す（不一致はtranscript再構成）。`response.output_item.done`のreasoning `encrypted_content`を
  `response.completed`へ補完する。宣言providerも自身のproviderIdでreplay stateを持つ。既存
  `{provider:'openai'}`はそのまま有効でSQLiteスキーマ変更なし。実装commit `5218618a`。clean commitからbuild
  `a126aecc0586ae1966b56d3a78cc5e72b6258104777743d3675950b20359f1d9`を生成し、`dist/henji`と
  `~/.local/bin/henji`をatomic置換（両方SHA-256
  `3558c8a17c8dc714c10ce2784593c5bb42b00dddb8aa96d53df6af9b592d3eca`、source
  `5218618a02daec03444a3480350a487f720ac728`、`sourceDirty=false`）。authoritative `v0:gate`通過。実provider probeで
  built-in `openai`（gpt-5.6-sol）と宣言`openai-alt`（gpt-5.6-terra）のtool turnを実行し、**2番目のmodel
  requestにprovider item id（`rs_`/`fc_`/`msg_`）が入る**（replayされた）ことをSQLite readbackで確認した。
  前段: Increment 61（宣言provider一般化、`6a34bf07`／`4ef3d59b`、`openai-alt`実probe）、Increment 59/60
  （provider宣言、endpoint/catalog override、`871cfb6c`／`e1814528`）、Increment 58（OpenRouter Responses、
  `4d21a9ea`／`d231addc`）、Increment 57（`25325498`／`5fc5b962`）、Increment 56（`d71c026f`／`7cb653d7`）、
  Increment 55（`2e8ce3da`／`48eb4cd6`）、Increment 54（`40ce44a9`／`bbb82615`）、Increment 53
  （`a8ac6a85`／`ee3dbdf3`）、Increment 52（`1ee500ab`／`56276f49`）、Increment 51（`e709b100`／`0afad72c`）。
  architecture（`multi-provider-routing-and-auth.md`、`henji-host-agent-worker.md`）とroadmapはprovider一般化を
  反映済み。
  未実施: tag、Forgejo Release、JSR publish（JSR latestは0.1.3）。
- 次: `openai-chat-completions`の新provider id（Chat Completions adapterのprovider-agnostic化）は未着手の後続。
  built-in `openai`/`openrouter`定義の削除は、この一般化とdefault/planner/Sonarのprovider sourcing設計が必要。
  他候補はS2、S4、S5、A1、A2、A3、A5、A6、A7、R1〜R4。
- 正本: `docs/increments/increment-51.md`〜`increment-62.md`、`docs/experience/normal-use-inbox.md`。
- 注意: active external revisionは`local/henji-base@sha256:82d67dd2…`。同じresource IDには旧
  `2e00f40b…`もinactiveで残っている。宣言providerは`$XDG_CONFIG_HOME/henji-harness/providers/*.json`。
  reserved id（`openrouter`/`openai`）の再定義は拒否、新規idは`openai-responses` protocolのみ選択可能。
