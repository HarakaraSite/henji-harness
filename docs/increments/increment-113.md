# Increment 113 — codebase構造の単純化review

## 状態

**Slice 1とterminal artifact bridge、Slice 2完了。Slice 3修正計画の承認待ち**

## 目的

codebase全体を機能の塊ごとにreviewし、要件とproduct動作を変えずに、意味のない冗長性、不要な複雑性、
責務の混在を減らす。複雑な要件に必要な構造は維持し、短さそのものではなく、owner、状態遷移、contractが
追いやすい構造を目指す。

baselineはIncrement 112完了commit `9570565a`とする。

## 承認済みの進め方

各sliceを次の単位で進める。

1. gpt-6-astra xhighのreviewerが、対象sourceと対応testをread-onlyで否定的reviewする。
2. coordinating ownerがfindingを現行source、明示要件、実行証拠へ照合する。
3. 採用findingについて、保持するproduct動作、変更箇所、単純化後の形、focused検証を具体化し、利用者の承認を得る。
4. 承認範囲だけを修正し、focused test、必要なtype check、format、lint、`git diff --check`を実行する。
5. 同じreviewerが変更箇所と既存findingの解消だけを再reviewする。
6. sliceを閉じて次へ進む。別sliceにまたがるfindingはledgerへ送り、先行して修正しない。

通常reviewは30分、re-reviewは15分を上限とする。reviewerはfull gateを実行しない。全slice収束後の安定候補へ
authoritative `v0:gate`を一回実行する。具体的な失敗理由がない限り途中で繰り返さない。

## Slice一覧

1. Execution kernel — `v0/agent/core/*`
2. Provider selection／configuration／authorization
3. Provider transport／stream／evidence
4. Tools／effects
5. Managed resource lifecycle
6. Composition／instructions／skills
7. Worker capsule
8. Host orchestration
9. Session canonical state
10. History semantic model
11. Production persistence
12. CLI／runtime／build
13. Surface contract／control
14. Surface rendering／layout
15. Input／editor／terminal lifecycle
16. Production validation harness
17. Corpus／evaluation
18. Cross-cutting convergence

後続sliceの正確なsource範囲は、先行sliceの結果で責務境界が明確になった時点で本文書へ記録する。

## Slice 1 — Execution kernel

### 対象

- `v0/agent/core/cancellation.ts`
- `v0/agent/core/context.ts`
- `v0/agent/core/contracts.ts`
- `v0/agent/core/events.ts`
- `v0/agent/core/execution_context.ts`
- `v0/agent/core/loop.ts`
- `v0/agent/core/steering.ts`
- 上記contractと動作を直接検証するtest

理解に必要なcallerはread-onlyで参照できるが、provider adapter、tool実装、Worker／Host orchestration、Session／
history、TUIの修正は本sliceの対象外とする。対象外に変更が必要なfindingはcross-slice ledgerへ送る。

### 評価基準

- 同じ状態または分岐を重複して表現していないか。
- 意味を増やさない型、helper、変換、copy、間接化がないか。
- loop、context、cancellation、steering、event projectionの責務が不要に混ざっていないか。
- 現行の複数step、tool call/result、cancellation、steering、explicit compaction契約を維持したまま、より直接的な
  control flowまたはdata shapeにできないか。
- test helperやfixtureの都合がproduction contractへ逆輸入されていないか。

一般的なsecurity hardening、未観測variant、網羅matrix、要件変更は評価対象にしない。findingには根拠となる
source-to-impact、保持すべきproduct動作、単純化案、regression risk、対応するfocused testを要求する。

## Scope外

- 構想、architecture、roadmap、外部provider contract、model-visible tool contract、SQLite schemaの変更
- 実provider call、binary build／配置、push
- backward compatibility、fallback、追加hardeningの新設

## 現在の承認境界

Slice 1と優先cross-slice bridgeは完了した。利用者は次のhuman gateまでの継続を承認済み。Slice 2はread-only
reviewとfinding検証まで進め、source／test修正は具体的計画を利用者が承認した後に行う。

## Slice 1 review結果

gpt-6-astra xhigh reviewerはprimary source 7 fileを全件確認し、対応するExecution kernel testと具体的な到達先を
限定参照した。reviewerのfocused確認は`current_code_test.ts` 13件、`auto_compaction_test.ts` 4件、Increment 39
4件の計21件が成功した。full gateと実provider callは行っていない。

