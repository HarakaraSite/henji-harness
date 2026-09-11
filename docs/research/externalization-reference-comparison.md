# Henji外部化に関する参照実装比較

ステータス: architecture検討の背景調査。architecture、roadmap、個別Increment要件、実装認可ではない

調査日: 2026-09-11

## 目的

Henjiの外部化対象をAgent Definitionやtoolの例だけから決めず、既存agent harnessとruntimeが、実行定義、
外部resource、durable state、platform coreをどの境界で分けているかを比較する。比較結果は
[`../roadmap-inputs/increment-32-34-externalization-concept-plan.md`](../roadmap-inputs/increment-32-34-externalization-concept-plan.md)
の分類と計画を評価するために使う。

参照実装はHenjiの仕様ではない。各実装から最小限のmechanismとtrade-offだけを取り出し、Henjiへの採否は
構想、architecture、roadmap、個別Incrementの承認手順に従う。

## 調査範囲

ローカルsnapshotとrevisionの管理規約は[`../../_refs/README.md`](../../_refs/README.md)を正本とする。

| 参照 | pinned commit | 主な比較対象 |
| --- | --- | --- |
| Pi | `08dc60bc52d89d6823a9738cc90b1916e5e446e5` | in-process TypeScript extension、package、resource reload |
| Zot | `f60e492e551892e737d24a7eaf7730f1f60b75af` | subprocess extension、JSON protocol、install、reload |
| DeepSeek Harness | `c291e7961a515f6d7af9304e7fd1d257929aef26` | profile/plugin tree、capability seam、dynamic package |
| OpenComputer | `d54f2c239a293216ff13f069ffc1ed7b853f9761` | reactive Agent composition、typed resource declaration |
| Cloudflare Agents | `2f957bc2a3ffb7aee14792bb3cb658ad3176ed93` | client tool、durable callback/state、stream復元 |
| Cloudflare Sandbox SDK | `664d8e36d22f2b8f286a9cac90551113afdb316c` | physical I/O backend、process/file/session境界 |

OpenComputer snapshotは公開Agent packageとTypeScript例に限定され、deployment storeやversion adoptionの内部実装は
含まない。Cloudflare snapshotsも`_refs/README.md`に記した限定範囲だけであり、managed platform全体を評価しない。
Prime Agent、Forge、Crush等の過去調査は
[`../experience/normal-use-inbox.md`](../experience/normal-use-inbox.md)に残るが、今回のsource再照合対象には含めない。

## 評価軸

Henjiの4分類だけでなく、同じresource kindに対して次も確認した。

1. scope / activation owner: installation、workspace、Agent instance、Session、turnのどこが選択するか。
2. execution placement: Host process、Worker、subprocess、client、remote serviceのどこで動くか。
3. lifecycle: install、select/bind、activate、reload、rollback、removeが分離しているか。
4. durability: immutable revision、mutable config、durable instance state、ephemeral runtimeのどれか。
5. attribution: Sessionやevidenceから実行したresource identityをreadbackできるか。

## 参照実装ごとの確認結果

### Pi

Pi extensionはTypeScript moduleを同一processへloadし、tool、command、shortcut、flag、event interception、
custom UI、renderer、provider、compaction customization等を一つのextension APIから登録できる。
[`extensions.md`](../../_refs/pi/packages/coding-agent/docs/extensions.md)の冒頭とAPI例がこの範囲を示す。

Pi packageはextension、skill、prompt template、themeをnpm、Git、local pathからまとめて導入できる。
[`packages.md`](../../_refs/pi/packages/coding-agent/docs/packages.md)では、version付きnpm/Git sourceをpinできる一方、
local pathはcopyせずsettingsへpathを登録する。したがってremote packageのsource ref固定と、Henjiが計画する
content digest付きimmutable managed revisionは同じではない。

`/reload`は旧extension runnerへshutdownを通知して失効させ、settingsとresourceを再読込し、tool registryを含む
runtimeを再構築する。同じAgentSessionとtranscriptは保持する。
[`agent-session.ts`](../../_refs/pi/packages/coding-agent/src/core/agent-session.ts)

評価:

