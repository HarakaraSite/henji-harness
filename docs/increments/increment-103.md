# Increment 103 — built-in base instructionの最小化と外部instructionの直接読み込み（E4）

ステータス: **実装・検証完了（offline v0:gate exit 0、binary配置済み）**

計画日: 2026-09-22

関連: [`experience/normal-use-inbox.md`](../experience/normal-use-inbox.md) E4、
Increment 51（managed Henji base instruction）、Increment 102（instruction順序方針）、
[`architecture/henji-host-agent-worker.md`](../architecture/henji-host-agent-worker.md)、
[`architecture/multi-provider-routing-and-auth.md`](../architecture/multi-provider-routing-and-auth.md)、
`v0/agent/instructions/`、`v0/agent/cli/instruction_cli.ts`。

## 利用者が必要とする動作

- built-in base instructionは最小core（Henjiの役割identityとcredential/Authorization境界）だけを持つ。
- 詳細な作業方針は外部instructionとして、`$XDG_CONFIG_HOME/henji-harness/instruction.md`を置くだけで
  読み込まれる（`install`／`activate`不要）。`AGENTS.md`と同程度に簡単に読み書きできる。
- 外部ファイルがあればそれがbuilt-in coreを置き換え、無ければ最小built-in coreを使う。
- 外部ファイルの内容は実行attribution（source identityとcontent digest）としてreadbackできる。

## 決定（利用者判断 2026-09-22）

- 外部base instructionは**userファイル`$XDG_CONFIG_HOME/henji-harness/instruction.md`を直接読み込む**。
- built-inに残すのは**役割＋credential境界**。
- 既存のmanaged revision（`henji instruction install`／`activate`／XDG data store）は**外部ファイルへ置換**する
  （破壊的変更。互換read/writeやfallbackを追加しない）。

## 現状

- `HENJI_COMMON_INSTRUCTION`（`v0/agent/instructions/henji_common.ts`）が役割・成果物忠実性・tool再利用・
  順序方針・credentialを保持し、binaryに埋め込まれる。
- 外部`instruction:henji-base`は`managed_instruction.ts`がXDG dataのmanaged storeと
  `$XDG_CONFIG_HOME/henji-harness/instruction/active-v1.json`のbindingで解決する
  （`worker_tui_session.ts:361-364`の`resolveActiveHenjiBaseInstruction`）。
- `SelectedHenjiBaseInstruction`（slot／selectionSource／`HenjiInstructionRevisionRef`／contentDigest／content）
  は`worker_core_finalizer.ts`がDefinition contributionの先頭へ合成し、execution attributionとhistory validationが
  同じ形を参照する。`isWellFormedResourceId`は任意の非空文字列を許すため、**refの形を維持したまま**外部ファイルの
  identity（resourceId＋content digest）を表現できる。history schemaの変更は不要。

## 変更後の内容

### built-in（最小core）

`HENJI_COMMON_INSTRUCTION`:

> You are Henji, a software-engineering agent running in an interactive terminal. Follow the instructions
> provided to you and report outcomes clearly and concisely.
>
> Do not use tools to read or source credential configuration or access a task-side authenticated service
> unless the user explicitly asks to use that real instance or authenticated client for the current task.
> When access is authorized, do not display credential values.

### 外部ファイル（推奨内容の雛形）

`$XDG_CONFIG_HOME/henji-harness/instruction.md`に置く内容として、built-inから移した次の段落をincrement文書と
`docs/`の雛形に記録する（成果物忠実性、tool結果の再利用、順序方針・smallest-sufficient）。利用者はこれを
コピーして編集する。

**帰結（明記）**: 外部ファイルが無い場合、Henjiは最小coreのみで動作し、上記の詳細方針は適用されない。
既定で詳細方針を使いたい利用者は雛形を`instruction.md`へ配置する。

## 正本変更（承認依頼）

- `architecture/henji-host-agent-worker.md`: Henji Instructionのsource contractを「built-in core＋
  `$XDG_CONFIG_HOME/henji-harness/instruction.md`の直接読み込み」へ変更。managed revision kind、install、
  activation binding、XDG data storeをinstructionの正本から外す。
- `architecture/multi-provider-routing-and-auth.md`: instruction baseの記述を上記へ整合。
- `roadmap.md`: 「managed Henji base instruction」節（F03／F06／F24）を新contractへ更新。E2のmanaged resource
  kind候補から`henji-instruction`を外す。F27（`/rebuild`）の対象からmanaged instruction activationを外す。
