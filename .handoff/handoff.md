# Handoff

## Records

### Increment 51〜54 — managed Henji base、install receipt、startup表示、instruction uninstall

- 状態: Increment 54は完了・配置済み。`henji instruction uninstall --id <id> --revision sha256:<digest>`を追加し、
  active external revisionは`instruction_active`で拒否して先にdeactivateを要求する。実装commit `40ce44a9`、
  S6/S8のinbox整理はcommit `7eed3624`。clean commitからbuild
  `67649b5158e76219f7a6ada75d2b40e97abde93aff6beb0409656900ee116236`を生成し、`dist/henji`と
  `~/.local/bin/henji`をatomic置換（両方SHA-256
  `fb1c2121f06fb8ecfb40f05ced6126f6e3066a5ef15abd351f0fcd6d7c0ef6fd`、source
  `7eed36240028bf7614d981141148adb370875f70`、`sourceDirty=false`）。導入版の`instruction active`はexternal
  `local/henji-base@sha256:82d67dd2…`を維持し、同revisionへの`uninstall`が拒否されることを確認した。
  前段: Increment 53（startup`base:`行、picker 1行・local time、commit `a8ac6a85`／配置記録`ee3dbdf3`、PTYで
  実機確認）、Increment 52（install receipt、`1ee500ab`／`56276f49`）、Increment 51（`henji-instruction-v1`、
  built-in/external base、Worker-core finalizer、context attribution、`e709b100`／`0afad72c`）。
  構想・architecture・roadmap・inboxと`v0/agent/README.md`の実装追随はcommit `56375021`。
  未実施: tag、Forgejo Release、JSR publish（JSR latestは0.1.3）。
- 次: `docs/experience/normal-use-inbox.md`から次Increment候補を選ぶ。候補はS2、S4、S5、A1、A2、A3、A5、A6、
  A7、A8、E1、R1〜R4。
- 正本: `docs/increments/increment-51.md`〜`increment-54.md`、`docs/experience/normal-use-inbox.md`。
- 注意: このhandoffのIncrement 51/52部分はcommit `e709b100`での空化後にincrement文書・git logから復元した。
  active external revisionは`local/henji-base@sha256:82d67dd2…`。`docs/architecture/multi-provider-routing-and-auth.md`
  のSession schema記述はIncrement 14〜16採用設計時の計画であり現在状態の主張ではないため、実装追随の対象に
  含めていない。
