# Henji Host / Agent Worker 外部参照比較

ステータス: architecture検討時の背景調査。architecture、roadmap、実装要件、実装認可ではない

調査記録日: 2026-09-04

分離日: 2026-09-06

この文書は、Henji Host / Agent Workerの責務とlifetimeを検討する際に参照した外部実装・platformとの
比較を記録する。採用された構造上の決定は
[`docs/architecture/henji-host-agent-worker.md`](../architecture/henji-host-agent-worker.md)
を正本とする。ここにある類似、用語、外部機能、snapshotはHenjiの要件や実装順序を定めない。

## Deno Web Worker runtime evidence

architecture検討時に、Deno 2.9.4と公式APIを基準に次を確認した。これは調査時点のruntime evidenceであり、
現在の実装状態や将来の実装順序を示さない。

- [Deno Web Worker API](https://docs.deno.com/api/web/workers/)はWorkerの実行とmessage passingを
  文書化している。local checkでは、Deno Web Workerは別のisolate / event loopで動作し、
  `postMessage`は[structured cloneを含むWeb platform API](https://docs.deno.com/runtime/reference/web_platform_apis/)
  を使用した。関数を送ると`DataCloneError`が発生した。
- Deno Web Workerのpermissionはデフォルトでparentから継承される。
  [`WorkerOptions`](https://docs.deno.com/api/web/~/WorkerOptions)はWorkerごとのpermission narrowingを
  公開するが、調査時のDeno 2.9.4では`--unstable-worker-options`が必要だった。local
  `permissions: "none"` checkではreadとenvironment accessが`NotCapable`により阻止された。
- Denoの[security documentation](https://docs.deno.com/runtime/fundamentals/security/)は、
  `--allow-run`で起動されたsubprocessがDeno permission sandboxの外側にあると説明している。
- Deno Web Workerは単独でdurable state、service supervision、crash recoveryを提供しない。

## 外部の類似例とその限界

これらの参照は用語と trade-off を考える材料である。いずれも Henji にそのまま適用できる
設計でも、Henji が提案された Worker capsule をすでに持つことの証拠でもない。

### Deno Web Worker と Cloudflare の三層比較

この文書で実行 primitive と呼ぶ Worker は Deno Web Worker（`new Worker`）であり、Cloudflare
のデプロイ単位としての Worker ではない。次の対応は、実装上の同値性ではなく、責務と lifetime
を比較するための大まかな analogy である。

| 層 | Henji | Cloudflare 側とのおおよその対応 |
| --- | --- | --- |
| 実行 | [Deno Web Worker (`new Worker`)](https://docs.deno.com/api/web/workers/) / `AgentWorkerGeneration` | active な in-memory の [Cloudflare Agent incarnation](https://developers.cloudflare.com/agents/runtime/lifecycle/agent-class/) または [Durable Object lifecycle](https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/) の一部に相当するにとどまる。 |
| durable agent | `AgentInstance` | [Durable Object の ID/name と付随する永続 state](https://developers.cloudflare.com/durable-objects/concepts/what-are-durable-objects/) におおよそ対応する。 |
| platform / control plane | HenjiHost の lifecycle、routing、storage、supervision mechanism | Cloudflare の managed [Workers / Durable Objects platform](https://developers.cloudflare.com/workers/local-development/) と [Agents SDK runtime](https://developers.cloudflare.com/agents/runtime/operations/configuration/) および [Agents routing](https://developers.cloudflare.com/agents/runtime/communication/routing/) が提供する制御面におおよそ対応する。 |

この analogy は equivalence ではない。

- Cloudflare Agent code は attached state に直接アクセスできるが、Henji Worker は commit proposal
  を返し、canonical な storage authority は Host である。[Cloudflare Agent class の lifecycle](https://developers.cloudflare.com/agents/runtime/lifecycle/agent-class/)
  と [Durable Objects の state](https://developers.cloudflare.com/durable-objects/concepts/what-are-durable-objects/)
  を、Henji のこの境界と同一視してはならない。
- Cloudflare Agent class/runtime と agent harness は別の概念である。[Cloudflare の harnesses](https://developers.cloudflare.com/agents/harnesses/)
  が示すように、model/tool loop は custom harness/Think であり得る。したがって Cloudflare Agent
  class は Henji `AgentDefinition` ではない。
- Durable Object の single-threaded execution は、agent turn が常に一度に 1 つだけ処理されることを
  自動的には意味しない。[Durable Objects の concurrency rules](https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/)
  に関わる async interleaving/concurrent execution semantics は、Henji Host の admission semantics
  とは異なる。

Cloudflare の managed Workers は Cloudflare の platform 上で実行されるが、公式の
`wrangler dev` は local `workerd` を使用し、[workerd は self-hosted use もサポートする](https://github.com/cloudflare/workerd/blob/main/README.md)。
しかし workerd を self-host しても、Cloudflare の managed routing、placement/uniqueness、storage
service、autoscaling、alarms、supervision、observability が再現されるわけではない。[Workers の
local development](https://developers.cloudflare.com/workers/local-development/) と
[Cloudflare Agents の configuration](https://developers.cloudflare.com/agents/runtime/operations/configuration/)
が示す managed platform 依存を、単独の runtime の性質として扱わない。Cloudflare Agents の
official production semantics も Durable Object bindings と managed platform に依存する。

Henji の portability は「Deno が存在する」ことだけでは保証されない。正確な Deno/runtime/OS/TTY/
storage/supervisor の依存関係を満たす machine 上で実行できる、という意味に限る。

| 参照 | 有用な比較 | 明示し続けるべき限界 |
| --- | --- | --- |
| [Pi's coding-agent snapshot](../../_refs/pi/packages/coding-agent/README.md) | tool、command、event handler、UI component を追加できる、自由度の高い trusted TypeScript extension を示す。 | Pi の in-process extension model は Deno Worker boundary の証明にならない。Henji では Definition が合成可能なままでも、UI の所有権は Host に置く。 |
| [Zot extension docs](../../_refs/zot/docs/extensions.md) と [RPC docs](../../_refs/zot/docs/rpc.md) | subprocess RPC は message boundary 越しの結合と障害分離を示し、RPC mode では persistence を Host が所有する。 | subprocess と JSON/RPC protocol だけで OS authority や security boundary になるわけではない。別の証拠なしに、Henji が提案する Deno Web Worker をそのように説明してはならない。 |
| [OpenComputer Agent snapshot](../../_refs/opencomputer/agent/README.md) | 管理された runtime における同期的な TypeScript agent composition を示す。model、tools、subagents、関連 capability は code によって選択される。 | 公開情報または repository の証拠は、Deno-Worker 相当の capsule を証明しない。managed deployment、gateway secret、その reactive semantics はこの概念に採用しない。 |
| [Cloudflare Agent internals](https://developers.cloudflare.com/agents/runtime/lifecycle/agent-class/) と [Durable Object lifecycle](https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/) | durable identity と state を、破棄・再生成可能な in-memory execution と組み合わせられる、有用な actor/lifecycle 類似例である。 | 常時稼働 process model ではなく、Henji の storage、mailbox、scheduling、deployment 設計を決めるものでもない。 |
| [OpenClaw runtime architecture](https://github.com/openclaw/openclaw/blob/main/docs/agent-runtime-architecture.md) とその [distributed-runtime proposal](https://github.com/openclaw/openclaw/issues/42026) | 共有 Gateway 内の複数の論理 agent と、別途提案された compute/lifecycle architecture を区別するのに役立つ。 | この proposal は現在の OpenClaw 実装ではなく、どちらの参照も Henji の Worker protocol を定義しない。 |
