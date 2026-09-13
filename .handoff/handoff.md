# Handoff

## Records

### 次Incrementの選定

- 状態: Increment 44でSQLiteを唯一のdurable history経路へ統一し、旧filesystem storeと到達不能なruntime/testを
  削除した。Deno 2.9.6へ統一し、READMEとJSR説明を0.xの現状に合わせた。追加release testは利用者判断で実施せず、
  authoritative `v0:gate`全272 testを通したcommit `1c1330c3`を`origin/main`へpushした。
  `@henji/harness@0.1.1`はJSRへpublish済みでmetadataとexact importを確認した。VMの
  `~/.local/bin/henji`も同commitからbuildしたv0.1.1へ置換済みである。公開後、Henjiの名称が日本語の「返事」に
  由来する説明を`README.md`とJSR Overview用`mod.ts`へ追記し、現在のHost / Worker実装と未実装の自己改訂・
  revision transition・構成可能なcontext / loopを区別する説明へ修正した。この差分は未commit・未publishで、
  次回releaseへまとめる。
- 次: v0.1.1を通常利用し、`docs/experience/normal-use-inbox.md`から次Increment候補を選定する。
- 正本: `docs/increments/increment-44.md`、`README.md`、`mod.ts`、`jsr.json`、
  `docs/operations/jsr-publish.md`、`docs/experience/normal-use-inbox.md`。
- 注意: 既存SQLite・旧JSON dataは変更・削除していない。architecture・roadmap・構想の変更、Git tag、Forgejo
  Releaseは実施していない。READMEとJSR Overviewの説明修正について、現時点ではJSR publishを行わない。
