# Increment 102 — 外部integration依頼の調査順序方針（A9）

ステータス: **実装・検証完了（offline v0:gate exit 0、binary配置済み）**

計画日: 2026-09-22

関連: [`experience/normal-use-inbox.md`](../experience/normal-use-inbox.md) A9、
`v0/agent/instructions/henji_common.ts`、`v0/agent/instructions/roles/planner.ts`、
[`architecture/multi-provider-routing-and-auth.md`](../architecture/multi-provider-routing-and-auth.md)、
Increment 101（OpenCode Go対応）、Increment 51（managed Henji base instruction）。

## 利用者が必要とする動作

- 外部service/provider/API/dependencyの追加・統合を依頼されたとき、Henjiはまず公式contract（docs/API）を
  確認し、既存のconfiguration・declaration・dataで要求を満たせるかを判定して報告する。実装内部の調査は、
  既存設定では満たせない場合、または利用者が実装について明示的に尋ねた場合に限る。
- 実装が必要な場合も、要求を満たす最小の変更を選ぶ。
- 上記は実経路（production TUI、実provider）で観察できる。

## 背景（観測）

- Session `c7c7a106`のturn 13「プロバイダにopencode goを追加したい」と同種のturn 15で、modelは
  外部API調査と並行して実装内部（credential resolver、transport/request/contract、`worker_physical_io.ts`、
  `loop.ts`、`worker_protocol.ts`等）を深く読み、`delegate_to_planner`で実装計画まで進めた。利用者は5〜7分で
  キャンセルし「何を調査している？」と聞き返した。両turnは`turn_cancelled`／`non_canonical`で記録された。
- Increment 101で、OpenCode Goは「official docsのroute表＋`providers/*.json`宣言＋credential file」で
  追加でき、実装内部の変更はauth profile一般化とheader seamだけで足りることが実証された。つまり
  「先に外部contractと既存設定の十分性を確認する」順序が実際に有効である。
- 現行の共通instructionは成果物の忠実性、tool結果の再利用、credentialを規定するが、設定・外部契約の
  十分性を先に確認し最小十分な変更を選ぶ方針を持たない。planner roleは"context needed for the task"のみで
  調査範囲が実質無制限。

## 決定（利用者判断 2026-09-22）

- 共通instruction（`HENJI_COMMON_INSTRUCTION`）に、外部integration依頼の調査順序とsmallest-sufficient方針の
  段落を追加する。
- planner role（`PLANNER_AGENT_INSTRUCTION`）を、最小十分な変更を決めるのに必要な範囲だけ調べる文言へ締める。

## 追加する文言（案）

`v0/agent/instructions/henji_common.ts`へ新しい段落を追加する（既存のtool再利用段落の後、credential段落の前）。

> Before changing implementation, check whether the request can be satisfied by existing configuration,
> declaration, or data. When the task is to add or integrate an external service, provider, API, or
> dependency, first obtain the external contract from official documentation and confirm which existing
> extension point covers it. Investigate implementation internals only when the external contract cannot
> be met through existing configuration, or when the user asks about the implementation. Prefer the
> smallest change that satisfies the request.

`v0/agent/instructions/roles/planner.ts`:

> You are the built-in planner agent. Inspect only the workspace context needed to decide the smallest
> sufficient change for the task, and produce a clear implementation plan. Do not mutate the workspace.

## 正本変更

- architecture・roadmapの変更は不要。instruction composition（Henji common／role／tool guideline／workspace／
  skill／runtime facts）とauthorityはIncrement 51から不変であり、今回変えるのはbuilt-in resourceの内容だけ。
- built-in instructionのrevision digestは内容から決まるため、内容変更に伴い更新する（下記）。

## 実装範囲

1. `v0/agent/instructions/henji_common.ts`: 上記段落を追加。
2. `v0/agent/instructions/roles/planner.ts`: 上記文言へ変更。
3. `v0/agent/instructions/managed_instruction.ts`: `BUILTIN_REVISION_DIGEST`と`BUILTIN_CONTENT_DIGEST`を
   新しい内容から再計算して更新する。
   - revision = sha256(`"henji-instruction-v1"` + `"\0"` + `HENJI_COMMON_INSTRUCTION`)
   - content = sha256(`HENJI_COMMON_INSTRUCTION`)
   - `verifyBuiltinHenjiBaseInstructionIdentity()`がtrueになることを確認する。
4. focused test: 合成system instructionが新方針文を含むこと、planner roleが新文言を含むこと、
   built-in instruction identity検証が成立することを確認する。
5. rebuild・`~/.local/bin/henji`配置。

## 検証

- focused test（instruction composition、built-in identity）。
- `deno check --config deno.v0.json`、`v0:fmt`、`v0:lint`、`git diff --check`。
- authoritative `v0:gate`はcoordinating ownerが安定候補に対し1回。
- rebuild・配置後、実経路の観察: 外部integration依頼（例: 既存providerへのmodel追加）で、modelが
  先にofficial contractと宣言十分性を確認する順序をとるかを通常利用で確認する。実provider callを伴う確認は
  対象・回数・保存先を提示して承認を得る。

## 未確認事項

- 文言の効果はmodel挙動依存で、offline testでは確認できない。通常利用で観察し、不十分なら文言を調整する。
- 既存testは`HENJI_COMMON_INSTRUCTION`／`PLANNER_AGENT_INSTRUCTION`を定数参照しており、内容変更で
  壊れない見込み（inclusion assertion）。hardcoded digestは`managed_instruction.ts`の2定数のみ。
- 現在activeなbase instructionはbuilt-in（`~/.config/henji-harness/instruction/active-v1.json`なし）で、
  外部instructionがactivateされていれば本変更は効かない。

## 対象外

- planner以外のroleやtool guidelineの文言。
- instructionのmanaged revision化・自己改訂（R4）。
- `/rebuild`（F27）。