coordinating ownerは全findingを現行source、call site、履歴へ再照合した。採用結果は次のとおり。

### Slice 1で修正するfinding

1. **17 request目からturn request countが欠落する**: `loop.ts`の`boundedCount(..., 16)`は、標準rootの最大64
   model stepと矛盾する旧上限である。provider-freeの17 step実行で、outcomeと`turn_end`から
   `turnProviderRequestCount`だけが消え、runtime count 17だけが残ることを再現した。16 capを除去し、各terminal
   pathでcountを一回だけ取得してoutcomeとeventへ共有する。
2. **event delivery直前の二重clone**: `deliverEvent()`がevent全体をcloneする一方、loopのmessage／call／result
   event call siteがnested payloadを先にcloneしている。`deliverEvent`を唯一のevent isolation boundaryにし、
   model→transcriptとloop→toolの防御copyは維持する。
3. **未使用steering compatibility surface**: repository内にcallerがない`SteeringOwner.state`／
   `hasBeenAdmitted`、`accept()`、`steer()`と、loopの`steeringConsumer` aliasを除去する。`admit()`、一回だけの
   `consume()`、`close()`、close後の返値区別に必要なprivate stateは維持する。

### Cross-slice ledger

1. **terminal tool成功のartifact拒否（correctness、bridgeで解消済み）**: `LoopOutcome.outcome`は成功分類`final`、
   `stopReason`は終了理由`tool_terminal`を表す意図的な二段階contractであり、corpusとwork-tool sentinelもこのpairを
   検証している。一方、Worker artifact validatorは両fieldの完全一致を要求するため、正常なterminal tool結果を
   `history_invalid`またはartifact invalidとして拒否する。二fieldを即時統合するreviewer案は現行contractを変える
   ため採用しなかった。`LoopOutcomeKind`としてsuccess分類を型で明確化し、artifact validatorが
   `final/tool_terminal` pairを正当に受理するcross-slice bridgeをSlice 2より前に完了した。
2. **execution controlの二重入口**: cancellation、diagnostic、request count、source projectionが
   `AgentTurnOptions`と`ModelExecutionContext`へ重複し、Workerは同じownerを二重配線している。named context optionsと
   execution context単一ownerへの収束はWorker／Session callerを扱うsliceへ送る。未使用`persistDiagnostic()`も同時に
   除去候補とする。
3. **request budgetの二重counter表現**: 同期child lane削除後の`parent`／`aggregate`は常に同値で、limit比較も同じ
   counterを使う。model requestとweb_searchの追加requestが同じbudgetを消費する動作を維持し、一つの`limit`／
   `used`へ縮める案をTools／Worker sliceへ送る。
4. **廃止済みauto-compaction metrics**: model stepごとに、常にbefore=after、triggered=false、compressed=0となる
   legacy 10-field metricsを計算して捨てている。defensive cloneとcommit後の表示用byte測定を分離し、legacy Surface
   contractをSession／Surface sliceで収束させる。
5. **Host provider環境の二重materializationとheadless default差異（Slice 2から送付）**: TUIはCLIで外部宣言を
   loadしてprocess-global catalogへ入れた後、`createWorkerSession()`が同じconfigを再度loadしてWorkerへ渡す。
   二回の間にconfigが変わるとHostとWorkerのsnapshotが分かれる。またheadless `henji run`は後者だけを行い、
   new Sessionのroot selectionをstatic `ROOT_DEFAULT_MODEL_SELECTION`から作るため、`openrouter-chat`宣言のdefaults
   overrideがTUIでは効くがheadlessでは効かない。CLI／Host所有を扱うSlice 8または12で、一invocation一つの
   immutable provider environmentをpicker、initial selection、Worker commandへ共有する。

### 採用しない単純化

- `cleanup_failed`を`cancelled`へ統合しない。実resource settlement失敗とWorker generation unavailable化に必要。
- cancellation checkはawait前後とre-entrant event deliveryで意味が異なるため、重複に見えることだけを理由に削らない。
- defensive cloneを全面撤去せず、event delivery直前の二重copyだけを除く。
- legacy thresholdでauto-compactionを復活させない。
- source-attribution sidecarをmessageから再推論しない。
- tool batchを並列化せず、steeringをsafe post-tool boundaryより前へ動かさない。

## Slice 1修正計画（実施済み）

