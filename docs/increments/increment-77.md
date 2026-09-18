# Increment 77 — builtin resource revisionをclosure内容で識別する

ステータス: **実装完了（Human Gate承認済み。roadmap／architecture変更適用済み）**

基準commit: `f8f458b7`

計画日: 2026-09-18

対象: builtin Definition／tool Definitionのrevision digestが、binary同梱ランタイム全体のハッシュ
（`embeddedRuntimeSha256`）から作られている。このためTUIやstorageなど無関係な修正でもdigestが変わり、
「同じエージェント定義か」を表さない。external Definitionは既にclosure内容のdigestを使っており
（`managed_definition_manifest.ts:130-158`の`canonicalDefinitionRevisionBytes`）、builtinだけが不整合。

## 利用者が必要とする動作

- builtin Definition revisionは、そのDefinitionのclosure内容とcontractを識別する。無関係なランタイム修正で
  変わらない。
- builtin tool Definition revisionも同様に、tool closure内容とcontractを識別する。
- Definition/toolの内容が変わったときだけrevisionが変わり、Increment 76のtransitionとして記録される。
- build識別（productVersion、sourceRevision、embeddedRuntimeSha256）は従来どおり`turnExecutions.build`に残る。

## 原因（evidence）

- `managed_resource_ref.ts:57-75` `builtinDefinitionRef`は
  `{resourceId, role, apiContract, embeddedRuntimeSha256}`をhashする。`embeddedRuntimeSha256`は
  `build_henji.ts:47-81`がROOTS（`henji_cli.ts`起点でTUI/storageを含む）のimport閉包全ファイルから算出する。
- `managed_resource_ref.ts:77-95` `builtinToolDefinitionRef`も`embeddedRuntimeSha256`を使う。
- externalは`canonicalDefinitionRevisionBytes`（declaredRole、subagentName、apiContract、entry、closure files）を
  hashする。同じ`ManagedResourceRef`内でbuiltin/externalの意味が揃っていない。

## 採用した設計

1. build時にbuiltin resourceごとのclosure digestを算出し、build manifestへ埋め込む。
   - 対象: `builtin/default`、`builtin/planner`、bundled tool Definition各identity。
   - closureは各resource moduleのentry＋local dependency files。externalの`canonicalDefinitionRevisionBytes`と
     同じ並び（role、subagentName、apiContract、entry、files）でhashし、意味を揃える。
   - `BuildManifestV1`へ`builtinResources`（resourceId/identity → digest）を追加する。schema versionは据え置きか
     bump を実装時に決める（build manifestの互換は`turnExecutions.build`の検証に影響）。
2. `builtinDefinitionRef`／`builtinToolDefinitionRef`は、対応する埋め込みdigestを使う。manifestに該当entryが
   無い場合はtyped failureとし、`embeddedRuntimeSha256`へ暗黙fallbackしない。
3. `embeddedRuntimeSha256`はbuild identityとして`turnExecutions.build`とattributionに残す。

### 影響

- builtin refの値が変わる。既存Sessionは旧digestを保持し、Increment 76のtransitionで現行へ進む（履歴attribution
  は不変）。
- bundled tool Definition refも変わる。tool bindingは`tools.json`のexternal bindingが優先されるため、bundled
  既定のみ影響する。
- `supportedAgentDefinitionApiContracts`等のcontract fieldは変わらない。

## 正本変更（適用済み）

- `docs/architecture/henji-host-agent-worker.md` F07相当のDefinition module revision記述へ、builtin resourceの
  revisionはclosure内容とcontractから算出し、binary全体のhashを使わないことを追記。
- `docs/roadmap.md` F07の現コード状態を、builtin/externalで同一のclosure内容digestを使う形へ更新。
- `BuildManifestV1`のfield追加に伴い、`docs/architecture`のbuild manifest記述を更新。

## 対象外

- `embeddedRuntimeSha256`の算出方法・build identityの変更。
- external resourceのrevision算出（既にclosure内容）。
- 過去Sessionのmigration（Increment 76のtransitionで扱う）。
- tool binding/activationの変更。

## Verification

- focused test: builtin Definition/tool refが、Definition closureを変更しないruntime修正で不変であること。
- focused test: Definition closureを変更するとrefが変わり、Increment 76のtransitionで記録されること。
- 既存のbuiltin refを使うtest（increment_33等）の期待値更新。
- production TUI（tmux）で、binary再build後に同一DefinitionのSessionが`revision change`にならないこと。
- type check、format、lint、`git diff --check`。authoritative `v0:gate`は安定候補で1回。

## 規模見積り

build scriptのclosure digest算出、manifest schema、ref算出、test更新、検証で**3〜6開発日相当**。

## Human Gate

実装前に、利用者は次を確認・承認する。

1. builtin resource revisionをclosure内容＋contractで算出する設計。
2. `BuildManifestV1`への`builtinResources`追加（schema据え置きかbumpかを含む）。
3. 上記のroadmap／architecture変更案を反映してよいか。

## 結果（2026-09-18）

- `BuildManifestV1`へoptional `builtinResources`（`kind`、`resourceId`、`identity?`、`digest`）を追加。
  `isBuildManifest`は存在する場合だけ検証する（旧recordのbuild manifestは引き続き有効）。
- `build_henji.ts`がbuiltin default／planner／bundled tool各resourceのentryとlocal module closureを`deno info`で
  集め、`canonicalDefinitionRevisionBytes`／`canonicalToolDefinitionRevisionBytes`でclosure digestを算出し、
  manifestへ埋め込む。build identityの`embeddedRuntimeSha256`は従来どおり残す。
- `builtinDefinitionRef`／`builtinToolDefinitionRef`は`builtinResources`のdigestを使う。compiled manifestで
  entryが無い場合はtypedに失敗（`embeddedRuntimeSha256`へfallbackしない）。development/source manifestだけは
  固定のdevelopment identityを使う（closure digestを持たないため）。
- 正本: roadmap F07とarchitecture「Agent Definition revision」へ適用済み。
- 検証:
  - focused test `tests/v0/increment_77_builtin_revision_test.ts`（5件、`v0:test`追加）。
  - closure digestの安定性: 同じclosure算出を直接実行し、TUI（`v0/tui/terminal.ts`）への追記ではdefault digest
    が不変（`6d07aa24…`）、definition closure内のinstruction（`v0/agent/instructions/roles/default.ts`）への
    追記では変わることを確認。
  - `v0:gate` exit 0。binary再build・配置済み。
- type-only re-exportの除去（#2修正）: `session_store.ts`の未使用な`export type { SessionCliCommand } from
  '../cli/session_cli.ts'`を削除し、builtin closureから`session_cli.ts`が外れたことを確認。
- closure境界（#1、artifact identity）: revisionはresource artifactのidentityであり、behavior変更の根拠では
  ない（behaviorは観測による）。externalと同様に`@henji/agent`（`worker_agent_api.ts`）をcontract境界として
  辿らず、type-only edgeもclosureから除外する。build scriptは`deno info`のruntime edge（`code`）だけを辿り、
  境界で停止する。結果: builtin defaultのclosureはwrapper moduleのみ、toolは自身の実装helper（例:
  `tools/web_search.ts`）とそのruntime depsのみ。
- 検証（closure境界）: TUI追記でdefault/tool digestは不変、tool実装（`tools/web_search.ts`）追記でtool digest
  のみ変化、contract境界（`worker_agent_api.ts`）追記ではどちらも不変であることを直接確認。
