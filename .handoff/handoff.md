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
  discoveryされることを確認し、commit `f78d0eda`へ記録した。Increment 45は未push・未releaseである。利用者承認に
  よりIncrement 46〜48を続けて実装した。development versionは`jsr.json`と一致し、通常幅・compactのTUIヘッダが
  実行中buildの`productVersion`を表示する。`/new`はdurable変更まで仮Sessionのままとなり、最初のturn、rename、
  provider/model/effort変更で保存する。一意なslash command候補はTabで完全なcommand名へ補完し、複数候補と通常
  path completionの既存動作を維持する。focused testと`v0:check`、`v0:fmt`、`v0:lint`、`git diff --check`は成功した。
  利用者の別途承認により`docs/roadmap.md`のF01とproduction TUI実装一覧も現状へ整合させ、Increment 46〜48を
  commit `229e40ee`へ記録した。full `v0:gate`は承認済み範囲に含めず実行していない。利用者の明示指示により、
  Increment 45〜48を含むbinaryを`dist/henji`と`~/.local/bin/henji`へ配置した。commit前の同一runtimeを含む配置後
  動作を利用者が確認し、OKと判断した。commit後にattributionを揃えて再build・再配置し、version `0.1.2`、source
  revision `229e40ee79e448f6895a6480a69aaf607ea756fd`、`sourceDirty: false`、build ID
  `9bf545653b420811ceabdcd02e2c95bf3fea2569605b94e47659b97cfc86e7f3`をreadbackした。両artifactのSHA-256
  `1e5c87759b20981cd966682d689fefb637bb71d618d76dd55321a1ef8b8af71f`も一致した。
- 次: commit済みのIncrement 45〜48をpush・releaseするか、または次Incrementを選ぶか利用者が判断する。
- 正本: `docs/increments/increment-44.md`〜`docs/increments/increment-48.md`、`README.md`、`mod.ts`、`jsr.json`、
  `docs/operations/jsr-publish.md`、`docs/experience/normal-use-inbox.md`。
- 注意: 既存SQLite・旧JSON dataは変更・削除していない。roadmapは承認済みの現状反映だけを行い、architecture・
  構想の変更、Git tag、Forgejo Releaseは実施していない。導入済みv0.1.2はcommit `229e40ee`までの
  Increment 45〜48を含む一方、JSR公開済みv0.1.2はrelease commit `c6ad7330`のままでこれらを含まない。push、
  publishは行っていない。