1. `core/loop.ts`でturn countの16 capを除去し、各terminal pathのrequest count snapshotを一回へ集約する。
2. `deliverEvent`直前のnested `snapshot()`を除去し、event sink isolationのownerを`core/events.ts`へ一本化する。
3. steeringの未使用getter／method／option aliasを除去する。
4. `current_code_test.ts`へ、17 request countのoutcome/event一致、sinkによるnested payload mutationがtranscript／tool inputへ
   影響しないこと、steeringの一回admission／consume／close semanticsを確認するfocused regressionを追加する。
5. `v0:check`、対象focused test、format、lint、`git diff --check`を実行する。full gateは実行しない。
6. 同じgpt-6-astra xhigh reviewerが変更箇所と既存3 findingの解消だけを15分以内で再reviewする。
7. Slice 1を閉じた後、上記correctness findingのcross-slice bridgeを先に実施するか、利用者判断に従う。

## Slice 1実装結果

- turn request countの16 capを除去し、normal、contract failure、cancelの各terminal projectionでcount snapshotを
  一回だけ取得してoutcomeと`turn_end`へ共有した。17 model requestの正常turnで両方が17を保持し、count callbackが
  各一回だけ読まれることを確認した。
- message、tool call、tool result、steering eventのnested pre-delivery cloneを除去した。`deliverEvent()`のevent全体
  cloneを唯一のsink isolation boundaryとし、model resultからtranscript、loopからtool dispatchへのcopyは維持した。
- `SteeringOwner`の未使用getter、`accept()`／`steer()` aliasと、loopの`steeringConsumer` aliasを除去した。
  `admit()`／`consume()`／`close()`の一message contractは不変。
- `current_code_test.ts`へ3件のregressionを追加した。

## Slice 1検証結果

- `current_code_test.ts`: **16 passed**。
- `auto_compaction_test.ts`: **4 passed**。
- Increment 39 cancellation settlement: **4 passed**。
- `v0:check`、repository全体のformat check、lint、`git diff --check`: 成功。
- 同じgpt-6-astra xhigh reviewerの15分限定re-review: **findingなし**。変更箇所、既存3 findingの解消、具体的な
  regressionだけを確認した。
- full gate、実provider call、binary build／配置、pushは実施していない。

## Terminal artifact cross-slice bridge（実施済み）

Slice 1 reviewで見つかったcorrectness問題を、Slice 2へ進む前に次の最小bridgeで修正する。

1. `core/contracts.ts`で`LoopOutcome.outcome`を成功／失敗の分類、`stopReason`を具体的な終了理由として型で区別する。
   `tool_terminal`成功は現行どおり`outcome: 'final'`／`stopReason: 'tool_terminal'`を維持する。
2. `worker_execution_artifact.ts`のvalidatorを同じ二段階contractへ合わせ、上記pairを有効とする。それ以外は
   outcomeとstop reasonの現行対応を維持し、不正な組合せは拒否する。
3. terminal toolのLoopOutcomeをWorker artifact storeへ渡し、validation／write／readbackが成功するfocused regressionを
   追加する。既存のdirect terminal tool testも実行する。
4. focused test、`v0:check`、format、lint、`git diff --check`を実行する。full gateは実行しない。
5. 同じgpt-6-astra xhigh reviewerが、artifact contract変更とregressionだけを15分以内で再reviewする。

このbridgeではcorpus、work-tool sentinel、provider-visible behavior、SQLite schemaを変更しない。

### Bridge実装・検証結果

- `LoopOutcomeKind`を追加し、粗い`outcome`から`tool_terminal`を除外した。正確な終了理由は`stopReason`に残した。
- Host fallback projectionは`tool_terminal`を現行契約どおり`final/tool_terminal`へ明示変換する。
- Worker artifact validatorは通常理由の一致を維持し、`final/tool_terminal` pairだけを追加で受理する。
- fake Worker capsuleから実Host coordinatorと`FakeWorkerExecutionArtifactStore`を通し、artifact durability `yes`、
  validation／write／readback、final text、terminal kindを確認した。
- Worker foundation: **26 passed**。`current_code_test.ts`: **16 passed**。
- `v0:check`、format、lint、`git diff --check`: 成功。
- 同じgpt-6-astra xhigh reviewerのbridge限定re-review: **findingなし**。
- full gate、実provider call、binary build／配置、pushは実施していない。