- Agent、tool、instruction以外に、command、provider、compaction hook、Surface、prompt、themeも外部化候補になり得る。
- global、project、temporaryのscopeと、package filter・優先順位がresource selectionに必要である。
- mutable local path reloadは開発体験には有用だが、exact revisionをSessionへbindするHenjiのmanaged pathとは分ける。
- in-process extensionはHostとsystem permissionを共有するため、HenjiのWorker generationやsubprocess placementの
  代替証拠にはならない。

### Zot

Zot extensionは任意言語のprogramをsubprocessとして起動し、newline-delimited JSONでtool、slash command、
lifecycle subscription、tool-call interception、panelを登録する。theme-onlyとskill-only bundleはprocessを
起動しない。[`extensions.md`](../../_refs/zot/docs/extensions.md)

Host側Managerはmanifest、process、stdio、pending request、registration index、lifecycleを所有する。
[`manager.go`](../../_refs/zot/packages/agent/extensions/manager.go) `zot ext install`はlocal directoryをcopyするかGitを
shallow cloneし、`extension.json`の存在を確認する。[`extcmd.go`](../../_refs/zot/packages/agent/extcmd.go)

評価:

- provider-facing tool schemaと外部handler processをprotocolで分離できる。
- Host-owned TUIとextension-owned panel、Host-owned loopとevent interceptorを分ける例になる。
- explicit、project、globalのselection precedenceを持つが、installed directoryはmutableでversion文字列も
  content identityではない。Sessionをextension digestへbindする仕組みもない。
- extension固有stateをcode directory内へ置く推奨は簡便だが、Henjiのimmutable storeへmutable stateを混在させる
  設計には採用できない。

### DeepSeek Harness

DeepSeek HarnessはCordis plugin treeをcompositionの中心とし、model adapter、tool registry、Session log、agent loop、
persistence、sandbox、approval policy等もpluginとして構成する。
[`architecture.md`](../../_refs/deepseek-harness/docs/architecture.md) 実行rootはAgent Definitionではなくprofileとordered
bundle/patch layersであり、application形態によってlive patch reloadの可否も変える。

capability seamはService Definition、Service Provider、Consumerを分ける。filesystem、subprocess、sandbox、LLM、
storage等はmodel-facing toolと独立したbackendとして差替可能である。同文書の「Capability seams」と
「Where new behavior goes」が対応関係を示す。

dynamic Cordis packageはSession所有のstable plugin IDの下へimmutable package IDを追加し、defineとrun/updateを
分け、current/next/runを追跡する。
[`registry.ts`](../../_refs/deepseek-harness/packages/extensions/cordis-host-runner/src/registry.ts)
[`tool-cordis`](../../_refs/deepseek-harness/packages/extensions/tool-cordis/src/index.ts) ただしregistryとIDはprocess-localで、
content digestによるportable revisionではない。persistent profile pluginは別のpackage-manager経路である。

評価:

- Henjiがbinary側authorityとした領域も技術的にはplugin化できるが、これは「すべて同じmodule loaderへ載せる」
  方式ではなく、typed service contract、effect cleanup、profile compositionを含む別architectureである。
- durable Session eventとlive extension eventの分離は、Henjiのcanonical transcriptとruntime projectionの区分を支持する。
- generic externalization graphのrootをAgent Definitionへ固定できないことを示す。
- define、activation、current、next、rollbackの分離はHenjiのlifecycle案に近いが、永続identity保証はHenji側で別途必要である。

### OpenComputer

OpenComputerのAgent default exportは各model call前に同期評価され、inputを読み、model、tool、subagent、MCP serverを
選択してinstructionを返す。I/Oやdurable agent loop自体は実行しない。
[`agent/README.md`](../../_refs/opencomputer/agent/README.md)

公開APIはtoolだけでなく、secret reference、HTTP connection、MCP server、channel、outbox、scheduleを個別の
resource kindとして表す。tool実装はconnectionを参照でき、credential値はAgent artifactへ含めずmanaged gatewayで
解決する。[`agent/src/index.ts`](../../_refs/opencomputer/agent/src/index.ts)

評価:

- Agent Definitionをcompositionの宣言・選択へ限定し、loopとI/O authorityをruntimeに残す境界はHenji案と整合する。
- integration declarationとcredential value、toolとconnection、declarationとdelivery runtimeを分ける必要がある。
- MCP、schedule、channel、outbox等は、Henjiの将来候補一覧へ載せる価値がある。
- snapshotにはinstall store、immutable revision、activation、rollbackの実装がないため、それらの裏付けには使わない。

