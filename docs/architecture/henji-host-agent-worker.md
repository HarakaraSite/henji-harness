# Henji Host / Agent Worker アーキテクチャ概念

ステータス: 承認済み概念。未有効化であり、実装計画ではない

この文書は、常駐する Henji Host とヘッドレスな Deno Agent Worker を将来分離するという
プロダクトの方向性を記録する。これはアーキテクチャ決定記録であり、プロトコル仕様、
移行の約束、または現行ランタイムを変更する認可ではない。

この方向性の正本は、現在ユーザーが確認したプロダクト概念である。以下の決定と矛盾する
範囲に限り、旧来の限定
[`docs/roadmap-inputs/henji-agent-definition-composition-boundary.md`](../roadmap-inputs/henji-agent-definition-composition-boundary.md)
に優先する。この過去の入力文書を暗黙に書き換えることはしない。将来の実装には、別途
承認された計画と、この境界が実際のプロダクト経路で機能することを示す最小限の証明が
必要である。

## プロダクト上の決定

- Henji は Deno ベースの agent harness である。agent は TypeScript 関数で定義され、その
  関数は実際に合成可能であり続けなければならない。
- この概念でいう実行 primitive は Deno Web Worker（`new Worker`）である。これは Cloudflare の
  デプロイ単位としての Worker とは別のものである。`AgentWorkerGeneration` は、この Deno Web
  Worker による一時的な実行を表す概念名として引き続き用いる。
- 将来の `AgentDefinition` は、信頼された実行可能な TypeScript の合成コードである。外部の
  TypeScript 関数や plugin も Henji core と同じ trusted-local 実行境界に置かれる。それらの
  出所、レビュー、リビジョン、配布は開発プロセス上の関心事であり、信頼された Definition
  と信頼されていない Definition に別々の実行経路を作るものではない。
- 各 Worker generation の起動前に、選択された Definition code/source revision を参照する
  immutable な `DefinitionRevisionRef` を確定する。hash 形式、loader、promotion 方式はこの概念
  では定めない。評価後の data-only な `AgentManifest` はこの参照とは別の authority であり、
  選択内容を説明するが、admission/permission authority にはならない。
- Deno Web Worker は、組み込み Definition と外部 Definition の双方に共通する単一の実行カプセル
  として提案する。Worker はライフサイクル境界であり、別の trust tier ではない。
- Definition は、provider、model、effort、loop、tools、subagents、context をその Worker 内で
  1 つの実行中の `AgentComposition` に合成できる。現在の OpenRouter profile、model、loop、tool
  set、TUI は、開発とバグの範囲を抑えるために選んだ初期 default であり、恒久的なアーキテクチャ
  制約でも、Definition が将来合成できるものの allowlist でもない。
- UI は交換可能なままだが、Henji Host に属する。Agent Worker はヘッドレスであり、将来の
  interface/protocol を通じてのみ Host と通信する。
- AI が Agent Definition を改訂することは将来の概念である。現行の構造は Definition の改訂を
  妨げてはならないが、自己改訂、候補生成、昇格は延期する。
- 常駐 Host があって初めて、永続的な agent が技術的に可能になる。その durable な
  `AgentInstance` は ephemeral または再起動された Worker generation より長く存続しなければ
  ならない。persistent-agent 機能は将来の範囲であり、現行実装の要件ではない。
- Host の durable な `AgentInstance` metadata は、その Instance が現在使用する
  `DefinitionRevisionRef` を bind する。Definition revision の変更は、同じ revision の Worker
  restart とは区別され、明示的で durable な transition でなければならない。
- 常駐 Host とは、durable な lifecycle owner/service を指す。durable な各 `AgentInstance` に
  永久常駐の thread や Worker を 1 つずつ置くことを意味しない。Instance には active な Worker
  generation が 0 個または 1 個存在でき、lazy activation や idle teardown を後続設計で採用できる。

## 用語