- `README.md`: `instruction install|list|inspect|activate|deactivate|uninstall`の記載を、外部ファイル運用へ更新。

## 実装範囲

1. `v0/agent/instructions/henji_common.ts`: `HENJI_COMMON_INSTRUCTION`を最小coreへ縮小。
2. 新モジュール`v0/agent/instructions/base_instruction.ts`（`managed_instruction.ts`を置換）:
   - `HENJI_BASE_INSTRUCTION_SLOT`、`SelectedHenjiBaseInstruction`、`builtinHenjiBaseInstruction()`、
     `validateSelectedHenjiBaseInstruction()`、`verifyBuiltinHenjiBaseInstructionIdentity()`。
   - `resolveHenjiBaseInstruction(configRoot)`: `${configRoot}/instruction.md`をUTF-8で読み、存在すれば
     `selectionSource:'external'`、`ref:{resourceKind:'henji-instruction', resourceId:'user/instruction.md',
     revision:{algorithm:'sha256', digest: sha256(content)}}`、`contentDigest`、byte-equivalent contentを返す。
     存在しなければ`builtinHenjiBaseInstruction()`。NotFound以外のread失敗と空contentはturn開始前に失敗させる
     （暗黙fallbackしない）。trim・改行変換・Unicode normalizationはしない。
   - managed store／activation／install／list／inspect／uninstallの関数を削除。
3. `v0/agent/cli/instruction_cli.ts`を削除し、`v0/agent/cli/henji_cli.ts`から`instruction` subcommandを除去。
4. import更新: `worker_core_finalizer.ts`、`worker_tui_session.ts`（`resolveHenjiBaseInstruction`呼び出し）、
   `worker_bootstrap.ts`、`worker_agent_api.ts`、`worker_host_contract.ts`、`worker_protocol.ts`、
   `worker_execution_artifact.ts`、`worker_runtime.ts`、`worker_definition_revision.ts`（instruction参照があれば）。
5. `v0/agent/definitions/managed_resource_ref.ts`: `HenjiInstructionRevisionRef`はattributionで使うため維持。
6. 雛形`docs/`（例: `docs/operations/base-instruction-template.md`または`instruction/henji-base.md`）へ
   移した段落を記録。
7. focused test。

## 検証

- focused test:
  - built-inが最小core（役割＋credential）で、成果物忠実性／tool再利用／順序方針を含まないこと。
  - `resolveHenjiBaseInstruction`が外部ファイルを読み、`selectionSource:'external'`、resourceId
    `user/instruction.md`、content digest、byte-equivalent contentを返すこと。
  - 外部ファイル無しでbuilt-in coreへfallbackすること。空content・read失敗で明示的に失敗すること。
  - 合成system instructionの先頭がselected baseで、Definition contributionが続くこと
    （`finalizeWorkerInstructionComposition`）。
  - `verifyBuiltinHenjiBaseInstructionIdentity()`が成立すること（digest再計算）。
- 既存test更新: `increment_51_managed_instruction_test.ts`（managed install/activate）を削除。
  `increment_102_instruction_order_test.ts`は、順序方針が外部雛形側に移るため、built-in最小coreと
  雛形内容の検証へ作り替える。`increment_16`のplanner role assertionは不変。
- `deno check --config deno.v0.json`、`v0:fmt`、`v0:lint`、`git diff --check`。
- authoritative `v0:gate`はcoordinating ownerが安定候補に対し1回。
- rebuild・配置後、実経路でstartup headerの`base instruction:`が外部ファイルのdigestを示し、
  実turnのsystem instruction先頭に外部contentが入ることを確認する（実provider callは承認時のみ）。

## 未確認事項

- 外部ファイルのサイズ上限・非UTF-8・改行種別の扱い（byte-equivalentを維持するため、decodeのみで正規化しない。
  上限はmanaged contentの既存上限を踏襲するか採用時に決める）。
- 外部ファイルが無い既定での挙動変化（詳細方針が適用されない）は利用者判断で受容する。

## 対象外

- instructionの自己改訂候補生成・採用（R4、F24）。
- `/rebuild`（F27）。
- workspace `AGENTS.md`／Skill discoveryの変更。
- managed Skill／tool Definition等他kind。
