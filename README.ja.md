# Henji Harness

[English](README.md) | 日本語

Henji Harnessは、Denoで開発しているローカル実行向けのagent harnessである。単体のstandalone
executableから、対話型TUIと非対話実行、Session履歴、切り替え可能なproviderとmodel、JSONによるAgent
設定、folder-based toolを利用できる。Henjiという名前は、日本語の「返事」に由来する。

現行のHenji runtimeでは、HostがTUIとheadless Surface、Worker lifecycle、SQLiteへ保存する履歴、
Sessionで使用する現在のJSON Agent設定の選択を担う。headlessなAgent Workerは、選択された設定を現在の
model、共通instructions、具体的なtoolと組み合わせる。Agentは`agents`
listで子Agentを宣言でき、modelは `spawn_subagent`で別Deno
Worker・別Executionのchildを起動し、`collect_subagent`でchild結果を取り込む （V1
fork/join）。一般的なSurfaceの置換とdurable AgentInstanceのrevision transitionはまだ実装していない。

長期的には、実際の利用経験から改訂候補を作り、人間が明示的に採用する自己改訂workflowを目指している。
この自己改訂workflowはまだ実装していない。

## 開発状況

現在は0.xの開発版であり、CLI、保存形式、設定contractを含む破壊的変更がしばしば入る。既存Sessionや設定
formatは自動migrationしない。利用時はversionを固定し、更新前に変更内容を確認すること。

## Quick Start

