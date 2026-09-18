# Increment 79 — product正本とdelegation契約の整合

ステータス: **実装・検証完了（Human Gate承認済み）**

承認日: 2026-09-19

基準commit: `9de2255d`

## 利用者が必要とする動作

- 構想、architecture、roadmap、active sourceが、Session継続時のDefinition選択、Provider外部化の実装状態、
  context attributionの実装範囲について同じ現行contractを示す。
- 保存Sessionの継続は、保存済みDefinition refを選択候補にせず、現行の明示selector、`agent:default` binding、
  bundled defaultから解決したDefinitionを使う。過去turnのattributionは変更しない。
- Provider正本は、同梱4 provider ID、data-only declaration、binary-owned protocol adapter、external provider ID、
  built-in catalog/defaults override、Responses replay scopeを実装済みとして示す。
- `delegate_to_planner`のmodel-visible説明は、bundled plannerにもexternal `subagent:planner` bindingにも正しく、
  実装identityやDefinitionが保証しない権限を断定しない。
- 完了済みincrementの歴史記述は、現行contractと混同されない形で残す。

## 根拠

- `henji-host-agent-worker.md`のSession継続規定は、現行Definitionを使うproduct decisionと保存exact refを優先する
  後段記述が矛盾していた。Increment 76とactive sourceは前者を実装している。
- Provider architectureとroadmapには、Increment 58〜68で実装済みのOpenRouter Responses、Provider declaration、
  Chat Completions宣言provider、provider ID整列を未実装・予定として扱う記述が残っていた。
- roadmap F19は、Increment 42で実装済みのexecutionとAgent側基底設定のexact context attributionまで未実装に
  読める表現だった。
- planner delegation descriptionは常に`built-in planner`かつworkspaceを変更できないと断定していたが、
  Increment 65以降はexternal planner Definitionがinstructionとtool構成を所有できる。

## 実装計画

1. Session継続時のroot Definition選択規定を現行sourceとIncrement 76へ統一する。
2. Provider architectureとroadmapをIncrement 58〜68の実装済みcontractへ更新し、導入前の記述は履歴と明示する。
3. roadmap F19とIncrement 33の歴史記述を、現行attribution/tool Definition contractと区別する。
4. planner delegation descriptionをimplementation-neutralにし、external bindingでも成立する回帰testを追加する。
5. named subagent/tool一般化より前のsource commentを現行処理範囲へ合わせる。
6. focused test、type check、format、lint、`git diff --check`を実行する。

## 対象外

- 構想の目的、人間によるcandidate生成・採用境界、self-revisionの実装順序の変更。
- Provider protocol、declaration schema、Session schema、Definition selection runtimeの変更。
- historical `docs/plans/`、通常利用メモ、完了済みincrement本文の一括更新。
- live provider、実TTY、browser、compiled binaryの再build・配置。

## Human Gate

2026-09-19、利用者がreviewで提示したfindingと修正範囲を承認した。

## 結果

- Session継続時のroot Definition選択を、明示selector、`agent:default` binding、bundled defaultの順へ統一し、
  保存済みrefは過去turn attributionとしてだけ扱う規定へ一本化した。
- provider architecture、roadmap、利用READMEを、同梱4 ID、external data-only declaration、binary-owned 2 protocol、
  catalog/defaults override、provider/model単位のResponses replayという現行実装へ合わせた。導入前の比較表は
  historical inputと明示した。
- roadmap F19を、exact context attributionは実装済み、cross-session experience正本と利用者判断・目的・理由の
  統合は未実装、という境界へ修正した。Increment 33のtool replacementは後続Incrementで廃止済みと明示した。
- `delegate_to_planner`の説明からbuilt-in identity、workspace/skill可視性、非変更権限の断定を除き、bundled/external
  のどちらにも成立するtask-only synchronous delegation contractへ変更した。
- subagent/tool resolverとregistryのコメントをnamed subagent／全declared toolを扱う現行処理へ合わせた。

## Verification結果

- focused test: 63件pass、0 failures。
  - Increment 14/58〜68 Provider経路: 21件。
  - Increment 65 external planner binding: 10件。
  - Increment 72/79 named subagentとplanner説明: 2件。
  - Increment 76 Session Definition transition: 3件。
  - Increment 42 exact context attribution: 27件。
- `deno task --config deno.v0.json v0:check`: pass。
- `deno task --config deno.v0.json v0:fmt`: pass。
- `deno task --config deno.v0.json v0:lint`: pass。
- `git diff --check`: pass。
- runtime protocol、provider request、compiled artifactは変更していないため、live provider、実TTY、binary build・配置は
  実行していない。
