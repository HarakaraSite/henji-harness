# Handoff

## Records

### Increment 51〜63 — instruction CLI、provider外部化（宣言・一般化・replay・既定）

- 状態: Increment 63は完了・配置済み。完全外部化(c)の第1段として、既定selectionを
  `$XDG_CONFIG_HOME/henji-harness/default-selection.json`へ外部化し、`/provider`・`/model`・`/effort`の確定で
  更新、`--root-provider`未指定時は保存済み既定（解決不能ならbuilt-in既定）をrootに使う。`openrouter`/`openai`の
  catalog/defaultsを宣言でoverride可能にし（protocol/endpoint/authProfileはbuilt-in一致必須、不一致は
  `provider_declaration_invalid`）、catalog参照・選択・検証・root fallbackを実効値化した。実装commit `26743c62`。
  clean commitからbuild `45298791438c8ad7d1a60229c742825404f9ee7a16fe8f1da84c80cadb780992`を生成し、
  `dist/henji`と`~/.local/bin/henji`をatomic置換（両方SHA-256
  `f1b428dbeb9f036fc5f4cf4d277d7fc9e9abc715ecb91e1b35289f36787450f8`、source
  `26743c620cbb5bd5fe9bd06831cc173dda4c5fac`、`sourceDirty=false`）。authoritative `v0:gate`通過。実機で
  保存済み既定の起動反映、`--root-provider`上書き、openrouter catalog override、endpoint不一致宣言の起動前失敗を
  確認した。roadmapのProvider外部化節へ58〜63の実装状況と64〜66の予定段階を追記した。
  前段: Increment 62（Responses replayのprovider/model scope、`5218618a`／`5d17d754`、実probe）、Increment 61
  （宣言provider一般化、`6a34bf07`／`4ef3d59b`）、Increment 59/60（provider宣言、endpoint/catalog override、
  `871cfb6c`／`e1814528`）、Increment 58（OpenRouter Responses、`4d21a9ea`／`d231addc`）、Increment 57
  （`25325498`／`5fc5b962`）、Increment 56（`d71c026f`／`7cb653d7`）、Increment 55（`2e8ce3da`／`48eb4cd6`）、
  Increment 54（`40ce44a9`／`bbb82615`）、Increment 53（`a8ac6a85`／`ee3dbdf3`）、Increment 52
  （`1ee500ab`／`56276f49`）、Increment 51（`e709b100`／`0afad72c`）。
  未実施: tag、Forgejo Release、JSR publish（JSR latestは0.1.3）。
- 次: 完全外部化(c)の続き。Increment 64（curated catalogのコード除去と同梱default declarationsへの移行、chat
  completions adapterのendpoint宣言対応）、65（planner/Sonarのrole別既定）、66（built-in id削除とSession影響、
  既定解決不能時の入力ブロック）。他候補はS2、S4、S5、A1、A2、A3、A5、A6、A7、R1〜R4。
- 正本: `docs/increments/increment-51.md`〜`increment-63.md`、`docs/experience/normal-use-inbox.md`、
  `docs/roadmap.md`のProvider外部化節。
- 注意: active external revisionは`local/henji-base@sha256:82d67dd2…`。宣言providerは
  `$XDG_CONFIG_HOME/henji-harness/providers/*.json`、既定selectionは同`default-selection.json`。
  reserved idは空で、`openrouter`/`openai`/`openrouter-responses`はcatalog/defaultsのみoverride可能。新規idは
  `openai-responses` protocolのみ選択可能。adapterはbinary-owned、protocolは固定enum。
