# Handoff

## Records

### Increment 51〜53 — managed Henji base、install receipt、startup base表示とsession picker

- 状態: Increment 53は完了・配置済み。TUI startupのfull layoutへ`base: local/henji-base · external ·
  82d67dd2`行を追加し、session pickerを1 Session 1行・local timezone表示へ変更した。実装commit `a8ac6a85`、
  配置記録commit `ee3dbdf3`。PTYで導入済みbinaryを`/tmp/henji-harness`にて起動し、`base:`行と`context: none`、
  pickerの`> 2026-09-17 13:24  untitled · 90d7fe6e · 1 turns · resumable`（保存UTC `04:24Z`のJST変換）を
  実機確認した。build `beddeb779debf2d93ef11d4adff5ac64ae8343549e7a5cb45aec2f312a90d6a3`、source
  `a8ac6a85828131a36e49b0cb20a76afcc733b680`、`sourceDirty=false`、`dist/henji`と`~/.local/bin/henji`の
  SHA-256は`196b8ae8378d8a54239bd647fdba4e173d3fd57a39cc77a0e4051251ef767dbb`で一致。
  前段のIncrement 52（install receipt、commit `1ee500ab`／配置記録`56276f49`）とIncrement 51
  （`henji-instruction-v1`、built-in/external base、Worker-core finalizer、context attribution、commit
  `e709b100`／配置記録`0afad72c`）も完了・配置済み。構想・architecture・roadmap・inboxと`v0/agent/README.md`の
  実装追随はcommit `56375021`、S8候補記録は`6b0b3566`。
  未実施: tag、Forgejo Release、JSR publish（JSR latestは0.1.3）。
- 次: `docs/experience/normal-use-inbox.md`から次Increment候補を選ぶ。候補はS6（採用済み）、S5、S7、
  A2、A5、A6、A8、A3、A7、E1、R1〜R4。
- 正本: `docs/increments/increment-51.md`、`docs/increments/increment-52.md`、`docs/increments/increment-53.md`、
  `docs/experience/normal-use-inbox.md`。
- 注意: このhandoffのIncrement 51/52部分はcommit `e709b100`での空化後にincrement文書・git logから復元した。
  現在のactive external revisionは`local/henji-base@sha256:82d67dd2…`であり、Increment 52配置時の記録
  `2e00f40b…`とは異なる（配置後にbindingが更新された）。`docs/architecture/multi-provider-routing-and-auth.md`の
  Session schema記述はIncrement 14〜16採用設計時の計画であり現在状態の主張ではないため、実装追随の対象に含めていない。
