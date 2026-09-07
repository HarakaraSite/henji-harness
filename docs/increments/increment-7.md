# 通常利用 increment 7 — Henji-owned Web search

ステータス: local実装、focused verification、コード／テストreview、authoritative offline gate完了。
production retained TUI human gateとユーザー受入は未実施。

## この文書の位置付け

この文書は、通常利用中の調査をmodelが明示的な`web_search` tool callとして行えるようにするincrement 7の
初期実装計画である。利用者は、Henji-ownedなprovider-neutral tool componentと交換可能なbackendを設け、
初期backendでは既存のOpenRouter credentialを使って`perplexity/sonar`を一回呼ぶ方針を2026-09-07に選んだ。

OpenRouterの`openrouter:web_search` server toolを使うbackendは、同じ境界へ追加できる将来案として保持する。
現在の実装には含めない。

## 利用者が必要とする動作

1. default parent agentが、current情報や外部情報を必要とするtaskで
   `web_search({"query":"..."})`をtool callとして選べる。
2. toolは一つのqueryをHenji-owned backendへ渡す。初期backendはOpenRouter Chat Completions APIで
   `perplexity/sonar`を一回呼び、そのbuilt-in searchで得た回答と引用sourceを返す。
3. model-visible resultは、回答本文と、回答内の引用番号に対応する順序付きsource一覧を含む。各sourceは
   実応答で確認できた`title`と`url`を持つ。初版ではsourceを並べ替えたり重複除去したりしない。
4. `web_search`後、parent agentは同じturnを継続し、検索結果を使って利用者へ回答できる。
5. Sonar requestとraw response、annotation、parse結果、tool event、runtime request countを既存provider evidence
   からreadbackできる。API keyとAuthorizationは保存しない。
6. 実行中のuser cancellationはSonar requestへ伝播し、同じturnが既存のcancelled settlementへ進む。
7. provider errorまたは必要な回答・sourceを得られない実応答は、raw evidenceを保持した明示的なtool errorに
   する。自動retry、別provider fallback、query書換えは行わない。

`web_open`、URL本文取得、browser代替はこのincrementの利用者要件ではない。

## 根拠となる明示要件、公式contract、実行証拠

- increment 6で既存work toolを`ToolComponentCatalog`からmaterializeする境界を実装済みであり、利用者は
  `web_search`をその次のincrementとして選んだ。
- 利用者は登録先とkey管理を増やしたくないため、既存OpenRouter credentialを再利用する方針を選んだ。
- OpenRouterの現行model情報では、`perplexity/sonar`は軽量なsearch modelで、入力・出力は各$1/1M tokens、
  Web searchは$5/1K callsである。tool callingとstructured outputは提供しない。
  <https://openrouter.ai/perplexity/sonar>
- 2026-09-07にユーザー承認済みの既存keyによる一回のlive probeを行った。`tools`を付けず、
  `model: "perplexity/sonar"`、`web_search_options.search_context_size: "low"`でHTTP 200を得た。実測costは
  $0.00558、所要時間は約7.2秒だった。
- 同probeで、OpenRouter経由の実応答は`choices[0].message.content`へ回答を、
  `choices[0].message.annotations`へ順序付き`url_citation`を返した。各citationでは`title`と`url`を確認できたが、
  top-level `search_results`と`citations`、annotation snippetは存在しなかった。回答中の`[n]`とannotation順を
  維持する必要がある。
- probe artifactは`/tmp/henji-openrouter-sonar-probe-20260907/`に保存した。`request.json`にはcredentialを
  含めず、raw response、headers、summaryを分けて保持している。このtemporary artifact自体をproductの
  durable contractやfixtureの正本にはしない。
- OpenRouter公式は`openrouter:web_search` server toolをBetaとして案内し、modelが0回以上のsearch実行を
  判断する方式としている。旧`web` pluginと`:online`はdeprecatedである。
  <https://openrouter.ai/docs/guides/features/server-tools/web-search>
