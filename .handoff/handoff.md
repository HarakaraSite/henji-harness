# Handoff

## Records

### Increment 51〜60 — instruction CLI、OpenRouter Responses、provider宣言override

- 状態: Increment 59/60は完了・配置済み。data-only provider宣言
  （`$XDG_CONFIG_HOME/henji-harness/providers/*.json`、schemaVersion 1、`providerId`/`protocol`/`endpoint`/
  `authProfile`/fixed `modelCatalog`/`defaults`）を追加し、Hostが起動時にload/validate、Worker start commandへ
  data-onlyで渡す。`openrouter-responses`の**endpoint**と**catalog/defaults**を宣言で上書きでき、
  `/model`・`/effort`・picker・起動既定へ反映する。reserved id（`openrouter`/`openai`）は拒否、未知protocol/
  authProfile/重複はtyped failure。footerは`openrouter`と`openrouter-responses`を区別する。実装commit
  `871cfb6c`。clean commitからbuild `7e2ee3d5a6cd30ebd1f4b91159b77ca02a71dca5637c60b2e287948cfbd91102`を生成し、
  `dist/henji`と`~/.local/bin/henji`をatomic置換（両方SHA-256
  `c259eb397ca07e105eeb68fa6370a6090e2465169c7e8be8b94e0bd949865b43`、source
  `871cfb6ce4a50855113b93a4521e1929ee139de2`、`sourceDirty=false`）。authoritative `v0:gate`通過（初回は
  Increment 33のTUI起動順testで回帰を検出、`tuiMain`の宣言読込を注入session時はskipする修正で解消）。実機で
  isolated XDG宣言のcatalog/defaults overrideがfooterへ反映されることを確認した（provider requestなし）。
  前段: Increment 58（OpenRouter Responses経路、`4d21a9ea`／`d231addc`、実provider probe済み）、Increment 57
  （instruction receipt短縮統一、`25325498`／`5fc5b962`）、Increment 56（`d71c026f`／`7cb653d7`）、Increment 55
  （`2e8ce3da`／`48eb4cd6`）、Increment 54（`40ce44a9`／`bbb82615`）、Increment 53（`a8ac6a85`／`ee3dbdf3`）、
  Increment 52（`1ee500ab`／`56276f49`）、Increment 51（`e709b100`／`0afad72c`）。A8/E1の採用方向はarchitecture
  （`multi-provider-routing-and-auth.md`、`henji-host-agent-worker.md`）とroadmapへ反映済み。
  未実施: tag、Forgejo Release、JSR publish（JSR latestは0.1.3）。
- 次: 宣言で**新しいprovider id**を追加できるようにする将来incrementは、永続`ModelSelection` identityの一般化、
  provider-agnosticなChat Completions adapter、Session/evidence validationの一般化、architecture判断を伴うため
  未着手（increment-59/60.mdに明記）。他候補はS2、S4、S5、A1、A2、A3、A5、A6、A7、R1〜R4。
- 正本: `docs/increments/increment-51.md`〜`increment-60.md`、`docs/experience/normal-use-inbox.md`。
- 注意: active external revisionは`local/henji-base@sha256:82d67dd2…`。同じresource IDには旧
  `2e00f40b…`もinactiveで残っている（`instruction list`で確認できる）。`openrouter-responses`は独立provider ID
  として扱う。このhandoffのIncrement 51/52部分はcommit `e709b100`での空化後にincrement文書・git logから復元した。
