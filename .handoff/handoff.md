# Handoff

## Records

### Increment 51〜55 — managed Henji base、startup表示、instruction CLI

- 状態: Increment 55は完了・配置済み。`--revision`の8〜64桁hex prefix、`uninstall --revision`省略（一意な
  とき）、`list`/`active`の人間向け行と`--json`を実装した。実装commit `2e8ce3da`。そのclean commitからbuild
  `89880f2d173beea78550e9d2bcfb226b91608f71b48971716ccb3458196909fa`を生成し、`dist/henji`と
  `~/.local/bin/henji`を同一artifactへatomic置換（両方SHA-256
  `1c478d8b02a394be4406e373267ec1230cdd85a18996d03a60e1db4bd7cb7386`、source
  `2e8ce3da0a1dfb711aef3ca75dccad9f94754061`、`sourceDirty=false`）。導入版で`instruction list`が
  `local/henji-base`の2 revisionを`inactive`/`active`とtitle付き表示し、`active`が
  `local/henji-base · external · sha256:82d67dd2`、`inspect --revision 82d67dd2`がprefix解決、
  `uninstall --id local/henji-base`が2 revisionのため`instruction_ambiguous`となることを確認した。
  focused test 8 passed、type check/format/lint/`git diff --check`成功。実provider requestは行っていない。
  前段: Increment 54（uninstall、`40ce44a9`／`bbb82615`、binary build `67649b51…`／SHA-256 `fb1c2121…`）、
  Increment 53（startup`base:`行、picker 1行・local time、`a8ac6a85`／`ee3dbdf3`、PTY実機確認）、
  Increment 52（install receipt、`1ee500ab`／`56276f49`）、Increment 51（`henji-instruction-v1`、
  `e709b100`／`0afad72c`）。構想・architecture・roadmap・inboxと`v0/agent/README.md`の実装追随は`56375021`。
  S9/S10はIncrement 55採用としてinboxから除去した。
  未実施: push、tag、Forgejo Release、JSR publish（JSR latestは0.1.3）。
- 次: `2e8ce3da`と本保存commitをpushするか、`docs/experience/normal-use-inbox.md`から次Increment候補
  （S2、S4、S5、A1、A2、A3、A5、A6、A7、A8、E1、R1〜R4）を選ぶ。
- 正本: `docs/increments/increment-51.md`〜`increment-55.md`、`docs/experience/normal-use-inbox.md`。
- 注意: active external revisionは`local/henji-base@sha256:82d67dd2…`。同じresource IDには旧
  `2e00f40b…`もinactiveで残っている（`instruction list`で確認できる）。このhandoffのIncrement 51/52部分は
  commit `e709b100`での空化後にincrement文書・git logから復元した。`docs/architecture/multi-provider-routing-and-auth.md`
  のSession schema記述はIncrement 14〜16採用設計時の計画であり現在状態の主張ではないため、実装追随の対象に
  含めていない。
