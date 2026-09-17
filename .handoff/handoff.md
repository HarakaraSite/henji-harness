# Handoff

## Records

### Increment 51〜58 — instruction CLI、OpenRouter Responses経路

- 状態: Increment 58は完了・配置済み。OpenRouter Responses API経路をroute identity
  `{ provider:'openrouter-responses', api:'openrouter-responses', authProfile:'openrouter-api-key' }`として
  追加し、共有Responses adapter（OpenAI ResponsesとOpenRouter Responses）でstatelessに実行する。`/provider`と
  `--root-provider openrouter-responses`で選択でき、既定はOpenRouter Chat Completionsのまま、planner defaultと
  `web_search`(Sonar)もChat Completionsのまま。実装commit `4d21a9ea`。clean commitからbuild
  `a540a567e3d42d6f9756654a80b32f2275ae92ea3305106428756a221499c637`を生成し、`dist/henji`と
  `~/.local/bin/henji`をatomic置換（両方SHA-256
  `2f80559e6ea7b17311852ccd634c99a4039e0e09ba7be86eb99648d314110c70`、source
  `4d21a9ea0e08acbe066f72ed0b80fc5d363ac3b8`、`sourceDirty=false`）。authoritative `v0:gate`通過（初回は
  `v0/agent/README.md`整形のみで停止、修正後再実行で成功）。実provider probeでOpenRouter Responsesの
  tool call→streaming→final、canonical commit、evidence attribution（endpoint
  `https://openrouter.ai/api/v1/responses`、credential非記録）を確認した。
  前段: Increment 57（instruction receipt短縮統一、`25325498`／`5fc5b962`）、Increment 56（install receiptと
  deactivate人間向け、`d71c026f`／`7cb653d7`）、Increment 55（`--revision` prefix、`uninstall --id`省略、
  `2e8ce3da`／`48eb4cd6`）、Increment 54（uninstall、`40ce44a9`／`bbb82615`）、Increment 53（startup`base:`行、
  picker 1行・local time、`a8ac6a85`／`ee3dbdf3`）、Increment 52（install receipt、`1ee500ab`／`56276f49`）、
  Increment 51（`henji-instruction-v1`、`e709b100`／`0afad72c`）。A8/E1の採用方向はarchitecture
  （`multi-provider-routing-and-auth.md`、`henji-host-agent-worker.md`）とroadmapへ反映済み。
  未実施: tag、Forgejo Release、JSR publish（JSR latestは0.1.3）。
- 次: Increment 59としてProvider宣言seam（data-only declaration、Host credential registry/auth profile catalog、
  OpenRouter Responsesを最初の宣言へ移行）を計画する。他候補はS2、S4、S5、A1、A2、A3、A5、A6、A7、R1〜R4。
- 正本: `docs/increments/increment-51.md`〜`increment-58.md`、`docs/experience/normal-use-inbox.md`。
- 注意: active external revisionは`local/henji-base@sha256:82d67dd2…`。同じresource IDには旧
  `2e00f40b…`もinactiveで残っている（`instruction list`で確認できる）。Increment 58のroute identityは
  multi-provider設計の「初期selectionは名前を実装時に調整できる」に従い`openrouter-responses`を独立provider IDと
  した。このhandoffのIncrement 51/52部分はcommit `e709b100`での空化後にincrement文書・git logから復元した。
