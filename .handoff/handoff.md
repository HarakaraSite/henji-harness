# Handoff

## Records

### 次Incrementの選定

- 状態: Increment 50のschema v4 cutover、normalized fact authority、progress delta、current Sessionだけの
  `ActiveSessionProjection`を実装した。独立実装reviewのP1 4件・P2 1件を修正し、同じreviewerの再reviewで
  Blocker/P1/P2なしを確認した。focused test、静的check、authoritative gate一回、isolated production turnを完了し、
  review修正後のstandalone buildも成功した。利用者承認後のproduction CLI E2Eで現行contractとevaluator/fixtureの
  不整合を発見・修正し、offline 5件と保持済み実provider dataの再評価で`passed`を確認した。修正後の実provider
  E2Eも一回`passed`した。利用者の明示指示により、同じbuildを`dist/henji`と`~/.local/bin/henji`へ配置した。
  その後の通常利用で`web_search` auxiliary requestとtool effectのcontext ordinal不整合によるcanonical commit
  failureを観測し、原因を実DBから特定してsourceと回帰testを修正した。focused testと静的checkは成功した。
  利用者の明示指示により、全差分をcommitし、そのclean commitからbuildした同一artifactを`dist/henji`と
  `~/.local/bin/henji`へ配置した。利用者が配置版で3件の`web_search`からfinal response、canonical commit、
  ready復帰までを確認した後、release commit `8f84795e`を`origin/main`へpushし、`@henji/harness@0.1.3`を
  JSRへpublishした。registry metadataとexact importを確認し、同じrelease commitからbuildしたv0.1.3を
  `dist/henji`と`~/.local/bin/henji`へ配置して同一SHA-256を確認した。v3 DB/sidecar/lockは変更していない。
  実装、review、実測結果は個別Increment正本へ記録済みである。
- 次: `docs/experience/normal-use-inbox.md`から次のIncrement候補を選定する。
- 正本: `docs/increments/increment-50.md`。調査baselineは`docs/increments/increment-49.md`。
- 注意: JSR公開済みv0.1.3と導入済みv0.1.3 binaryは、Increment 45〜50と`web_search` follow-up修正を含む。
  architecture、構想、Git tag、Forgejo Releaseは変更・作成していない。
