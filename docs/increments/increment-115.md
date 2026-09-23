# Increment 115 — headless既定rootのagent binding適用

## 要件と根拠

通常の`henji run`で`--agent`／`--definition-revision`を指定しない場合、TUIと同じ
`agent:default` bindingをroot Definitionの選択に適用する。bindingがなければbundled defaultを選び、
明示selectorの優先順位は維持する。

Increment 114のreviewで、修正前HEAD `ab34c330`のheadless CLIは
`resolveRequestedDefinition`へ`configRoot`を渡さないため、
後段のWorker SessionがXDG設定rootを解決しても既定rootの選択は変わらないと確認した
（`v0/agent/cli/runtime_cli.ts:300-307`、`v0/agent/definitions/definition_selection.ts:180-200`、
`v0/agent/worker/worker_headless_runner.ts:30-50`）。利用者がこの不具合の修正を明示した。

## 実装計画

1. headless CLIのroot選択前にproductionのXDG config／data rootを解決し、選択とWorker起動へ
   同じ値を渡す。テスト用の`run`差替えでは実ユーザーのXDG設定を読まない。
2. 既定rootのbindingあり／なしを、隔離したconfig／data rootとWorker差替えを使うfocused testで
   確認する。実provider callは行わない。
3. 対象test、type check、format、lint、`git diff --check`で確認する。

構想、architecture、roadmap、外部契約、credentialの取扱いは変更しない。実provider call、
binary build／配置、commit／pushは本依頼の範囲外。

## 結果

- `v0/agent/cli/runtime_cli.ts`で、既定rootの選択時にのみ不足するruntime rootを解決し、
  `resolveRequestedDefinition`と`runHeadlessWorker`へ同じconfig／data rootを渡した。
  明示`--agent`／`--definition-revision`では追加のXDG解決をせず、従来の選択順を維持する。
- `tests/v0/increment_65_subagent_slot_binding_test.ts`へheadless CLIのfocused regressionを追加した。
  隔離config／data rootで、bindingありならmanaged root、明示`--agent default`ならbundled root、
  bindingなしならbundled defaultとなることを確認した。Worker実行はtest seamで差し替えた。
- `agent:increment-65-subagent-slot-binding:test`は11件成功。変更2ファイルの`deno check`、
  `deno fmt`、`deno lint`、`git diff --check`はいずれも成功。初回の広域`v0:check`も成功した。
- 実provider call、production CLI E2E、binary build／配置、commit／pushは行っていない。

## 第三者review

read-only reviewerが修正差分と必要な呼出先を確認し、対応が必要なfindingはなかった。
既定起動ではbinding選択とWorker起動へ同じconfig／data rootが渡り、binding不在時は
bundled defaultを選ぶこと、明示`--agent`の優先が維持されることを確認した。
隔離rootを使う追加testは実XDG設定を読まない。production CLIからWorkerまでの通し実行は
今回のreviewでも未確認である。