- 現在の一query一searchというproduct動作には、検索判断と検索回数をOpenRouter側modelへさらに委ねるserver
  toolより、検索能力を内蔵するSonar一回の方が直接的である。server tool方式は将来backend候補として残す。

## 現行product経路と変更境界

現在のparent agent実行は次の経路を通る。

```text
Agent Definition capabilities.tools
  -> Worker-local ToolComponentCatalog
  -> Tool
  -> Registry
  -> parent model tool call
  -> Tool.execute(context)
  -> tool result
  -> parent model continuation
```

increment 7では`tool:web_search`をbuilt-in componentとして追加し、そのexecutorだけが
`WebSearchBackend`を呼ぶ。

```text
parent model
  -> web_search({ query })
  -> Henji WebSearchTool
  -> WebSearchBackend.search(query, execution context)
  -> OpenRouterSonarWebSearchBackend
  -> one OpenRouter Chat Completions request
  -> answer + ordered url citations
  -> model-visible tool result
  -> parent model continuation
```

`WebSearchBackend`はqueryとtool execution contextを受け、provider-neutralな
`{ answer, sources: [{ title, url }] }`を返す。OpenRouter固有のmodel名、request body、response parser、credential、
fetch、evidence記録はSonar backendへ閉じる。tool schema、model-visible formatting、component identityはbackend
から分離する。

### Model-visible contract

- inputは必須の`query: string`一つとする。domain filter、件数、期間、locale、model選択は、現在の利用者動作と
  実測contractに必要ないため初版へ追加しない。
- resultは`Answer:`に続けてSonarの回答本文を置き、`Sources:`以下へannotation順の連番、title、URLを置く。
  Sonarが回答中に生成した`[n]`とsource一覧の対応を保つ。
- provider metadata、usage、cost、raw JSONはmodel-visible resultへ複製せず、既存evidence readbackへ保存する。
  modelへは調査を継続するために必要な回答とsourceだけを返す。
- 回答または有効な`url_citation`が一件もない場合は成功と偽らずtool errorにする。追加fieldは拒否理由にせず、
  必要fieldだけを読む。

### OpenRouter Sonar backend

- 既存production credential sourceと`https://openrouter.ai/api/v1/chat/completions`を再利用する。新しいkey、
  account、hostname、dependency、launcher network permissionは追加しない。
- requestは`perplexity/sonar`、non-streaming、検索回答を求める一つのmessage、
  `web_search_options.search_context_size: "low"`を使う。`tools`、deprecatedな`web` plugin、`:online`は使わない。
- request開始前に親の`ModelExecutionContext.claimModelRequest()`を呼ぶ。Sonarは実際の追加model requestなので、
  親turnのrequest admissionとruntime request countへ含める。
- parentの`AbortSignal`をfetchへ渡す。timeout、retry、fallbackは明示要件がないため追加しない。
- main modelと同じcounted fetch経路を使い、既存`ProviderEvidenceRecorder`へrequest body、response headers、raw
  response bytes、parser transitionを記録する。Authorizationとcredential値を記録する入力は設けない。
- tool callが属するmodel stepをevidenceへ正しく関連付けるため、`ToolExecutionContext`へ現在の`modelStep`を渡す。
  nested Sonar requestもmain model requestと同じ一連のevidenceで順序を確認できるようにする。

### Composition

- built-in catalogへ`tool:web_search`を追加し、default parent Definitionだけが選択する。plannerは現状のread-only
  tool集合を保ち、web searchを暗黙に得ない。
- `ToolComponentBindings`、`RegistryMaterializationContext`、production `PhysicalIoBindings`へbackend bindingを
  接続する。component replacementの既存identity/name整合contractを維持する。
- Worker経路だけでなく公開non-worker runtime compositionも同じtool selectionとbackend seamを使えるようにし、
  二つのproduction compositionを不整合にしない。
- provider-free test compositionはnetworkを使わない注入backendでmaterializeする。fixtureはtool plumbingの
  deterministicな確認にだけ使い、外部provider contractの正本にはしない。
