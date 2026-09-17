# Handoff

## Records

### Increment 51〜56 — managed Henji base、startup表示、instruction CLI

- 状態: Increment 56は完了・配置済み。`instruction install` receiptが短縮revision・`Full:`・`Inspect`/
  `Activate`/`Uninstall`の短縮selectorを表示し、`instruction deactivate`が
  `deactivated · builtin/henji-base · built-in · sha256:<short>`の人間向け行（`--json`で現行JSON）を返す。
  実装commit `d71c026f`。そのclean commitからbuild
  `657b11bd5145b8dd0f1f60f9865da58471595d4bfbd6c429266d5b85a66fb71f`を生成し、`dist/henji`と
  `~/.local/bin/henji`をatomic置換（両方SHA-256
  `982b43be9f03b2a1d7eb12c3fd10d8ce9e6253f44f02bc715ce58fce73ab5bab`、source
  `d71c026f3a7c7dc7e72c74490930b4808c7ce3c6`、`sourceDirty=false`）。導入版をisolated XDGで実行し、
  receipt・短縮`activate`・`deactivate`人間向け行・`list`・短縮`uninstall`を確認した。focused test 8 passed、
  type check/format/lint/`git diff --check`成功。実provider requestは行っていない。
  前段: Increment 55（短縮revision、`uninstall --id`省略、`list`/`active`人間向け行、`2e8ce3da`／配置記録
  `48eb4cd6`、binary build `89880f2d…`）、Increment 54（uninstall、`40ce44a9`／`bbb82615`）、Increment 53
  （startup`base:`行、picker 1行・local time、`a8ac6a85`／`ee3dbdf3`）、Increment 52（install receipt、
  `1ee500ab`／`56276f49`）、Increment 51（`henji-instruction-v1`、`e709b100`／`0afad72c`）。
  構想・architecture・roadmap・inboxと`v0/agent/README.md`の実装追随は`56375021`。S9/S10はIncrement 55採用で
  inboxから除去した。
  未実施: push、tag、Forgejo Release、JSR publish（JSR latestは0.1.3）。
- 次: `d71c026f`と本保存commitをpushするか、`docs/experience/normal-use-inbox.md`から次Increment候補
  （S2、S4、S5、A1、A2、A3、A5、A6、A7、A8、E1、R1〜R4）を選ぶ。
- 正本: `docs/increments/increment-51.md`〜`increment-56.md`、`docs/experience/normal-use-inbox.md`。
- 注意: active external revisionは`local/henji-base@sha256:82d67dd2…`。同じresource IDには旧
  `2e00f40b…`もinactiveで残っている（`instruction list`で確認できる）。このhandoffのIncrement 51/52部分は
  commit `e709b100`での空化後にincrement文書・git logから復元した。`docs/architecture/multi-provider-routing-and-auth.md`
  のSession schema記述はIncrement 14〜16採用設計時の計画であり現在状態の主張ではないため、実装追随の対象に
  含めていない。