| 用語 | この概念での意味 | 存続期間 / 管轄 |
| --- | --- | --- |
| `AgentDefinition` | 信頼された実行可能な TypeScript 合成関数。Host が所有する UI や session object ではなく、agent をどのように組み立てるかを記述する。 | 1 つの Definition revision。Worker generation 内で評価される。 |
| `AgentComposition` | 1 つの Worker 内で Definition が構築する、実行中の provider/model/effort/loop/tools/subagent/context コンポーネント。標準 Henji component は default であり、閉じた capability list ではない。 | 1 回の live composition evaluation は 1 つの Worker generation 内に閉じる。generation 内で一度だけ構築するか、turn ごとに再構築するかは未決定である。 |
| `AgentManifest` | Definition または composition の、評価後の data-only な説明および identity の projection。何が選択されたかを説明するが、`DefinitionRevisionRef` とは別の authority であり、admission/permission authority ではない。 | revision/identity metadata。実行状態ではない。 |
| `AgentInstance` | 安定した agent identity、その durable state、active な `DefinitionRevisionRef` の binding、および mailbox association。 | Worker generation より長く存続し、置き換えられた Worker で再開できる。 |
| `AgentWorkerGeneration` | 1 つの Definition revision を実行する 1 回の ephemeral な実行。Instance identity を変えずに停止、再起動、置換できる。 | process/thread/isolate の存続期間。 |
| `Surface` | TUI、CLI、JSON、Web、その他の channel など、Host 側で交換可能な interaction adapter。 | Worker とは独立して所有・置換される。 |
| `HenjiHost` | Worker lifecycle、物理 terminal / Surface I/O、Surface の load、UI から command への変換、storage mechanism を所有する常駐 coordinator。将来の mailbox、routing、schedule mechanism もここに属する。 | 常駐 process/service。durability の管轄。 |

`AgentManifest` と `AgentComposition` を区別するのは意図的である。manifest は、実行可能な
Definition が合成できるものを制限する仕組みになることなく、読み取り、比較、または revision
との関連付けができる。

## Host / Worker 境界

意図する方向性は次のとおりである。

```text
Surface (Host 側)
        │ ユーザー意図 / 描画出力
        ▼
HenjiHost ───── interface / protocol ───── AgentWorkerGeneration
   │                                           │
   │ ライフサイクル、terminal / Surface I/O、ストレージ │ Definition → AgentComposition → turn
   │                                           │ provider、tools、subagents、context
   └────────────── 永続化状態 ────────────────┘
```

この図が示すのは所有関係であり、wire schema ではない。物理的な Deno Web Worker mechanism は
重要な証拠だが、正確な application protocol の設計は延期されたままである。

### HenjiHost が所有するもの

- Worker generation の起動、停止、監視、置換。
- 物理 terminal とその他の Surface I/O。
- Surface 実装の load と置換、および Surface action の Worker 向け command または message
  への変換。
- 以下で説明する durable session 境界を含む storage mechanism。
- 将来の resident-agent 設計における、mailbox persistence、inbound routing、schedule wake-up
  mechanics。

Host は、Definition code が外部にあるというだけで、別の Definition 実行経路を選択しない。
組み込み Definition と外部の信頼された Definition は、同じ Worker capsule と同じ概念上の
境界を使用する。

### Agent Worker が所有するもの

- 選択された `AgentDefinition` revision の評価。
- provider/model、effort、loop、tools、subagents、context component を含む、その
  `AgentComposition` の構築と実行。
- transcript と context の意味、turn 中の作業状態、compaction policy、agent policy。
- interface を通じたヘッドレスの進捗、結果、effect、commit proposal の返却。

Worker は terminal、TUI layout、その他の Surface を所有しない。turn を実行するために特定の
UI を要求してはならない。

物理的な terminal と Surface I/O は Host が所有する。一方、provider/tool effect の物理 I/O を
Worker が直接実行するのか、Host の RPC/capability 経由にするのか、subprocess 境界に置くのかは
重要な未決定事項であり、最初の proof が偶然に決めてはならない。

