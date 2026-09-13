# Henji Harness

Henji Harnessは、実際の利用経験から自身の機能を継続的に改訂できるDeno agent harnessを目指す。
通常利用の経験を保存し、人間の指示を契機にWorker内AIが改訂候補を作る。
候補は人間の採用アクションまたは明示的承認によってのみ採用され、その後の通常利用へ戻る。 Henji
HostはSurface、lifecycle、storage、revisionを担い、headless Agent
WorkerがDefinitionを合成・実行する。

Production TUIでは、idle時の`/provider`でOpenRouterとOpenAI directを切り替え、`/model`でactive
providerのcurated modelを検索・選択し、`/effort`でreasoning effortを別に変更できる。provider変更はその
providerのdefault model/effortを一度に適用し、各選択は同じSessionの次のroot turnから有効になる。`/sessions`は
更新日時、手動title、短縮Session ID、turn数を表示し、`/rename <title>`でcurrent Sessionへtitleを付けられる。
`/new`はprocessを終了せず、current exact Definitionとroot provider/model/effortを引き継いだturn 0の新しい
persistent Sessionを同じworkspaceに作成して切り替える。busy中は`/new`をeditorに残してready後の再Enterを待ち、
`--no-session`では利用できない。`/new`自体はproviderへ送信しない。
provider/model/effortは一覧には表示しないがSessionと一緒に復元する。delegated plannerはrootの選択を継承せず、
planner defaultを使う。footerは1段目へbusy開始からの経過時間を含む一時的なstatus、2段目へcwd、Session短縮ID、
現在のroot provider/model/effortを常時表示する。

停止したturnの保存済み実行情報は、idle時の`/recall`でcurrent Session内の最新executionを、
`/recall <execution-id>`で8文字以上の一意なID prefixまたは完全IDを選び、次の通常taskだけへ参照contextとして渡せる。
`/recall`はsource turnをcommitせず、source toolを自動再実行しない。`--no-session`では利用できない。
一方`/recover`は、送信に失敗した入力文をeditorへ戻して人間が編集・再送する操作であり、execution情報をAIへ渡す
`/recall`とは別の機能である。

root providerは既定のOpenRouterに加え、起動時に`henji --root-provider openai`でOpenAI direct
Responses APIを選べる。OpenAI Platform API keyは
`${XDG_CONFIG_HOME:-$HOME/.config}/henji-harness/openai-api-key`からrequest時に読み、OpenRouterを使うdelegated
plannerとSonar `web_search`は従来のOpenRouter credentialを独立して使う。同一Session内のprovider切替UIは
`/provider`から利用できる。OpenAIの初期curated listは`gpt-5.6-sol`、`gpt-5.6-luna`、
`gpt-5.6-terra`、`gpt-6-astra`である。

OpenRouter requestのdeadlineはTUI起動時の`--provider-timeout-ms N`で変更でき、未指定時は120,000 msである。
同じ起動内のroot、delegated planner、context compactionへrequest単位で適用し、Sessionには保存しない。
deadline到達時は`provider deadline exceeded`と表示し、自動retryやmodel fallbackは行わない。

## Standalone executable

Deno 2.9.4を使うLinux ARM64の開発checkoutでは、次のcommandでrepositoryや別途導入したDenoへruntime依存
しない単一executableを作れる。

```sh
deno task --config deno.v0.json henji:compile
```

既定outputは`dist/henji`で、`--output /path/to/henji`をtask引数として指定できる。完成したbinaryは任意pathへ
移動でき、TUI、`run`、`sessions`、`diagnostics`、`--version`を同じentryから提供する。build taskは既存の
installed `henji`を自動置換しない。

```sh
./dist/henji --version
./dist/henji diagnostics runtime
printf '依頼内容\n' | ./dist/henji run
./dist/henji sessions list
```

### Managed Agent Definition lifecycle

任意pathにあるstatic local TypeScript Agent Definitionは、実行前にHenjiのmanaged dataへinstallする。installは
sourceを実行せず、entryとrelative `.ts` dependencyのclosure、declared role、現在の`@henji/agent` API contractを
一つのimmutable revisionとして保存する。既定のmodule rootはentryの親directoryで、より上位のrootが必要な場合は
`--root`を指定する。

```sh
./dist/henji module install ./agent/entry.ts --id team/answer-agent
./dist/henji module install ./planner/entry.ts --id team/planner --role planner
./dist/henji module list
./dist/henji module inspect --id team/answer-agent --revision sha256:<full-digest>
```

managed storeにある一つのexact revisionは、一つのJSON artifactとして別installationへ移せる。exportは元sourceを
再読込せず、full exact refだけを受け取る。outputが存在する場合は上書きしない。

```sh
./dist/henji module export team/answer-agent@sha256:<full-digest> \
  --output ./answer-agent.henji.json
XDG_DATA_HOME=/path/to/other/data \
  ./dist/henji module import ./answer-agent.henji.json
```

artifactにはportable manifest、最初のsource origin lineage、closure全fileのexact bytesが含まれる。export元のlocal
custody、XDG root、credential、Session、workspace state、Henji binary、built-in Definition、active bindingは含まれない。
import先では同じlogical refとmanifestを保持しながら、artifact pathとimport日時を新しいlocal custodyとして記録する。
export/importはactivationを行わないため、実行時は従来どおり`--definition-revision`へexact refを指定する。