## Slice 2 — Provider selection／configuration／authorization

### 対象

- model catalog／selectionとbuilt-in default data
- external provider declarationのdecode／validation／effective catalog
- auth profile、credential resolution、declaration request headers
- production provider runtimeのconfiguration materialization
- 上記contractと動作を直接検証するtest

provider HTTP transport、SSE／Responses parser、provider evidence、auxiliary request executionはSlice 3へ送る。CLI／TUIの
selection UI、Definition compositionはcallerとしてread-only参照できるが、本sliceでは修正しない。

### 評価基準

- provider／model／effort／auth identityやvalidationを同じ意味で重複表現していないか。
- built-in default dataとTypeScript hard-codeの間に、意味を増やさないcopyや分岐がないか。
- external declarationからeffective catalog／runtime configurationまでのownerと変換が追いやすいか。
- credential source、auth profile、header templateの責務が不要に分散または循環していないか。
- Increment 58〜68／101後の未使用compatibility seamやtest都合のproduction contractが残っていないか。

現行のprovider route、external declaration、session selection、credential非記録、Authorization非記録の契約は維持する。
一般的hardening、未観測provider variant、transport/parserの変更は評価対象にしない。

## Slice 2 review結果

gpt-6-astra xhigh reviewerはprimary source 13 fileとbuilt-in JSONを全件確認し、selectionのadmission／persistence、
Worker materialization、CLI／headless startupをfindingの到達先に限って参照した。focused provider testはIncrement 12
3件、14 21件、15 6件、66 3件、101 13件の計**46件が成功**した。full gate、実credential／利用者configの読取、
実provider callは行っていない。

coordinating ownerはfindingを現行source、architecture、Increment 63／64／101の要件と最小再現へ照合した。Chat宣言
`demo-chat`に対し、正しいcatalog memberを持ちながら`api`だけを`openai-responses`へ変えたselectionと、
`authProfile`だけを別のpattern-valid IDへ変えたselectionが、どちらも`isModelSelection()`で`true`になることを再現した。

### Slice 2で修正するfinding

1. **external selection identityをcatalog membershipだけで受理する**: `isStoredModelSelection()`はunknown providerに
   二protocolと任意のvalid auth profileを許す構造decodeであり、これはcurrent catalogから独立したSession decodeとして
   維持する。一方effective validationの`isModelSelection()`もmodel／effort membershipしか追加確認しないため、宣言と
   異なる`api`／`authProfile`を受理する。wrong APIはHost admission／一時persist後にWorker materializationで失敗し、
   wrong authはSession attributionがprofile Bを示しながらrequestは宣言profile Aでcredentialを解決する。宣言から
   selection identityを作る一つのconstructor／matcherをdefault、select、effective validationで共有する。
2. **effective catalog／default所有が三層に分かれる**: `model_catalog.ts`がbuilt-inごとにgeneric declarationと
   OpenRouter／OpenAI helperのどちらを使うか分岐し、二つのspecialist catalogもそれぞれactive declarationとbundled
   fallbackを再解決する。bundled JSONは一方で未検証castからconstantを作り、別経路で呼出しごとに再validationする。
   provider／effort identityの配列・predicateも複数fileに重複する。この分割が上記identity照合漏れを生んだため、
   bundled declarationの一回validation、全provider共通のeffective declaration lookup、宣言からのselection構築、
   catalog membership／default／search／selectを一ownerへ収束する。specialist moduleはcompatibility exportとChat profile
   構築だけに縮め、route固有の`api`／auth literalは維持する。
3. **credential sourceの旧provider別alias**: `createProductionPhysicalIo()`の`credentialSource`と
   `openAICredentialSource`はproduction callerが使わず、testだけがgeneric `credentialSources`と同じ
   auth-profile→source mappingを別名で保持している。generic mapだけを残し、testを
   `openrouter-api-key`／`openai-api-key` entryへ移す。request時解決、credential分離、非記録は変えない。

### Cross-sliceへ送るfinding

- TUIと`createWorkerSession()`によるexternal provider configの二重load、およびheadless startupがbuilt-in defaults
  overrideをroot selectionへ反映しない問題は成立する。ただし一つのHost provider environmentをCLI picker、Session、
  Worker protocolへ共有する変更が必要なため、本Sliceでは直さず上記ledger 5へ送る。

### 採用しない単純化