この境界を通るのは data と protocol message である。JavaScript 関数そのものが境界を越える
とは想定しない。Deno Web Worker の通信は structured clone を使用し、以下で説明する local probe
では、関数を `postMessage` で送ると `DataCloneError` が発生した。このため、Definition は
Host から callable value として渡すのではなく Worker 内で評価する。

### Definition revision と generation の fencing

この境界での admission と commit は、次の revision binding 不変条件に従う。これは具体的な
field や schema を定めるものではない。

- Worker generation は、少なくとも `AgentInstance` identity、Definition revision、
  generation/lease identity、base session state revision と相関する。Instance-wide state が存在する
  場合は、その state の revision も相関させる。
- Host は、現在 admit されている generation から、かつ一致する Definition revision と base
  session state revision から来た proposal だけを受理する。
- 同じ revision の Worker restart と新しい revision への切り替えは別の事象である。revision の
  変更は明示的で durable な transition とする。

## セッションの永続性とコミット

Host/Worker 分割によって、実行中の Worker が durable truth の source になってはならない。

### AgentInstance と Session の関係

次の関係と canonical domain を維持する。

- 1 つの Session は必ず 1 つの `AgentInstance` に属し、1 つの `AgentInstance` は 0 個以上の
  Session を持てる。
- Session は transcript、context、turn commit などの conversation semantic state を所有する。
  `AgentInstance` は stable identity、active な Definition revision binding、mailbox association
  を所有する。
- 同じ `AgentInstance` に admit される writer Worker generation は、一度に 1 つだけとする。
  複数の Surface または Session からの input は、Host がその Instance の generation へ serialize
  および routing する。
- mutable datum は Session または Instance のいずれか 1 つの canonical domain に属する。将来
  Instance-wide mutable state を導入する場合、Host は Instance 単位の revision、lock、persistence
  も所有し、session state と二重の正本にしない。

| 責務 | HenjiHost | Agent Worker |
| --- | --- | --- |
| Session identity | session ID と `AgentInstance` との association を所有する。 | 現在の実行でその identity を使用する。 |
| Concurrency | lock と session の serialized admission を所有する。 | ephemeral な turn 中 state だけを持つ。 |
| Persistence | load/store、storage revision、atomic replacement、recovery を所有する。 | commit を提案する。durable state の canonical source にはしない。 |
| Conversation の意味 | 受け入れた canonical state を保存する。 | 実行中の transcript/context semantics と compaction decision を所有する。 |
| Turn の settlement | proposed commit を受け入れ、committed と報告する前に durable に保存する。 | 境界を通じて outcome と proposed state/effect を報告する。 |

概念上の turn の流れは次のとおりである。

1. Host が canonical session state を load し、Worker generation への command を受け入れる。
2. Worker が snapshot を解釈して composition を実行し、turn 中の output と commit proposal を
   生成する。
3. Host が適用対象の session revision を検証し、受け入れた proposal を atomic に保存する。
4. durable storage が成功した後にのみ、Host が Surface または将来の mailbox consumer に turn
   を committed と報告する。

### Effect と commit proposal

Worker から返るものは、概念上、`effect request`、`effect started/completed/unknown evidence`、
`state commit proposal` として区別する。ここではそれらの field や schema を定めない。
durable commit が存在しないことだけでは、effect が発生していないことや、安全に replay できる
ことの証拠にはならない。したがって、effect が開始された可能性のある turn/event は、明示的な
idempotency/deduplication 契約、または effect が開始されていないことの証拠がない限り、transparent
に再実行しない。これは product correctness の不変条件である。

Persisted Host state が canonical であり、Worker state は ephemeral である。Worker の crash
または置換によって、commit されていない作業状態が破棄される可能性がある。turn または commit
が失敗した場合に tool effect が rollback されるとは限らない。local filesystem、subprocess、
network、その他の effect には、それぞれ将来の semantics が必要である。この文書はそれらの
semantics を定義しない。

## 将来の常駐 agent の仕組み

これらの mechanism は常駐 Host の帰結であり、意図的に現行要件には含めない。

