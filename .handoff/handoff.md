# Handoff

## Records

### Increment 51〜57 — managed Henji base、startup表示、instruction CLI

- 状態: Increment 57まで完了・配置済み。instruction CLIの人間向け既定出力を短縮revision（先頭8桁）に統一
  （`install`/`uninstall` receiptの`Full:`を廃止、`uninstall` receiptも短縮化。`list`/`active`/`deactivate`は
  短縮行）。`--revision`は8〜64桁hex prefix、`uninstall`は`--revision`省略可（一意なとき）、複数一致は
  `instruction_ambiguous`。実装commitはIncrement 56 `d71c026f`／配置記録`7cb653d7`、Increment 57
  `25325498`。最新buildは
  `7998365e879c8dcd741d3a2ff3ce107315b19dee74587accccfa9d6a8466cb1b`、source
  `25325498b7189ed72974cc307fce32d4c884370e`、`dist/henji`と`~/.local/bin/henji`のSHA-256は
  `b0823302afb1f025212e031bd4e411273b2a12eeebc881e176351a0a34f94b18`で一致、`sourceDirty=false`。
  導入版をisolated XDGで実行し、receiptの短縮統一と`deactivate`人間向け行を確認した。focused test 8 passed、
  type check/format/lint/`git diff --check`成功。実provider requestは行っていない。
  前段: Increment 55（`--revision` prefix、`uninstall --id`省略、`list`/`active`短縮行、`2e8ce3da`／
  `48eb4cd6`）、Increment 54（uninstall、`40ce44a9`／`bbb82615`）、Increment 53（startup`base:`行、picker
  1行・local time、`a8ac6a85`／`ee3dbdf3`）、Increment 52（install receipt、`1ee500ab`／`56276f49`）、
  Increment 51（`henji-instruction-v1`、`e709b100`／`0afad72c`）。構想・architecture・roadmap・inboxと
  `v0/agent/README.md`の実装追随は`56375021`。S9/S10はIncrement 55採用でinboxから除去した。
  未実施: tag、Forgejo Release、JSR publish（JSR latestは0.1.3）。
- 次: 利用者希望（2026-09-17）としてA8（OpenRouter Responses API経路）とE1（Provider設定の外部化）を合わせた
  採用方向がある。architecture（`multi-provider-routing-and-auth.md`、`henji-host-agent-worker.md`）とroadmapへ
  反映済み（採用済み・未実装）。次のincrement候補として順序・分割を相談する。他の候補はS2、S4、S5、A1、A2、
  A3、A5、A6、A7、R1〜R4。
- 正本: `docs/increments/increment-51.md`〜`increment-57.md`、`docs/experience/normal-use-inbox.md`。
- 注意: active external revisionは`local/henji-base@sha256:82d67dd2…`。同じresource IDには旧
  `2e00f40b…`もinactiveで残っている（`instruction list`で確認できる）。このhandoffのIncrement 51/52部分は
  commit `e709b100`での空化後にincrement文書・git logから復元した。`docs/architecture/multi-provider-routing-and-auth.md`
  のSession schema記述はIncrement 14〜16採用設計時の計画であり現在状態の主張ではないため、実装追随の対象に
  含めていない。
