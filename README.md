# Henji Harness

Henji Harnessは、実際の利用経験から自身の機能を継続的に改訂できるDeno agent harnessを目指す。
通常利用の経験を保存し、人間の指示を契機にWorker内AIが改訂候補を作る。
候補は人間の採用アクションまたは明示的承認によってのみ採用され、その後の通常利用へ戻る。 Henji
HostはSurface、lifecycle、storage、revisionを担い、headless Agent
WorkerがDefinitionを合成・実行する。

Production TUIでは、`/model`でcurated OpenRouter modelを検索・選択し、`/effort`でreasoning effortを
別に変更できる。選択は同じSessionの次のroot turnから有効になり、`/sessions`でprovider/model/effortを表示して
Sessionと一緒に復元する。delegated plannerはrootの選択を継承せず、planner defaultを使う。footerは
1段目へ一時的なstatus、2段目へcwd、Session短縮ID、現在のroot model/effortを常時表示する。

root providerは既定のOpenRouterに加え、起動時に`henji --root-provider openai`でOpenAI direct
Responses APIを選べる。OpenAI Platform API keyは
`/home/masat.guest/.config/henji-harness/openai-api-key`からrequest時に読み、OpenRouterを使うdelegated
plannerとSonar `web_search`は従来のOpenRouter credentialを独立して使う。同一Session内のprovider切替UIは
次incrementで追加する。

OpenRouter requestのdeadlineはTUI起動時の`--provider-timeout-ms N`で変更でき、未指定時は120,000 msである。
同じ起動内のroot、delegated planner、context compactionへrequest単位で適用し、Sessionには保存しない。
deadline到達時は`provider deadline exceeded`と表示し、自動retryやmodel fallbackは行わない。

現在は開発中であり、詳細は[構想](docs/concepts/experience-driven-self-revision.md)、[architecture](docs/architecture/henji-host-agent-worker.md)、[roadmap](docs/roadmap.md)を正本とする。

## JSR package

JSR packageは、信頼されたexecutable TypeScriptのAgent DefinitionをWorker内で組み立てるための
composition APIを公開する。Henji HostはSurface、lifecycle、storage、revision bindingを所有し、headlessな
Agent WorkerはDefinitionを評価してmodel、instruction、tool、delegation、context、loopを合成する。

現在のpre-releaseに、開発中のCLI、TUI、Host、Session永続化、自己改訂workflowはpackage entrypointとして
含めない。自己改訂候補は将来も、人間の指示を契機として生成し、人間の明示的な採用または承認によってのみ
反映する。

```sh
deno add jsr:@henji/harness@0.1.0-alpha.4
```

```ts
import {
  createDefaultAgentComposition,
  type ExecutableAgentDefinition,
} from 'jsr:@henji/harness@0.1.0-alpha.4';

const definition: ExecutableAgentDefinition = (input) =>
  createDefaultAgentComposition(input);

export default definition;
```

`createPlannerAgentComposition`も同じ入力境界でplanner Definitionを構成できる。Pre-release中は、stable
releaseまでにAPIが変更される可能性がある。

## Source

- [Forgejo: littleisland/henji-harness](https://forge.harakara.site/littleisland/henji-harness)
- [JSR: @henji/harness](https://jsr.io/@henji/harness)

## License

MIT