- 公開export、resource topology、manifest expectation、JSR publish allowlistへ新しいruntime sourceを反映する。

## 対象外

- OpenRouter `openrouter:web_search` server toolの現在実装。将来、同じ`WebSearchBackend`境界へ追加できる候補
  として保持する。
- 旧OpenRouter `web` pluginと`:online`。
- Exa MCPとMCP component。利用者はExa MCPを却下し、MCP componentを将来構想へ送った。
- DuckDuckGo HTML/Lite、`@b-fuze/deno-dom`、`node-html-parser`。2026-09-07のlive probeでどちらもHTTP 202の
  human challengeを返したため、現在のproduction backendにしない。
- Brave、Tavily、Perplexity direct API、SearXNGなど別account、別key、別instanceを必要とするbackend。
- `web_open`、page fetch、content extraction、browser操作、crawl、複数queryの並列実行。
- query rewrite、automatic retry、provider fallback、source ranking/deduplication、domain filter、結果件数設定。
- API keyを同一Unix userの任意`bash` subprocessから隔離する新しいsandbox。既存credential fileの値、
  Authorization、request headerをevidenceへ出さない現行境界は維持する。
- active Session中のtool hot reload、tool componentの独立revision lineage、F24の自己改訂flow。

## 主な実装対象

1. new `v0/agent/web_search.ts`または同等の単一module:
   provider-neutral backend/result型、`web_search` tool、Sonar backend、実応答parser。
2. tool materialization:
   `v0/agent/tool_components.ts`、`v0/agent/registries.ts`、`v0/agent/agent_definition.ts`、resource topologyと
   manifest関連source。
3. request/evidence composition:
   `v0/agent/execution_context.ts`、`v0/agent/loop.ts`、`v0/agent/worker_agent_api.ts`、
   `v0/agent/worker_physical_io.ts`、`v0/agent/runtime.ts`。
4. public packageと検証:
   `v0/agent/mod.ts`または現在の公開export、`jsr.json`、focused test。
5. 現在形の文書:
   `docs/architecture/henji-host-agent-worker.md`、`docs/roadmap.md`、
   `docs/experience/normal-use-inbox.md`、new `docs/increments/increment-7-results.md`、`.handoff/handoff.md`。

実装時のsource inspectionで上記以外の既存consumerにtool集合、Physical I/O、request count、evidence、publish
allowlistの期待値が見つかった場合は、確定したproduct動作との整合だけを同じscopeで更新する。新しいprovider、
credential、network permission、外部contractが必要なら計画変更としてユーザーへ戻す。

## 実装順序

1. provider-neutral result/backend型と`web_search({query})` toolを追加し、回答と順序付きsourceのmodel-visible
   formattingを確定する。
2. Sonar backendを既存credential、counted fetch、AbortSignal、provider evidenceへ接続し、実測した
   `message.content`と`message.annotations[].url_citation`をparseする。
3. tool executionへmodel stepを渡し、nested requestのadmission、count、raw evidence、tool eventの順序を既存
   runtime contractへ統合する。
4. built-in component catalog、default Definition、Registry、Worker/non-worker composition、public export、JSR
   allowlistへ`tool:web_search`を接続する。planner tool集合は変更しない。
5. 変更したproduct動作に対応するfocused test、type check、format、lint、`git diff --check`を実行する。
6. stable candidateをbounded implementation reviewし、accepted findingがあれば局所修正と一回のchanged-lines
   re-reviewを行う。その後、coordinating ownerがauthoritative `v0:gate`を一回だけ実行する。
7. results、architecture、roadmap、normal-use inbox、handoffを実測した現在形へ更新し、production retained TUI
   human gateへ渡す。

## 検証と受入れ

各確認は次の具体的なproduct動作へ対応させる。test件数を完了条件にしない。

### Focused verification

- tool contract: parent modelが`web_search`を選び、一つのqueryをbackendへ渡す。tool resultは回答とannotation順の
  title/URLを番号付きで返し、parent modelが同じturnを継続できる。
