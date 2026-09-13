# Handoff

## Records

### 次Incrementの選定

- 状態: Increment 44でSQLiteを唯一のdurable history経路へ統一し、旧filesystem storeと到達不能なruntime/testを
  削除した。Deno 2.9.6へ統一し、READMEとJSR説明を0.xの現状に合わせた。追加release testは利用者判断で実施せず、
  authoritative `v0:gate`全272 testを通したcommit `1c1330c3`を`origin/main`へpushした。
  `@henji/harness@0.1.1`はJSRへpublish済みでmetadataとexact importを確認した。VMの
  `~/.local/bin/henji`も同commitからbuildしたv0.1.1へ置換済みである。公開後、Henjiの名称が日本語の「返事」に
  由来する説明を`README.md`とJSR Overview用`mod.ts`へ追記し、現在のHost / Worker実装と未実装の自己改訂・
  revision transition・構成可能なcontext / loopを区別する説明へ修正した。追加release testは利用者判断で
  実施せず、authoritative `v0:gate`全272 testを通したcommit `c6ad7330`を`origin/main`へpushした。
  `@henji/harness@0.1.2`はJSRへpublish済みで、metadataのlatest versionとexact importを確認した。VMの
  `~/.local/bin/henji`もrelease commit `c6ad7330`からbuildしたv0.1.2へ置換し、versionを確認した。Increment 45で
  native Skill description上限を160 bytesから1 KiBへ広げ、観測済みの長いdescriptionを持つ実Skillがすべて
  discoveryされることを確認した。Increment 45の差分は未commit・未releaseである。
- 次: Increment 45の差分を確認し、指示があればcommitと次releaseを行う。
- 正本: `docs/increments/increment-44.md`、`docs/increments/increment-45.md`、`README.md`、`mod.ts`、`jsr.json`、
  `docs/operations/jsr-publish.md`、`docs/experience/normal-use-inbox.md`。
- 注意: 既存SQLite・旧JSON dataは変更・削除していない。architecture・roadmap・構想の変更、Git tag、Forgejo
  Releaseは実施していない。導入済みv0.1.2には未commitのIncrement 45を含まない。