- persisted Session decodeをcurrent catalogへ依存させない。構造decodeとeffective availability validationは分ける。
- built-in route固有の`api`／auth identity、planner role default、OpenRouter Chat／Responsesの独立overrideを統合しない。
- 同一内容のOpenRouter catalogをdata参照schemaへまとめない。route独立性を弱め、解決規則をJSONへ移すだけになる。
- declaration header validationとrequest-time placeholder置換、credential fileのstable read、resolver boundaryを統合・削除しない。
- provider transport／parser、`PRODUCTION_PROFILE` consumerは後続sliceへ残す。

## Slice 2修正計画（承認済み）

1. `model_selection.ts`をprovider IDとreasoning effortのprimitive ownerにし、provider ID validator、effort values／
   predicate、built-in ID一覧を宣言decodeとbundled role default parsingから共有する。built-in override ID一覧は同じ
   built-in一覧から導出し、同じliteral／regex／effort配列の重複を除く。
2. `provider_declaration.ts`でbundled provider declarationsを一度だけvalidationして固定する。productionで使わない
   `ProviderRegistry.get()` wrapperは除き、resolved declaration arrayをHost→Workerへ渡す現行data contractをそのまま
   resolverの返値にする。
3. `provider_runtime.ts`にactive declaration優先、validated bundled fallbackのeffective declaration lookupを一つ置く。
   `model_catalog.ts`は全4 built-inとexternal providerを同じlookupから処理し、provider固有API identityを保持した
   declaration→selection constructor／matcher、default、entry、search、select、effective validationを所有する。
4. `openrouter_model_catalog.ts`／`openai_model_catalog.ts`のcatalog／selection helperを上記generic ownerへの薄いwrapperへ
   し、独立したactive/fallback分岐を除く。OpenRouter request profile構築と従来export名は維持する。
5. `worker_physical_io.ts`からtest専用の二つのcredential aliasを除き、該当testを`credentialSources` mapへ移す。
6. `increment_14_multi_provider_test.ts`へ、external Chat selectionの正しいidentityだけが通り、wrong API／wrong authが
   effective validationで拒否されるregressionを追加する。既存の4 built-in defaults、override、search、select、
   valid external materialization testをgeneric ownerの回帰として維持する。
7. 変更したcredential seamの既存test、Increment 12／14／15／66／101、必要なtype check、format、lint、
   `git diff --check`を実行する。full gateと実provider callは行わない。
8. 同じgpt-6-astra xhigh reviewerが変更箇所と上記3 findingの解消だけを15分以内で再reviewする。

### Slice 2実装・focused検証

- `model_selection.ts`のprovider IDとreasoning effort predicateを宣言decodeとbundled role defaultで共有した。
  bundled provider JSONは`provider_declaration.ts`で一度だけvalidationし、resolverはHostとWorkerがそのまま扱う
  declaration arrayを返す。
- active優先・bundled fallbackのlookupを`provider_runtime.ts`へ一つ置いた。`model_catalog.ts`が宣言から
  selection identityを構築し、default、entry、search、select、effective validationを全providerで共通処理する。
  external Chat selectionの宣言と異なるAPIまたはauth profileはeffective validationで拒否する。
  provider別catalogの従来exportは共通処理への薄いwrapperとし、Chat request profile構築は維持した。
- Worker physical I/Oのtest専用credential alias二つを除き、該当testをauth profile別`credentialSources`へ移した。
  credentialのrequest時解決と非記録は変更していない。
- focused test: Increment 12 **3件**、14 **21件**、15 **6件**、66 **3件**、101 **13件**、provider stream
  compatibility **19件**、変更したcredential seamに直接関わるIncrement 7 **5件**、91 **10件**、92 **11件**、
  すべて成功。`v0:check`、`v0:fmt`、`v0:lint`、`git diff --check`も成功。
- full gate、実provider call、binary build／配置、pushは実施していない。

### Slice 2限定再review

gpt-6-astra xhigh reviewerは変更したprovider/catalog/credential sourceとCLI／Worker caller、関連test差分を
15分以内でread-only確認した。既存3 findingの解消と具体的なregressionを確認し、**findingなし**。
外部Chat identityとmock requestのfocused test 1件、`git diff --check`も成功。full gateと実provider callは
行っていない。

## Slice 3 — Provider transport／stream／evidence

### 対象