| Mechanism | Host の責務 | Worker の責務 |
| --- | --- | --- |
| Mailbox | Worker が不在または置換中である間も含め、`AgentInstance` の input queue を永続化する。 | dequeue した event を解釈し、agent の response または次の intent を決める。 |
| Routing | inbound Surface message を `AgentInstance` と session に対応付け、正しい Surface に output を返す。これは tool-name dispatch ではなく、message/Instance routing である。 | 現在の execution context が宛先となる output を生成する。物理 channel の選択は所有しない。 |
| Schedule | wake-up intent、time、delivery mechanics を永続化し、通常の mailbox event を enqueue する。 | schedule intent の意味を所有し、結果の event を通常の agent input として処理する。 |

したがって、`AgentInstance` は durable な address と state association、および active な
Definition revision binding を持ち、0 個以上の Session に対応付く。一方、
`AgentWorkerGeneration` は置換可能な executor である。同じ `AgentInstance` に対する writer
generation は一度に 1 つだけであり、複数 Surface/Session からの input は Host が serialize と
routing を担う。常に address 可能な persistent agent は ephemeral Worker だけでは提供できず、
常駐 Host、durable storage、service supervisor または同等の lifecycle owner を必要とする。

## 現在の証拠と既存の seam

この repository は現在 trusted-local な Deno harness であり、この Host/Worker 分割はまだ実装
していない。以下は証拠と利用可能な seam であって、すでに確定した Worker protocol ではない。

- 運用上の baseline は Deno 2.9.4 である。現在の runtime と Definition path は
  [`v0/agent/`](../../v0/agent/) にある。
- [`v0/agent/agent_definition.ts`](../../v0/agent/agent_definition.ts) は現在 data-only declaration
  を resolve している。したがって、その `AgentDefinition` type は上記の将来概念に向けた
  implementation seam であり、実行可能な Definition composition がすでに Worker 内で動作する
  証明ではない。 [`v0/agent/runtime.ts`](../../v0/agent/runtime.ts) と
  [`v0/agent/registries.ts`](../../v0/agent/registries.ts) は、現在の prepare/materialize seam と
  Host が所有する executable factory を示している。
- [`v0/agent/session.ts`](../../v0/agent/session.ts) には現在の session、transcript、persistence、
  commit の挙動がある。 [`v0/agent/events.ts`](../../v0/agent/events.ts) には provider-neutral な
  lifecycle event seam がある。 [`v0/agent/tui_presentation_adapter.ts`](../../v0/agent/tui_presentation_adapter.ts)
  と [`v0/presentation/contract.ts`](../../v0/presentation/contract.ts) は presentation projection
  boundary を示している。これらのファイルはいずれも最終的な Host/Worker protocol ではなく、
  それ自体が移行を認可するものでもない。
