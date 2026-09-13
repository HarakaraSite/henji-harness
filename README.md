# Henji Harness

Henji Harnessは、Denoで開発しているローカル実行向けのagent harnessである。対話型TUIと非対話実行、
Session履歴、切り替え可能なproviderとmodel、TypeScriptによるAgent Definitionを一つのstandalone
executableから利用できる。Henjiという名前は、日本語の「返事」に由来する。

現行のHenji runtimeでは、HostがTUIとheadless Surface、Worker lifecycle、SQLiteへ保存する履歴、Sessionで
使用するexact Agent Definitionの選択を担う。headlessなAgent Workerは、built-inまたはinstall済みの信頼された
TypeScript Definitionを評価し、現在のmodel、instructions、tools、同期planner delegationを構成する。一般的な
Surfaceの置換、durable AgentInstanceのrevision transition、Definitionから構成可能なcontextとloopはまだ実装して
いない。

長期的には、実際の利用経験から改訂候補を作り、人間が明示的に採用する自己改訂workflowを目指している。
この自己改訂workflowはまだ実装していない。

## 開発状況

現在は0.xの開発版であり、CLI、保存形式、Agent Definition APIを含む破壊的変更がしばしば入る。
既存SessionやDefinitionのmigration、旧形式の互換読込を提供しないこともある。利用時はversionを固定し、
更新前に変更内容を確認すること。

## Quick Start

現在のcheckoutはDeno 2.9.6を使用する。Denoの導入方法は
[公式installation guide](https://docs.deno.com/runtime/getting_started/installation/)を参照する。

```sh
git clone https://forge.harakara.site/littleisland/henji-harness.git
cd henji-harness
deno task --config deno.v0.json henji:compile
./dist/henji --version
```

既定providerのOpenRouter API keyを、所有者だけが読めるfileへ保存する。

```sh
henji_config_dir="${XDG_CONFIG_HOME:-$HOME/.config}/henji-harness"
install -d -m 700 "$henji_config_dir"
install -m 600 /path/to/your/openrouter-api-key "$henji_config_dir/openrouter-api-key"
```

作業対象のdirectoryでTUIを起動する。promptを入力してEnterで送信し、`/help`でcommandを確認できる。

```sh
cd /path/to/your/workspace
/path/to/henji-harness/dist/henji
```

非対話実行と保存済みSessionの一覧も同じbinaryから利用できる。

```sh
printf 'READMEを要約して\n' | /path/to/henji-harness/dist/henji run
/path/to/henji-harness/dist/henji run --task 'このworkspaceの構成を説明して'
/path/to/henji-harness/dist/henji sessions list
```

OpenAI directを使う場合は同じconfig directoryの`openai-api-key`へkeyを保存し、
`henji --root-provider openai`で起動する。

## 現在使える主な機能

- TUIとheadlessな`run`
- OpenRouterとOpenAI directのprovider・model・reasoning effort切替
- SQLiteへ保存するSession、会話履歴、失敗・中断を含む実行記録
- `/new`、`/sessions`、`/history`、`/recall`などのTUI command
- TypeScript Agent Definitionのinstall、versioned revision、export/import、実行
- `AGENTS.md`とworkspace/user scopeのZot、Claude、Agents互換Skillの読込み

runtime配置は、credential値を表示しない`henji diagnostics runtime`で確認できる。既定ではconfigを
`${XDG_CONFIG_HOME:-$HOME/.config}/henji-harness`、managed dataを
`${XDG_DATA_HOME:-$HOME/.local/share}/henji-harness`、Session stateを
`${XDG_STATE_HOME:-$HOME/.local/state}/henji-harness`へ保存する。

## Agent Definition

local TypeScript Agent Definitionは、実行前にmanaged dataへinstallする。installされたrevisionはimmutableで、
実行時にexact revisionを指定する。

```sh
./dist/henji module install ./agent/entry.ts --id team/answer-agent
./dist/henji module list
./dist/henji --definition-revision team/answer-agent@sha256:<full-digest>
```

詳細な設計と実装状況は[構想](docs/concepts/experience-driven-self-revision.md)、
[architecture](docs/architecture/henji-host-agent-worker.md)、[roadmap](docs/roadmap.md)を参照する。

## JSR package

[`@henji/harness`](https://jsr.io/@henji/harness)は、TypeScriptのAgent Definitionを組み立てるための
composition APIを公開する。JSRからnative binaryは配布しない。CLIを使う場合はrepository checkoutから
buildする。

0.xではAPIやcontractが互換性なく変わることがあるため、exact versionを指定する。

```sh
deno add --save-exact jsr:@henji/harness@0.1.3
```

```ts
import {
  createDefaultAgentComposition,
  type ExecutableAgentDefinition,
} from 'jsr:@henji/harness@0.1.3';

const definition: ExecutableAgentDefinition = (input) =>
  createDefaultAgentComposition(input);

export default definition;
```

`createPlannerAgentComposition`も同じ入力境界でplanner Definitionを構成できる。

## Links

- [Source: Forgejo](https://forge.harakara.site/littleisland/henji-harness)
- [Package: JSR](https://jsr.io/@henji/harness)

## License

MIT