現在のbinaryがsupportしないDefinition API contractを持つ正しいartifactも、custody目的でimport、list、inspect、再export
できる。そのexact revisionを実行しようとした時点でのみcompatibility errorとなり、built-inや別revisionへfallbackしない。

`install`のJSON結果にある`manifest.logicalRef`が実行identityである。activationはinstallとは別で、module IDとfull
64桁digestを明示して新しいTUI Sessionまたは非対話turnを開始する。`--agent default|planner`はbuilt-in専用で、
`--definition-revision`とは同時指定しない。

```sh
./dist/henji --definition-revision team/answer-agent@sha256:<full-digest>
./dist/henji run --task '依頼内容' \
  --definition-revision team/answer-agent@sha256:<full-digest>
```

closure内で使えるmodule edgeはrelative `.ts`のstatic import/exportと、binaryが提供するexact
`@henji/agent`だけである。dynamic import、remote URL、JSR、npm、absolute import、その他のbare specifierは
このmanaged lifecycleでは扱わない。install後の実行はmanaged copyだけを使うため、元sourceを変更・削除しても
保存済みexact revisionは変わらない。編集したsourceの再installは同じmodule IDに別revisionを追加し、既存revisionを
置換しない。

identity manifestとclosureは`${XDG_DATA_HOME:-$HOME/.local/share}/henji-harness`に保持する。`module inspect`が示す
origin lineage、local custody、physical store pathは診断情報であり、logical refやrevision digestには含まれない。
Sessionは選択したexact refへbindされ、欠損・破損・API非互換・role不一致・Definition評価失敗時にbuilt-inや別revisionへ
fallbackしない。

runtime配置は`diagnostics runtime`からcredential値を含めず確認できる。configは
`${XDG_CONFIG_HOME:-$HOME/.config}/henji-harness`、managed dataは
`${XDG_DATA_HOME:-$HOME/.local/share}/henji-harness`、Session、execution、provider evidence、診断stateは
`${XDG_STATE_HOME:-$HOME/.local/state}/henji-harness/v1/<workspace-digest>/history.sqlite3`がauthorityである。
旧JSON stateは移行・変換・互換読込せず、削除もしない。新binaryのSession、`/recall`、`/history export`、
`sessions`、`diagnostics`はSQLiteだけを使い、SQLite unavailable、未知schema、破損時も旧JSONへfallbackしない。
同じSessionのwriter exclusionを維持し、異なるSession間の短いSQLite write競合は250 msまで待つ。workspace
`AGENTS.md`とworkspace/user scopeのZot、Claude、Agents互換
Skillはinstallなしに発見する。

SQLiteのschema v3では、turnをWorkerへ送る前にactive executionとgeneration context basisがdurableになる。各実行の
instruction、skill catalog、loaded skill、runtime fact、model-facing tool contract、ordered model requestはcontent
descriptorとして保存され、`discovered`、`resolved`、`loaded`、`observed`、`projected`を別のrelationで追跡する。
`diagnostics executions context --id <execution-id>`はsnapshotとrelationsを、`diagnostics executions request --id <execution-id> --ordinal N`
は再構成可能なrequestとlinked provider evidenceをreadbackする。`show`と`events`は従来どおりexecution row、effect
projection、DB採番ordinal順のcredential-free raw journalを表示する。process停止後のactive executionは
Sessionまたはno-sessionのlock内でinterrupted/unknownへreconcileされ、保存済みcontextだけをpartialとして保持する。
normal settlementはjournalと最終manifestを照合してcompleteを確定し、停止したeffectやprovider requestを自動replayせず、
過去のcanonical conversationも変更しない。schema v1/v2 stateはmigration・互換読込せず`history_invalid`として拒否する。

現在は開発中であり、詳細は[構想](docs/concepts/experience-driven-self-revision.md)、[architecture](docs/architecture/henji-host-agent-worker.md)、[roadmap](docs/roadmap.md)を正本とする。

## JSR package

JSR packageは、信頼されたexecutable TypeScriptのAgent DefinitionをWorker内で組み立てるための
composition APIを公開する。Henji HostはSurface、lifecycle、storage、revision bindingを所有し、headlessな
Agent WorkerはDefinitionを評価してmodel、instruction、tool、delegation、context、loopを合成する。

安定版0.1では、開発中のCLI、TUI、Host、Session永続化、自己改訂workflowはpackage entrypointとして
含めない。自己改訂候補は将来も、人間の指示を契機として生成し、人間の明示的な採用または承認によってのみ
反映する。

```sh
deno add jsr:@henji/harness@0.1.0
```

```ts
import {
  createDefaultAgentComposition,
  type ExecutableAgentDefinition,
} from 'jsr:@henji/harness@0.1.0';

const definition: ExecutableAgentDefinition = (input) =>
  createDefaultAgentComposition(input);

export default definition;
```

`createPlannerAgentComposition`も同じ入力境界でplanner Definitionを構成できる。以後の互換性変更はSemVerに
従ってversionを更新する。

## Source

- [Forgejo: littleisland/henji-harness](https://forge.harakara.site/littleisland/henji-harness)
- [JSR: @henji/harness](https://jsr.io/@henji/harness)

## License

MIT
