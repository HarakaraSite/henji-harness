# Henji Harness

Henji Harnessは、実際の利用経験から自身の機能を継続的に改訂できるDeno agent harnessを目指す。
通常利用の経験を保存し、人間の指示を契機にWorker内AIが改訂候補を作る。
候補は人間の採用アクションまたは明示的承認によってのみ採用され、その後の通常利用へ戻る。 Henji
HostはSurface、lifecycle、storage、revisionを担い、headless Agent
WorkerがDefinitionを合成・実行する。
現在は開発中であり、詳細は[構想](docs/concepts/experience-driven-self-revision.md)、[architecture](docs/architecture/henji-host-agent-worker.md)、[roadmap](docs/roadmap.md)を正本とする。

## JSR package

最初のpre-releaseでは、Agent Definitionを組み立てるためのpublic APIだけを公開する。
開発中のCLIとTUIは、まだJSR packageの公開interfaceに含めない。

```sh
deno add jsr:@henji/harness@0.1.0-alpha.3
```

```ts
import {
  createDefaultAgentComposition,
  createPlannerAgentComposition,
} from 'jsr:@henji/harness@0.1.0-alpha.3';
```

Pre-release中は、stable releaseまでにAPIが変更される可能性がある。

## Source

- [Forgejo: littleisland/henji-harness](https://forge.harakara.site/littleisland/henji-harness)
- [JSR: @henji/harness](https://jsr.io/@henji/harness)

## License

MIT