- observed response: 2026-09-07に観測したOpenRouter response shapeに対応する代表responseから、回答と全
  `url_citation`を順序どおり取得する。追加fieldは無視し、snippetやtop-level `search_results`を要求しない。
- provider failure: non-2xx、JSONでないbody、回答欠落、citation欠落はtool errorになり、raw response evidence
  とparser transitionを残す。自動で再送または別provider呼出しをしない。
- accounting/evidence: main request、Sonar request、main continuationの順にrequest recordを持ち、Sonar request
  がparent request admissionとruntime external request countを一件消費する。raw request/responseとannotationを
  readbackでき、request header、Authorization、credential値はrecord shapeに存在しない。
- cancellation: Sonar fetch中のuser cancellationで同じsignalがabortされ、tool error textへ変換されず既存の
  cancelled settlementまで伝播する。
- composition: default parentのmanifest/provider definition/Registry dispatchへ`tool:web_search`が一回だけ現れ、
  built-in plannerには現れない。injected backendでWorkerとnon-worker compositionをnetworkなしに確認できる。
- regression: 既存read、write、edit、bash、bash_outputのcomponent selection、main model request、step/request
  admission、provider evidence、cancel semanticsが変わらない。

実装中は該当focused testと、repository定義の`v0:check`、`v0:fmt`、`v0:lint`、`git diff --check`だけを使い、
`v0:test`や`v0:gate`を繰り返さない。stable candidateのreview後、authoritative
`deno task --config deno.v0.json v0:gate`をcoordinating ownerが一回だけ実行する。

### Production retained TUI human gate

local実装、focused verification、implementation review、authoritative offline gateがGOになった後も、追加の
production/provider/credential操作は自動で開始しない。ユーザーの別の明示承認後、現在のproduction launcherで
一つの自然なcurrent-info taskを一回実行する。

1. TUIでcurrent情報を必要とするtaskを送信し、visible activityへ`tool> web_search`が現れる。
2. tool結果後にparent agentが同じturnを継続し、回答がvisible sourceと整合する。
3. evidence readbackでmain model request、Sonar request、main continuationの順、Sonarのraw responseとordered
   annotation、tool event、request countを確認する。Authorizationとcredential値がないこともrecord shapeで
   確認する。
4. Sonar callの実測usage、cost、所要時間をresultsへ記録する。受入taskを繰り返して品質評価を水増ししない。

## Implementation Human Gate

この初期計画は、利用者が選んだbackend方針を現行sourceと一回のlive provider evidenceへ対応付けたものである。
ユーザーがこの計画を明示的に承認する前に、product source、test、configを変更せず、local testや追加provider
requestも実行しない。

承認後は、このscope内のlocal実装、focused verification、bounded implementation review、authoritative offline
gate、results/architecture/roadmap/inbox/handoff更新までを継続できる。production human gate、commit、push、tag、
publish、releaseは別の明示指示を必要とする。

## Plan review結果

- 2026-09-07にGPT-6 Astra xhighによるread-only第三者reviewを実施し、GOとなった。未解決Blocker/P1/P2は0。
- reviewerは、default parentのtool選択、Registry materialization、Worker/non-worker composition、planner維持、
  public export、publish allowlistまで計画に含まれ、現行sourceへ接続可能であることを確認した。
- credential-freeなlive probeのraw responseに、回答本文と19件の順序付き`url_citation`があることを確認し、
  計画のparser contractと引用順序維持が実応答に一致すると判定した。
- 現行のrequest admission、tool dispatch、provider evidenceを照合し、parent budget消費、shared fetch count、
  `modelStep`伝達、tool event順序、cancellation propagationは実装可能と判定した。
- provider-free compositionと既存component replacement/plannerのtest seam、およびproduction retained TUI human
  gateによる実利用確認が計画されていることを確認した。
- reviewではfile変更、test/full gate、credential参照、provider requestを行っていない。