### Cloudflare Agents

client toolはserializableなname、description、JSON Schemaと、任意のexecutor delegateを分ける。executorがなければ
tool callをclientへ返し、あればRPC側で実行する。
[`client-tools.ts`](../../_refs/cloudflare-agents/packages/agents/src/chat/client-tools.ts)

detached agent-toolはclosureではなくAgent method名をcallback identityとして保存し、Durable Object eviction後に
rehydrateできるようにする。run、progress、milestoneもdurable identityで相関する。
[`agent-tool-types.ts`](../../_refs/cloudflare-agents/packages/agents/src/agent-tool-types.ts)
streaming中の一時状態と復元用SQLite recordも分ける。
[`resumable-stream.ts`](../../_refs/cloudflare-agents/packages/agents/src/chat/resumable-stream.ts)

評価:

- tool schema、実行placement、run identity、result/progress stateは別々のcontractである。
- executable closureをdurable stateへ直接保存せず、stable identityからruntime codeへ再bindingする考えはHenjiの
  logical refとphysical resolutionの分離を支持する。
- Cloudflare deploymentとDurable Object platformはHenjiのlocal managed storeとは異なるため、配布やadoptionの
  contractは導けない。

### Cloudflare Sandbox SDK

Sandbox APIはcommand、background process、stream、file、Git、environment、bucket、execution session、code contextを
一つのphysical execution capabilityとして公開する。
[`types.ts`](../../_refs/cloudflare-sandbox-sdk/packages/shared/src/types.ts)

評価:

- model-facing `bash`、`read`、`write`等を一つずつremote tool化するより、tool handlerが共通のfilesystem、process、
  sandbox backendへ依存するseamを持つ方が整合的である。
- sandbox/session/process identityとAgent Session identityは同じものではなく、bindingとlifetimeを明示する必要がある。
- transport、stream cancellation、process cleanupはtool definitionのrevision contractだけでは決まらない。

## Henjiの4分類との照合

### 1. managed revision候補

現在のAgent Definition、instruction/policy、tool、skill、model profile、subagent Definitionに加え、参照実装から
次の候補が見つかった。

- prompt template、theme等のSurface data。
- slash command、keybinding、message/tool renderer、panel/widget等のSurface code。
- MCP server、HTTP connection、schedule、channel、outbox、webhook、background job等のintegration declaration。
- provider adapter、filesystem、shell/subprocess、sandbox、terminal、storage等のcapability provider。
- context projection、compaction、request/tool interception、approval、session title生成等のruntime policy/provider。

Surface code、integration runtime、capability provider、runtime policyは外部化可能性があるが、Henjiでは実行placementと
authorityを決めるまで「追加architecture判断が必要」に置く。data-only resourceは比較的独立したmanaged revision
候補にできる。

### 2. すでに外部にあるinput/state

Session、transcript、tool call/result、provider evidence、credential/config、workspace input、active selection、
ephemeral compositionという分類は参照実装とも整合する。

不足していたのはresource instanceのmutable stateである。例にはtoolのindex/cache、extension固有設定、connection
pool、長時間process、UI local stateがある。これはimmutable resource revision、active binding、Session transcript、
tool call/resultのいずれとも同一視しない。resource kindごとにowner、scope、保存先、復元保証を決める。

### 3. Henji binary側に残すplatform authority

PiとZotがloop、Session、Host lifecycleをcoreへ残す設計は、Henjiがatomic turn commit、canonical Session ownership、
Worker lifecycle、loader/verifier、credential bindingをbinary authorityとする判断を支持する。

DeepSeek Harnessはこれらもplugin化できる反例だが、その成立条件はprofile root、typed service graph、effect ownership、
application別reload ruleである。したがってHenjiの区分は「技術的に外部化不能」ではなく、「現在のHenji
architectureではmanaged hot-loadの対象にしない」と表現するのが正確である。

### 4. 追加architecture判断が必要な対象

tool physical I/O、provider adapter、context/compaction、agent loop、Human Gate、Surface、storage、distributionという
現在の一覧は妥当である。参照実装を受け、trigger/integration runtimeとresource instance stateも検討対象に加える。

## 共通外部化基盤への修正

### generic graphのroot