- `v0/agent/provider/openai_responses_model.ts`
- `v0/agent/provider/openrouter_contract.ts`、`openrouter_model.ts`、`openrouter_request.ts`、
  `openrouter_response.ts`、`openrouter_sse.ts`、`openrouter_transport.ts`、`openrouter_value.ts`
- `v0/agent/provider/provider_evidence.ts`、`provider_evidence_store.ts`、`auxiliary_request.ts`
- 上記のprotocol・stream・evidence動作を直接検証するtest

selection／configuration／authorizationはSlice 2、Worker／Host orchestrationとhistory semantic modelは後続Sliceの対象。
理解に必要なcallerはread-onlyで参照できるが、本Sliceで修正しない。

### 評価基準

- Chat／Responses transportとstream decodeで、同じ観測または状態遷移を意味なく重複表現していないか。
- request生成、response parse、provider evidence保存のownerが追いやすいか。
- raw response／SSE event／provider metadata／request countの診断可能性と、credential・Authorization非記録を維持して
  簡潔にできるか。
- 現行のtool call、partial stream、completion、auxiliary requestのproduction動作を維持できるか。

公式外部契約または実行証拠のないprovider variantは仕様化しない。一般的hardeningと網羅matrixは対象外。
findingにはsource-to-impact、保持するproduct動作、単純化案、regression risk、対応するfocused testを要求する。

### Slice 3 review結果とowner照合

gpt-6-astra xhigh reviewerは上記11 sourceと直接caller・関連testをread-onlyで確認した。Increment 100の既存3 testは
成功し、以下2件はprovider-freeの実dispatcher／stream再現と現行sourceでownerも照合した。full gate、実provider call、
変更は行っていない。

1. **連続Chat SSEのdeadlineがrequestをabortしない（Slice 3）**: `openrouter_sse.ts`のloop先頭はelapsed timeoutで
   `provider_timeout`を作って抜けるが、readerをcancelしない。`openrouter_transport.ts`はfinallyでtimerを消すため、
   fetch signalにもabortが届かない。連続mock streamでは`provider_timeout`後もreader cancel・fetch abortともfalse。
   Increment 100が定めたdeadline時のabort／noncanonical settlementに反し、終了済みturnのrequestが残り得る。
2. **auxiliary responseの途中失敗で受信済み証拠が消える（cross-slice bridge）**:
   `auxiliary_request.ts`は`response.arrayBuffer()`完了までstatus・headers・bytesを記録せず、返値を受けた
   `tools/web_search.ts`が記録している。実dispatcher→Sonar backendのmockでHTTP 200・25 bytes受信後のbody
   interruptionを再現すると、evidenceはrequest startだけでresponse status・bytesなし。現product policyと
   Increment 7のraw response保持に反する。tool側の重複記録除去が必要なためSlice 4とのbridgeとして扱う。

progress専用byte計測・停止状態は、本文semantic上限と同値の上限を再確認しているが、具体的なproduct correctness問題
または利用者影響を示す証拠がないためfindingに採用しない。未使用observer seamを理由に挙動変更やtest追加は行わない。

### Slice 3修正・cross-slice bridge計画（承認待ち）

1. `openrouter_transport.ts`でtimerとelapsed判定を一つのdeadline abort処理へ集約する。
   `openrouter_sse.ts`のelapsed timeout pathはactive readerをcancelしてから`provider_timeout`へsettleする。
   cancellation優先、request count、partial evidence、stall時のtimer動作を維持する。
2. `auxiliary_request.ts`がresponse headers受信時にevidence response startを記録し、body chunkを受けるごとに
   raw bytesを記録する。toolへ返すbytesは受信順に結合して従来のparseへ渡す。
   `tools/web_search.ts`の返却後の重複記録を除く。request開始のexact capture順序、credential・Authorization非記録、
   cancel／deadline分類を維持する。tool file変更はこのbridgeに限定する。
3. Increment 100の連続Chat testでfetch signal abortとreader cancelを確認する。auxiliaryの既存成功経路と、
   response status・partial bytesがbody interruption後にreadback可能な経路をfocused testへ追加する。
4. 対象focused test、必要な`v0:check`、format、lint、`git diff --check`を実行する。full gateと実provider callは
   行わない。gpt-6-astra xhigh reviewerが変更箇所と2 findingの解消だけを15分以内で再reviewする。

この計画はprovider wire contract、SQLite schema、model-visible tool contract、構想・architecture・roadmapを変えない。