現在のcheckoutはDeno 2.9.7を使用する。Denoの導入方法は
[公式installation guide](https://docs.deno.com/runtime/getting_started/installation/)を参照する。

```sh
git clone https://forge.harakara.site/littleisland/henji-harness.git
cd henji-harness
deno task --config deno.v0.json henji:compile
./dist/henji --version
deno task --config deno.v0.json henji:package
# 上のcommandが出力したpackage directoryでinstall.shを実行する。
```

packageは編集可能な`search`、`git_inspect`、`web_search`、`web_fetch`のtool folderと
`runtime-start-time`
hookを含む。package内の`install.sh`でbinaryの配置、tool登録、既定hookの有効化を
行う。本文検索はrgを優先し、不在時にgrepを使う。`git_inspect`はworkspaceのrepositoryを
read-onlyで調べる。既存の外部sourceは対応する
`--replace-tools`または`--replace-hooks`を指定しない限り維持する。配置先等は
[package手順](external-tools/README.md)を参照する。

利用できるcommandとoptionは`henji --help`と`henji COMMAND --help`で確認できる。

既定providerのOpenRouter API keyを、所有者だけが読めるfileへ保存する。credential値はconfig root
ではなくstate配下のcredential rootへ置く。

```sh
henji_credential_dir="${XDG_STATE_HOME:-$HOME/.local/state}/henji-harness/v1/credentials"
install -d -m 700 "$henji_credential_dir"
install -m 600 /path/to/your/openrouter-api-key "$henji_credential_dir/openrouter-api-key"
```

TUIの`/login`からもproviderとserviceのcredentialを同じcredential fileへ登録できる。ChatGPTの
sign-inもこの一覧にあり、認証情報（`chatgpt/`配下のtokenを含む）は同じcredential rootへ保存される。
`web_search`用のExaもこの一覧に含まれる。

外部toolは`$henji_config_dir/credentials/*.json`へservice登録のmetadataを追加できる（宣言は
非secretで、値はcredential root側に保存される）。たとえばBrave
toolは次のように宣言する。

```json
{
  "schemaVersion": 1,
  "authProfile": "brave-api-key",
  "label": "Brave — API key",
  "purpose": "Web search",
  "method": "api-key",
  "consumers": ["tool:brave_search"]
}
```

この宣言は表示用metadataであり、key値を含まない。宣言を変更したらCoreを再起動し、`/login`でkeyを
保存・更新する。同じ`authProfile`を共有するentryは1回の登録と1つのcredential fileを使う。serviceの
entryはmodel providerの一覧には現れない。

外部toolは宣言した`authProfile`を指定して`requestProvider`を使う。認証は既定でBearerであり、Braveの
ようなserviceはrequestへ`authentication: { kind: 'header', name: 'X-Subscription-Token' }`を設定
できる。keyの解決と挿入はdispatcherが行うため、tool factoryがkey値を受け取ることはない。この宣言は
credentialを登録するものであり、service側のrequest動作は外部toolが供給する。

作業対象のdirectoryでTUIを起動する。promptを入力してEnterで送信し、`/help`でcommandを確認できる。

```sh
cd /path/to/your/workspace
/path/to/henji-harness/dist/henji
```

非対話実行、保存済みSessionの一覧、保存履歴の閲覧も同じbinaryから利用できる。

```sh
printf 'READMEを要約して\n' | /path/to/henji-harness/dist/henji run
/path/to/henji-harness/dist/henji run --task 'このworkspaceの構成を説明して'
/path/to/henji-harness/dist/henji run --task 'このworkspaceの構成を説明して' --json
/path/to/henji-harness/dist/henji run --task 'このworkspaceの構成を説明して' --stream
/path/to/henji-harness/dist/henji sessions list
/path/to/henji-harness/dist/henji history --latest
```

`run`は既定でfinal textのみをstdoutへ出す。`--json`はturn中のeventを1行1
JSON（NDJSON、`{"v":1,"kind":...}`） でstdoutへ出し、最後に`result`
recordを出す。`--stream`はassistant textをstdoutへ逐次、tool activityの要約を
stderrへ出す。`--json`と`--stream`は排他。未知の`kind`は無視してよい。`--json`は単一objectを返す
`tool --json`とは異なる。

非TTYのcallerから `run` を呼ぶときはtaskをstdinから渡す。`--task` はTTYで利用する。

```sh
printf 'このworkspaceの構成を説明して\n' | /path/to/henji-harness/dist/henji run --json
```

providerは`/provider`、modelは`/model`、reasoning effortは`/effort`で切り替える。OpenAI directを
使う場合は同じcredential rootの`openai-api-key`へkeyを保存し、Responses APIなら
`henji --root-provider openai-responses`、Chat Completionsなら`henji --root-provider openai-chat`で
起動する。ChatGPTは`/login`のsign-inで登録し、`openai-chatgpt`を選ぶ。OpenRouterは既定の
`openrouter-chat`と、同じ`openrouter-api-key`を使う`openrouter-responses`を選べる。
`providers/*.json`のdata-only declarationで、対応protocolを使う別provider IDも追加できる。

## CLI commands

`henji --help`が示すcommandは次のとおり。

- `henji tui` — TUIを接続する。引数なしの`henji`と同じで、対象がなければ新しいCoreを起動する
- `henji serve` — UIを持たないCoreをforegroundで実行する
- `henji core list | status | stop` — このworkspaceのCoreを一覧・照会・停止する
- `henji run` — localのheadless Hostで1 taskを実行する
- `henji history` — localまたは`--connect URL`で保存履歴を読む
- `henji sessions list | delete --session ID --yes` — 保存済みSessionを管理する
- `henji agent list | inspect | activate | deactivate` — 現在のJSON Agent設定を選択・確認する
- `henji tool list | inspect | activate | deactivate` — 外部tool folderを選択・確認する
- `henji diagnostics runtime | list | latest | show | delete | executions` —
  runtime配置と診断情報を読む
- `henji webui` — 将来のWebUI用に予約されており、現在は利用できない

`tui`・`serve`・`run`は`--agent NAME`または`--agent-file FILE`、`--max-steps N`、
`--provider-timeout-ms MS`、`--root-provider ID`も受け付ける。

## 複数Coreの並行利用と明示的な再接続

同じworkspaceで `henji` や `henji tui` を起動するたびに、新しいCoreとSessionを作る。
二つのterminalで独立した仕事を並行に進め、画面上のCore IDとSession IDで識別できる。
`henji serve`は、指定しない限りSessionを開かず、foregroundで新しいCoreを起動する。

```sh
henji core list
henji --core <core-idまたは一意なprefix>
henji --core <core-id> --new
henji --session <saved-session-id>
henji core status --core <core-id> --json
henji core stop --core <core-id>
```

`/detach`・Ctrl-DでTUIをdetachしても、Coreと受付済みの仕事は継続する。
`/quit`・Ctrl-Qは接続先Coreを停止し、清算後にTUIも終了する。実行中の仕事も停止対象となる。
`/s`等のスラッシュ＋最初の文字からコマンド候補を表示し、一つに絞れた候補はTabで補完できる。
再接続はCore IDまたは `--connect URL` で明示する。 Core指定なしの `--session`
は保存Sessionを新Coreで再開する。対象を省略した `core stop` は一覧と指定方法だけを表示する。
履歴DB・config・credentialは共有し、稼働Sessionのmodel選択と各Coreの親子agent・tool管理は独立する。
`henji run` はHTTP Coreとは別のheadless入口を維持する。
詳しい操作は[HTTP API](docs/operations/http-api.md)を参照する。

## 現在使える主な機能

- TUIとheadlessな`run`
- OpenRouter（Chat Completions/Responses）、OpenAI direct（Responses/Chat Completions）、ChatGPT
  sign-inのprovider・model・reasoning effort切替、providerの現行model一覧とお気に入り
- SQLiteへ保存するSession、会話履歴、失敗・中断を含む実行記録
- `/new`、`/sessions`、`/view`、`/resume`、`/context`、`/rename`、`/recall`、`/provider`、`/model`、
  `/effort`、`/login`、`/detach`、`/quit`などのTUI command
- `agents.json`で現在fileを選ぶJSON Agent設定と、`agents` listによる子Agent
- JSON metadataとlocal importを使うfolder-based toolと、CLIからのAgent・tool設定管理
- Henji base instructionのuser file読込みと実行時attribution
- `AGENTS.md`とworkspace/user scopeのZot、Claude、Agents互換Skillの読込み

runtime配置は、credential値を表示しない`henji diagnostics runtime`で確認できる。既定ではconfigを
`${XDG_CONFIG_HOME:-$HOME/.config}/henji-harness`、managed dataを
`${XDG_DATA_HOME:-$HOME/.local/share}/henji-harness`、Session stateを
`${XDG_STATE_HOME:-$HOME/.local/state}/henji-harness/v1`、credential値を
`${XDG_STATE_HOME:-$HOME/.local/state}/henji-harness/v1/credentials`へ保存する。

## Agent設定とtool

Agentの挙動は、Henji config directory配下のJSON fileで定義する。`agents.json`は現在の既定fileと、
名前付きAgentとその現在fileの対応を選ぶ。

```json
{
  "schemaVersion": 1,
  "default": "agents/my-root.json",
  "agents": { "reviewer": "agents/reviewer.json" }
}
```

Agent JSONは`name`、任意の`revision`、`instruction`、`tools`、`agents`を持つ。既定fileが選択されて
いなければ同梱の既定を使う。Agent指定を省略するとrootの既定を選び、名前を明示するとそのcatalog entry
（名前付きの`default`を含む）を選ぶ。`generic` childは同梱設定を自分の名前で使い、名前付きAgentの
instructionを継承しない。設定fileはWorker起動ごとに読み直すため、編集は新しく開始する仕事へ反映される。

同梱default/genericは6つの標準work
tool、`read`、`write`、`edit`、`bash`、`bash_output`、
`run_typescript`を選ぶ。明示したAgentの`tools`一覧で使うには`run_typescript`を加える。空配列は空のままとする。

`run_typescript`はHenjiに埋め込んだDeno runtimeで、async
TypeScript関数の本文を実行する。 呼出しごとに同じHenji
binaryの子processを使い、取消時は同期計算中でもprocessの停止・清算を待つ。
`input`は任意JSON（省略時`null`）、`workspace`はworkspaceの絶対pathである。workspaceと`/tmp`の
read/write、code自身のnetwork利用を許可する。code
Workerのenv/run/sys/ffiは無効とする。
JSON値を`return`して結果を返す。returnがなければ`null`となる。Deno
stdと依存moduleは `await import()`から実行時に取得し、外部Deno
CLIの導入やstdの事前同梱を要求しない。
importは`jsr:@std/...`と`https://jsr.io/@std/...`のsourceと依存stdに限定する。
他package、Node組込み、local file
moduleは拒否し、import制限を継承しない追加Workerの作成も不可とする。
通常の`fetch()`とJavaScriptの`eval()`は引き続き使える。

例えば次のtool引数でCSV inputを解析し、結果をfileへ保存できる。

```json
{
  "code": "const csv = await import('jsr:@std/csv'); const rows = csv.parse(input, { skipFirstRow: true }); await Deno.writeTextFile(workspace + '/rows.json', JSON.stringify(rows)); return rows;",
  "input": "name,value\na,42\n"
}
```


```sh
henji agent list
henji agent inspect --name reviewer
henji agent activate --file agents/reviewer.json --name reviewer
henji agent deactivate --name reviewer
```

`tools.json`はtool名をfolderへ対応付ける。各folderは、一致する名前、任意のrevision label、API
contract`henji-tool/v1`、entry moduleを持つ`tool.json`を含む。

```json
{ "schemaVersion": 1, "tools": { "marker": "tools/marker" } }
```

```json
{ "name": "marker", "revision": "local-1", "apiContract": "henji-tool/v1", "entry": "index.ts" }
```

entry moduleのdefault exportはtool
factoryである。factoryはWorker起動時に一度実行され、同じfolder内の
別fileをimportできる。Agentが選んだtoolにfolder mappingがある場合、その名前の同梱実装を置き換える。

```sh
henji tool list
henji tool inspect --name marker
henji tool activate --name marker --folder tools/marker
henji tool deactivate --name marker
```

## 外部hook

packageは`hooks.json`を作り、既定hookに`runtime-start-time`を選ぶ。このhookはWorkerの開始日時、
timezone、UTC offsetをAgent共通contextへ追加する。新しいWorkerごとに開始日時を取得する。 TypeScript
sourceは `${XDG_CONFIG_HOME:-$HOME/.config}/henji-harness/hooks/runtime-start-time/`で編集できる。
起動済みWorkerは読み込み済みhookを使い続け、編集は新しいWorkerで反映される。

`hooks.json`は共通の既定一覧とhook名からTypeScript entryへの対応を定義する。Agent JSONで`hooks`を
省略すると共通の既定を使い、順序付き配列を指定すると既定を置き換える。`[]`なら外部hookを無効にする。

```json
{
  "schemaVersion": 1,
  "default": ["runtime-start-time"],
  "hooks": {
    "runtime-start-time": "hooks/runtime-start-time/index.ts"
  }
}
```

1つのAgentだけ別hookを選ぶには、そのAgent JSONへ`"hooks": ["my-hook"]`を追加し、共通catalogへ
`my-hook`のpathを登録する。再installではhook sourceの編集とcatalogを保持する。
`./install.sh --replace-hooks`を指定した場合は配布sourceをコピーするが、catalogは保持する。
installerはAgent
JSONを書き換えない。詳細は[hook package手順](external-tools/README.md#runtime-hooks)を参照する。

runtimeは新しい`history.sqlite3` databaseを使う。以前のhistory databaseはmigrationせず、既存fileは
利用者がそのまま参照できる形で残す。

## Henji Instruction

Henji共通のbase instructionは、最小のbuilt-in
core（役割identityとcredential/Authorization境界）を既定で
使う。詳細な作業方針は、次のuser-scopedファイルへ置くだけで読み込まれる（installやactivateは不要）。

```text
${XDG_CONFIG_HOME:-$HOME/.config}/henji-harness/instruction.md
```

ファイルが存在すればbuilt-in
coreを置き換え、存在しなければ最小coreを使う。内容はtrim・改行変換・Unicode
normalizationをせずbyte-equivalentに扱い、source identity（`user/instruction.md`）とcontent
digestとして execution
attributionへ記録する。ファイルが読めない場合や内容が不正な場合は、built-inへ暗黙fallbackせず
turn開始前に失敗する。

推奨する詳細方針の雛形は
[`docs/operations/base-instruction-template.md`](docs/operations/base-instruction-template.md)にある。

詳細な設計と実装状況は[構想](docs/concepts/experience-driven-self-revision.md)、
[architecture](docs/architecture/henji-host-agent-worker.md)、[roadmap](docs/roadmap.md)を参照する。

## JSR package

[`@henji/harness`](https://jsr.io/@henji/harness)は、TypeScriptのtool factory
APIを公開する。JSRからnative binaryは配布しない。CLIを使う場合はrepository checkoutからbuildする。

`jsr:@henji/harness@0.9.0/hooks`から`HookFactory`とhook lifecycleのcontractをimportできる。

0.xではAPIやcontractが互換性なく変わることがあるため、exact versionを指定する。

```sh
deno add --save-exact jsr:@henji/harness@0.9.0
```

```ts
import type { ToolFactory } from 'jsr:@henji/harness@0.9.0';

const marker: ToolFactory = ({ workspace }) => ({
  name: 'marker',
  description: `Mark files in ${workspace.root}`,
  inputSchema: { type: 'object' },
  execute: () => 'ok',
});

export default marker;
```

`ToolFactory`と`ToolFactoryInput`は`jsr:@henji/harness@0.9.0`からimportする。単体binaryは既定の
Agentとcore toolを同梱する。`search`、`git_inspect`、`web_search`、`web_fetch`はpackageの編集可能なfolderを
installerで登録する。名前付きのAgentとtool fileはconfig directoryから選択する。

## Links

- [Source: Forgejo](https://forge.harakara.site/littleisland/henji-harness)
- [Package: JSR](https://jsr.io/@henji/harness)

## License

MIT