すべてのresourceをAgent Definitionから到達させる前提は採用しない。Pi/Zotはresource discovery set、DeepSeek
Harnessはprofile、OpenComputerはAgentとdeployment metadataをrootとする。Henjiの共通表現は、activation authorityが
選んだroot resource setからtransitive graphを解決し、そのgraphを使うgenerationがactiveになる前に確定する。

Increment 33では、この汎用形の限定例として一つのAgent Definitionをrootにし、Worker起動前に解決する。

### generic dependency identity

`AgentResourceIdentity`はAgent composition内のtool、instruction、skill、subagent等には適するが、connection、storage、
sandbox、schedule、Surface等を表す共通型には狭い。共通層ではkind非依存の`ResourceSlotIdentity`を使い、各resource
contractがsemantic slotを定義する。`AgentResourceIdentity`はAgent resource用のkind固有表現にする。

### discovery precedenceとresolved graph conflict

Pi、Zot、DeepSeek Harnessはglobal/project、explicit/discovered、ordered layer等の明示的なselection precedenceを持つ。
Henjiでもresource kind固有のdiscovery/layeringが必要になる可能性がある。一方、選択処理後のexact graphで同じslotに
複数revisionが残る場合は、暗黙の優先順位を付けずresolution failureにする。この二段階を混同しない。

### 分類と直交する属性

外部化対象一覧の各項目には、少なくともscope/activation owner、execution placement、lifecycle、durabilityを記録する。
これにより「外部化可能」という一語から、同一loader、同一Human Gate、同一reload semanticsを誤って導かない。

## 追加調査: native discovery互換とMCP

### 自然言語resource

`AGENTS.md`や`SKILL.md`の互換性は、元file formatを保持するだけでは不十分である。所定scopeへ配置したresourceを
installなしでdiscovery・activationできる運用も互換contractに含まれる。Henjiのmanaged Skillは、native Skillを
利用するための必須経路ではなく、exact pin、transport、Definition bindingが必要な場合の追加authorityとする。
Henji独自のInstruction revisionもnative `AGENTS.md`/Skillとは別resource kindにする。

### MCP

2026-09-11時点の公式情報では、MCP 2026-07-28は各requestがprotocol version等を伝えるstateless coreを採用し、
`server/discover`およびtool、resource、promptのprotocol-level discoveryを定めている。これは接続後にserverの
capabilityを発見する規格であり、workspaceの所定fileをHostが自動採用する`AGENTS.md`型の規約とは異なる。

公式MCP Registryはpreviewだが、公開serverの`server.json`にpackage/remote location、実行引数、環境変数等の
standardized installation/configuration metadataを持つ。Registry metadata、Host固有のconnection selection、
credential、server process/service、接続後に列挙されるcapabilityは同じauthorityではない。

Henjiへの示唆は、MCP対応を一つのmanaged moduleとして扱わず、protocol client、connection declaration、credential、
server実体、runtime capability projection、call/result evidenceへ分けることである。native MCP connectionにHenji
managed installを必須にせず、exact pinやtransportが必要なconnection/server artifactだけを後続Integration
resourceの候補にする。

公式参照:

- [MCP 2026-07-28 release](https://blog.modelcontextprotocol.io/posts/2026-07-28/)
- [`server/discover`](https://modelcontextprotocol.io/specification/draft/server/discover)
- [Tools](https://modelcontextprotocol.io/specification/draft/server/tools)、
  [Resources](https://modelcontextprotocol.io/specification/draft/server/resources)、
  [Prompts](https://modelcontextprotocol.io/specification/draft/server/prompts)
- [MCP Registry](https://modelcontextprotocol.io/registry/about)

## 結論

Henjiの4分類は維持できる。Agent Definitionを最初のmanaged resourceとするIncrement 33も妥当である。一方、
Increment 32の共通基盤はAgent Definition専用のrootやidentityを汎用contractへ入れず、将来のSurface、integration、
capability backend、runtime policyを表現できるlogical envelopeに留める必要がある。

Henjiのcontent digest付きimmutable revision、exact binding、Session/evidence attributionは、調査したPi、Zot、
DeepSeek dynamic packageより強い再現性を目指す設計である。この性質を維持しつつ、kindごとのscope、placement、
lifecycle、mutable instance stateを個別Incrementで決める構成が最も整合する。
