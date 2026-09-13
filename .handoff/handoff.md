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
  `~/.local/bin/henji`へ配置した。v3 DB/sidecar/lockは変更していない。実装、review、実測結果は個別Increment
  正本へ記録済みである。
- 次: 利用者が配置後の通常利用を確認するか、実provider再確認または次のIncrementを指示する。
- 正本: `docs/increments/increment-50.md`。調査baselineは`docs/increments/increment-49.md`。
- 注意: Increment 45〜50と`web_search` follow-up修正はcommit済み・未push・未releaseである。JSR公開済みv0.1.2は
  今回のv4実装を含まない。
  導入済みv0.1.2 binaryは今回の`web_search` follow-up修正を含むclean commit由来である。architecture、構想、
  push、tag、publish、release操作は今回行っていない。