- [Deno Web Worker API](https://docs.deno.com/api/web/workers/) は Worker の実行と message passing を
  文書化している。観測した local check では、Deno Web Worker は別の isolate/event loop で動作し、
  `postMessage` は [structured clone を含む Web platform API](https://docs.deno.com/runtime/reference/web_platform_apis/)
  を使用した。関数を送ると `DataCloneError` が発生した。
- Deno Web Worker の permission はデフォルトで parent から継承される。Deno の
  [`WorkerOptions`](https://docs.deno.com/api/web/~/WorkerOptions) は Worker ごとの permission
  narrowing を公開しているが、インストール済み Deno 2.9.4 ではこの option に
  `--unstable-worker-options` が必要だった。local `permissions: "none"` check では read と
  environment access が `NotCapable` により阻止された。これらの観測は lifecycle と data の
  境界を裏付けるが、完全な sandbox architecture を確立するものではない。
- Deno の [security documentation](https://docs.deno.com/runtime/fundamentals/security/) は、
  `--allow-run` で起動された subprocess が Deno permission sandbox の外側にあると記載している。
  将来の設計文書では、Deno Web Worker permission だけで shell tool またはその descendant を閉じ込められる
  と主張してはならない。
- Deno Web Worker は単独では durable ではない。常駐 Host と durable storage、および service lifecycle
  owner は、将来の persistence と recovery のアーキテクチャ上の前提条件である。

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

## 将来計画のための実装難所（参照、実装範囲外）

以下は、将来の planning で優先順位を付けるための参照記録であり、実装範囲でも、実装を
開始する認可でもない。具体的な protocol field、schema、retry algorithm、limit、security matrix
はここでは設計しない。

### Critical

- Deno Web Worker protocol と composition boundary: structured clone は関数を運べないため、Definition は
  Deno Web Worker 内で import/evaluate しなければならない。message には、意味を持つ data-only な相関が
  必要である。[Deno Web platform API](https://docs.deno.com/runtime/reference/web_platform_apis/) と
  この文書の local probe は、その前提を示している。
- tool/provider effect と durable commit: 共有 transaction はない。`effect request`、
  `effect started/completed/unknown evidence`、`state commit proposal` を区別し、commit がないこと
  だけから安全な replay を推論しない。
- Definition revision、generation、base state の fencing: executable identity には dependency/import
  の関係も含まれ得る。stale generation の proposal を拒否し、Manifest を authority にしない。
- provider/tool の物理 I/O の配置: Worker 直接実行、Host RPC/capability、subprocess 境界のどれを
  採るかは、最も重要な未解決の実装選択である。最初の proof がこの選択を偶然に決めてはならない。

### High

- 複数 Session にまたがる一 writer と head-of-line blocking。
- cooperative cancel と強制的な `Worker.terminate()` の違い、および不明な effect outcome。
- streaming/large output/backpressure と、structured clone の copy/memory cost。Worker の構成と
  通信に関する [Deno worker pool の例](https://docs.deno.com/examples/worker_pool/) も参照する。
- executable module の load と Definition revision の rollout。
- lifecycle/resource ownership: durable な各 Instance を常駐 Worker に対応付けないこと。lazy
  activation と idle teardown を前提にできる。
- service supervision と Host crash recovery。

### Medium

- Surface reconnect と canonical replay。
- credential/Authorization を露出させずに行う correlation/observability。
- portability のための正確な Deno/OS/TTY/module/storage deployment profile。
- human の product need が生じた場合に限る、将来の mailbox/schedule semantics。

## 将来の段階的な proof 順序（推奨、実装承認ではない）

これは将来の planning に向けた proof sequence と ordering constraint であり、いずれの段階の
実装認可でもない。各段階の成功基準は、実際の Henji product path で人間が目的を完了できる
ことである。fixture や protocol stub はその代替にならない。実際の provider/tool execution には、
既存の別途 Human Gate が引き続き必要である。

1. 正確な Deno 2.9.4 上で Deno Web Worker capsule を probe する。structured clone、ordering、error、
   terminate、permission option、large/stream event を確認する。daemon、mailbox、schedule、routing は
   この段階に含めない。
2. 現在の built-in Definition の 1 turn を Worker 経由で実行する。現行 TUI を Host の Surface として
   維持し、ユーザーから見える production behavior を保つ。
3. built-in と external の trusted Definition を、まったく同じ bootstrap/protocol/commit path に
   通す。実行可能な TS composition が allowlist に縮小されていないことを証明する。
4. 1 つの durable Instance/Session について Worker generation を置き換え、stale proposal rejection、
   commit boundary、effect の可能性がある場合の automatic replay 不在を確認する。
5. 1 つの実際の local tool と 2 つ目の Surface を用い、effect evidence、cancel、backpressure、Worker
   内に UI logic がないことを確認する。
6. resident Host/service supervision と複数 Session の routing を確認し、lazy Worker activation と
   restart readback を含める。Instance の durability を常駐 thread に依存させない。
7. human の need が生じた場合に限り、mailbox、schedule wake-up、remote ingress、multi-host、
   self-revision をそれぞれ別の計画として扱う。

## 延期する決定と対象外

以下は、別の計画が証拠と明示的な scope を持つまで延期したままにしなければならない。

- Worker message protocol、wire representation、handshake、error model、versioning。
- Definition の load、module identity、source/revision lineage、dynamic import、plugin lifecycle、
  distribution、および AI が生成した revision の approval または promotion。
- 正確な provider-neutral adapter surface、model selection、composition を turn ごとまたは
  generation ごとに再構築するかどうか。
- Worker restart、cancellation、retry、concurrency、lease、backpressure の semantics。
- persistence schema、mailbox acknowledgement/deduplication、routing policy、schedule timing、
  compaction の詳細、Instance-wide mutable state、cross-session memory の具体機能。
- effect の idempotency/deduplication 契約、exactly-once の保証、effect ledger、recovery UI、retry
  algorithm。
- 上記の実装難所に関する、具体的な protocol、execution placement、deployment profile、recovery の
  詳細設計。
- provider/tool effect の物理 I/O placement（Worker direct、Host RPC/capability、subprocess boundary）と、
  tools の host/process/permission arrangement。`--allow-run` subprocess とその effect の扱いを含む。
- portability のための正確な Deno/OS/TTY/module/storage deployment profile、および resident Host の
  service supervision、recovery、capacity、observability の具体設計。
- remote または multi-host Surface、deployment、rollout、現行 runtime からの migration。

この概念は以下を行わない。

- 現行の `v0/` 実装を移行せず、現在の provider、tools、session、TUI を変更しない。
- 3 つ目の production Definition、loader、marketplace、plugin manager を導入しない。
- `AgentManifest` を execution allowlist に変えない。
- code provenance だけを理由に、信頼された Definition と信頼されていない Definition の別経路を
  作らない。
- UI rendering を Worker に移さず、特定の Surface も要求しない。
- 現時点で Worker-only sandbox、tool effect の rollback、always-on persistence、self-revision を
  約束しない。
- Deno が利用できるというだけで、特定の runtime/OS/TTY/storage/supervisor の組み合わせと同等の
  behavior が得られるとは主張しない。
- Cloudflare の managed platform、Durable Object、Agents SDK runtime の lifecycle、routing、storage
  semantics を Henji の現行 behavior として採用したり約束したりしない。
- 詳細な schema、API name、limit、rollout step、test matrix を規定しない。

## 帰結と次の gate

この方向性は TypeScript の合成自由度を維持しつつ、Surface、storage、Worker lifecycle を Host が
独立して制御できるようにする。同時に、境界を越える値は protocol で表現しなければならない
こと、turn 中の state は ephemeral であること、durable commit は Host の操作であること、tool
effect は自動的に transactional ではないことを明確にする。Deno Web Worker permission の挙動と subprocess
への到達可能性は後続設計で特に注意を要するが、ここでは一般的な hardening policy を導入しない。
また、Definition revision と generation/lease、base session state revision の binding、
`AgentInstance` と Session の canonical domain、effect の replay 可否を曖昧にしないことで、後続の
実装が古い generation の proposal、二重の正本、外部 effect の透明な再実行を正当化しないようにする。
Cloudflare の managed platform は lifecycle、routing、durable storage、scheduling/wake-up、
supervision、recovery、capacity、observability の control plane を提供するが、Henji はそれを
前提にしない。Henji は local physical tool/UI の自由度と operator が制御する semantics を得る
代わりに、これらの control-plane responsibility を自ら構築・運用する local-first trade-off を
意図的に選ぶ。

技術的な難しさは大きい。どのような migration よりも前に、別途承認された implementation plan が、
実際のプロダクト経路で少なくとも次の性質を示す architecture の最小限の証明を定義しなければならない。
組み込みの trusted TypeScript Definition と外部の trusted TypeScript Definition が同じ Worker capsule
を使うこと、置換可能な Worker generation が同じ durable Instance を再開できること、UI code を Worker
に置かずに Surface を変更できること、そして Host の durability 後にのみ turn が commit されることである。
その証明は、fixture や protocol stub を product acceptance とみなすのではなく、未検証の事項も報告しなければ
ならない。
推奨する段階の順序は「将来の段階的な proof 順序」に示すが、それ自体は実装承認ではない。各段階でも、
provider/tool の物理 I/O 配置、revision fencing、effect evidence、canonical durability を意図せず
決めてしまわないことが必要である。

### レビュー用チェックリスト

この概念またはその最初の proof を将来 review するときは、product correctness と概念への忠実性を確認する。

- 文書は Definition、live Composition、Manifest、Instance、Worker generation、Surface、Host の区別を
  保っているか。
- 実行 primitive が Deno Web Worker（`new Worker`）として定義され、Cloudflare のデプロイ単位である
  Worker と混同されていないか。また、実行・durable agent・platform/control plane の三層比較が analogy
  であり、equivalence ではないと明記されているか。
- Cloudflare Agent の attached state への直接アクセスと、Henji Worker の commit proposal / Host canonical
  storage の違い、ならびに Durable Object の single-threaded execution と Henji の turn admission の違いが
  保たれているか。
- managed Cloudflare platform と local `workerd`/self-host の差、および Deno の存在だけでは portability が
  保証されないことが、根拠付きで限定されているか。
- 各 Worker generation に起動前の immutable な `DefinitionRevisionRef` が bind され、評価後の
  `AgentManifest` は別の data-only projection として admission/permission authority から分離されているか。
- Host は現在 admit された generation と一致する Definition/base session state revision の proposal だけを受理し、
  同じ revision の restart と revision 変更を区別しているか。
- `AgentComposition` の lifetime は Worker generation 内に閉じた 1 回の live evaluation とされ、
  generation 単位で一度だけ構築するか turn ごとに再構築するかを未決のまま保っているか。
- 組み込みと外部の trusted Definition は、Definition を manifest allowlist に縮小することなく、同じ
  execution capsule と合成 semantics を使っているか。
- Worker は headless で、交換可能な Surface の所有権は Host 側にあるか。
- 物理的な Surface I/O は Host 所有として維持され、provider/tool effect の物理 I/O placement は未決定の
  Worker direct / Host RPC・capability / subprocess 選択として残されているか。
- session ID、lock、persistence、atomic commit、recovery、canonical state と ephemeral state の区別は、
  正しい側に割り当てられているか。
- 1 つの Session が必ず 1 つの `AgentInstance` に属し、1 つの `AgentInstance` が 0 個以上の Session を
  持つこと、Session と Instance の canonical domain が混同されていないことが明記されているか。
- 同じ `AgentInstance` の writer generation は一度に 1 つだけであり、複数 Surface/Session からの input
  は Host がその generation へ serialize/routing することが明記されているか。
- tool effect の暗黙の rollback を置かず、Host の durability 後にのみ turn が committed とされているか。
- `effect request`、`effect started/completed/unknown evidence`、`state commit proposal` が区別され、durable commit
  がないことだけで effect 未発生や安全な replay と判断せず、必要な契約または証拠なしに transparent replay
  を許していないか。
- mailbox、routing、schedule は将来の resident-Host mechanism として説明され、routing と tool dispatch は
  区別されているか。
- resident Host が durable な lifecycle owner/service であり、各 `AgentInstance` に永久常駐 Worker を要求せず、
  0 個または 1 個の active generation と lazy activation / idle teardown を許しているか。
- Cloudflare の managed control plane と、Henji が local physical tool/UI の自由度と operator-controlled
  semantics の代わりに自ら lifecycle、routing、storage、scheduling、supervision、recovery、capacity、
  observability を構築・運用する local-first trade-off が、バランスよく説明されているか。
- 現在の source file は、既存の最終 protocol ではなく証拠・seam として説明されているか。
- Deno Web Worker permission、structured clone、`--allow-run` に関する主張は、根拠があり、限定付きで説明されて
  いるか。
- 「将来の段階的な proof 順序」が推奨される ordering constraint であり、いずれの段階の実装認可でもないこと、
  および各段階が実際の product path と既存 Human Gate の条件に従うことが明記されているか。
- Pi、Zot、OpenComputer、Cloudflare、OpenClaw の比較は、それぞれの参照が実際に示す範囲に限定されているか。
- この概念が決定していない schema、limit、migration step、security matrix、test count を review で創作して
  いないか。
