# Increment 78 — build provenanceと未使用コードの整合

ステータス: **実装・検証完了（Human Gate承認済み）**

承認日: 2026-09-19

基準commit: `8704d226`

## 利用者が必要とする動作

- compiled binaryの`sourceDirty`は、runtimeだけでなくbinary生成結果を決めるbuild scriptとその依存が
  `sourceRevision`から変更されている場合にも`true`になる。
- builtin resource revisionのproducerは、runtime import edge、type-only edge除外、Agent contract境界、
  resource実装変更によるdigest変化を自動testで維持する。
- 現行product経路に接続されていない過去のfresh-runtime比較、replay envelope、execution recordを
  active sourceとtestから除去する。
- package公開APIと現行product動作を変えず、参照されない内部exportと実装を除去する。
- test名とIncrement 77文書は現行contract・完了状態を正しく表す。

## 根拠

- `scripts/build_henji.ts`のdirty判定はruntime closureだけを対象とし、build scriptを未commitで変更して
  生成したbinaryをclean sourceとして表示した実例がある。
- Increment 77のtestは合成済みdigestのconsumerだけを確認し、build scriptのclosure producerを実行しない。
- fresh-runtime比較系14 module（3,319行）はproduction CLI、compiled binary、eval/validation taskから到達せず、
  `current_code_test.ts`の一testだけが利用する。
- 全TypeScriptの識別子照合で、package公開APIではない未参照exportを56件確認した。

## 実装計画

1. build input graphをruntime graphとbuilder graphの和として求め、`sourceDirty`をその集合から算出する。
2. build graph helperをfocused testから実行し、Increment 77のproducer contractを確認する。
3. fresh-runtime比較、replay envelope、execution recordを削除し、comparison variantをmanifest contractから除く。
4. public `mod.ts` API、CLI entrypoint、dynamic Definition/tool entrypointを除外し、未参照内部exportを反復除去する。
5. stale test名とIncrement 77の完了表記を更新する。
6. focused test、`v0:check`、`v0:fmt`、`v0:lint`、全offline `v0:test`、未使用export再走査、
   `git diff --check`を実行する。

## 対象外

- architecture、roadmap、product機能、public package APIの変更。
- live provider、実TTY、browser検証。
- historical `docs/plans/`と完了済みincrementの履歴内容の書き換え。
- test用Worker fixtureの削除。

## Human Gate

2026-09-19、利用者が上記計画を承認した。

## 結果

- build時のdirty判定をruntime closureとbuilder closureの和へ変更した。build scriptまたはその依存が
  `sourceRevision`から変わったbinaryは`sourceDirty: true`になる一方、build input外の変更はdirty扱いしない。
- builtin resource revisionの実producerを使うfocused testを追加し、runtime edgeの包含、type-only edgeと
  Agent contract境界の除外、無関係な変更でのdigest不変、resource実装変更でのdigest変化を確認した。
- production/task rootから到達しなかった比較系14 moduleと専用loop observer、comparison variant contract、
  それらだけを支えたtestを削除した。
- 初回走査で見つかった非public・単独参照export 56件と、その除去後に露出した不要実装を削除した。
  最終走査では単独参照export 0件、production/task rootから到達不能な非fixture module 0件だった。
- stale test名とIncrement 77の完了表記を現行状態へ合わせた。全41 test fileは`v0:test`から到達する。

## Verification結果

- `deno task --config deno.v0.json v0:gate`: pass（345 tests、0 failures）。
- `git diff --check`: pass。
- live provider、実TTY、browserは対象外のため実行していない。
