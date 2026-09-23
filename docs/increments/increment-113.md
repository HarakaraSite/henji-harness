# Increment 113 — codebase構造の単純化review

## 状態

**Slice 1とterminal artifact bridge、Slice 2〜18完了。authoritative `v0:gate`成功**

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

Slice 1と優先cross-slice bridge、Slice 2・3・4・6・7の修正とSlice 5のread-only reviewは完了した。
Slice 8のread-only review、承認済み2件の修正、focused検証、限定再reviewは完了した。
Slice 9のread-only review、承認済み1件の修正、focused検証、限定再reviewは完了した。
Slice 10のread-only review、承認済み3件の修正、focused検証、限定再reviewは完了した。
Slice 11のread-only review、承認済み2件の修正、focused検証、限定再reviewは完了した。
Slice 12のread-only review、承認済み1件の修正、focused検証、限定再reviewは完了した。
Slice 13のread-only review、承認済み3件の修正、focused検証、限定再reviewは完了した。
Slice 14のread-only reviewとowner照合、承認済み2件の修正、focused検証、隔離XDGのproduction TUI確認、
限定再reviewは完了した。Slice 15も利用者承認済み計画の実装、focused検証、production TUI確認、
限定再reviewを終えた。Slice 16・17も承認済み修正、focused検証、限定再reviewを終えた。Slice 18の
read-only convergenceも追加findingなく完了し、安定候補のauthoritative `v0:gate`が一回で成功した。

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
6. **lazy resume直後のrename拒否（Slice 12からSlice 13へ送付）**: Increment 76はresume後のrename等のlive操作で
   初めてWorkerを起動すると定める。`LazyWorkerSession.renameTitle()`は未起動Hostなら`unavailable`を返し、
   presentationの`renameCurrent`は同期portである。provider-free実Workerの保存turn→new session→resume→renameで、
   resume後のrenameが拒否され、titleが保存されないことを確認した。同期navigation／presentation contractも
   変える必要があるため、本Sliceでは修正せず、Slice 13で修正計画を判断する。

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

### Slice 3修正・cross-slice bridge計画（承認済み・実施済み）

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

### Slice 3実装・focused検証

- Chat SSEのtimerとelapsed判定が同じdeadline abort処理を呼ぶようにし、elapsed timeout時はactive readerもcancelしてから
  `provider_timeout`へsettleする。連続stream testでfetch signalのabortとreader cancelを確認した。
- auxiliary dispatcherはresponse headers受信時にstatus・headersを記録し、body chunkごとにraw bytesを記録する。
  受信順に結合したbytesを従来のtool parseへ返し、`web_search`の返却後の重複記録を除いた。body interruptionのfocused
  testで、HTTP 200・headers・受信済み6 bytesのreadbackを確認した。既存の成功経路、exact request capture順序、
  credential・Authorization非記録も維持した。
- focused test: Increment 100 **3件**、Increment 7 **6件**、provider stream compatibility **19件**、Increment 92
  **11件**、すべて成功。`v0:check`、`v0:fmt`、`v0:lint`、`git diff --check`も成功。
- gpt-6-astra xhigh reviewerが変更箇所と採用2件の解消だけを15分以内でread-only再reviewし、**findingなし**。
  reviewerはfull gateを実行していない。
- full gate、実provider call、binary build／配置、pushは実施していない。

## Slice 4 — Tools／effects

### 対象

- `v0/agent/tools/`のtool registry、bundled effect、work-tool I/O、web fetch／search、async agent tool RPC seam
  （同directoryのsource全件）
- 上記のtool dispatch、effect、結果のproduct動作を直接検証するtest

Worker／Hostのchild lifecycle、provider transport、Definition composition、Session／historyは後続Sliceの対象。
理解に必要なcallerはread-onlyで参照できるが、本Sliceでは修正しない。Slice 3で変更した`web_search`のauxiliary
evidence bridgeはcurrent sourceとして扱い、修正済みfindingを再起票しない。

### 評価基準

- tool宣言・dispatch・resultと、実際のeffect実行のowner・状態遷移が追いやすいか。
- 同じ入力decode、result projection、resource／request counterを意味なく重複表現していないか。
- filesystem、bash、web、async agent toolの現在のproduct動作と、tool call/result、cancel、terminal contractを
  維持しながら単純化できるか。
- test helperや過去のcompatibility seamがproduction contractへ逆輸入されていないか。

一般的hardening、未観測variant、網羅matrix、要件変更は評価対象にしない。findingには明示要件・実行証拠・現行source
から利用者影響への経路、保持すべきproduct動作、単純化案、regression risk、対応するfocused testを要求する。


### Slice 4 review結果とowner照合

gpt-6-astra xhigh reviewerは`v0/agent/tools/`の15 sourceと直接関係するtest／callerをread-onlyで確認した。
focused testはIncrement 4 **5件**、Increment 5 **11件**、Increment 70 web_fetch **4件**が成功した。
coordinating ownerは以下2件を現行sourceとIncrement 4／70の明示要件へ照合し、採用した。full gate、実provider
call、変更は行っていない。

1. **`read`が同じoffsetを案内し続ける（P2）**: Increment 4 §4は案内込み64 KiB、完全line単位のwindow、
   選択lineがcontent budgetを超える場合のline番号付きerrorを定める。`readWindow()`は65,536 bytesの先頭lineと
   後続lineがある場合、案内を収めるため先頭lineをpopして空window専用案内`offset=1`を返す。案内どおり
   再実行しても同じ結果になり、人間／modelがfile内容へ進めない。案内のため一lineも残せない場合は
   line番号付きerrorへ収束させる。
2. **`web_fetch`が上限ちょうどの完全な本文をtruncatedと表示する（P3）**: Increment 70は1 MiB超過時の
   打切りと実際の切り詰め有無の返却を定める。`readBoundedBody()`の`>= remaining`は、本文がちょうど
   1,048,576 bytesでEOFでも`truncated: true`と`[body truncated]`を返す。人間／modelが完全な取得結果を
   不完全と誤認する。上限ちょうどでは次readでEOFか超過かを確定し、実際に捨てたbyteがある場合だけ
   truncatedにする。

追加cross-slice findingはない。未観測のfilesystem／permission permutationや一般的hardeningは採用しない。

### Slice 4修正計画（承認済み・実施済み）

1. `work_tool_file_io.ts`のcontinuation markerを組み立てるloopで、案内を収めるため最後のselected lineを
   外す前後に進捗可能性を確認し、一lineも返せない場合は既存のline番号付きread errorを返す。小さいfile、
   通常の複数line paging、64 KiB以内のresult、complete-line semanticsを維持する。
2. `web_fetch.ts`のbounded body読取で、上限ちょうどのchunkを保持して次readでEOF／超過を判定する。
   超過時の1 MiB打切り、cancel、`truncated`表示を維持する。
3. Increment 4へ上記長い先頭lineと後続lineの実tool regression、Increment 70へ上限ちょうどの完全本文と
   既存超過本文のregressionを追加する。対象focused test、必要な`v0:check`、format、lint、
   `git diff --check`を実行する。full gateと実provider callは行わない。
4. 同じgpt-6-astra xhigh reviewerが変更箇所と2 findingの解消だけを15分以内でread-only再reviewする。

この計画はmodel-visible tool contract、SQLite schema、構想・architecture・roadmapを変えない。

### Slice 4実装・focused検証

- `readWindow()`のcontinuation marker生成で、案内を収めるため一lineも返せなくなった場合はline番号付き
  read errorを返す。空windowの同じoffset案内を削除し、不要になったselected line size配列も除いた。
- `web_fetch`のbody上限判定を超過時だけの打切りへ変更し、上限ちょうどでは次readでEOFを確認する。
  完全な1 MiB本文は`truncated: false`、超過本文は従来どおり`truncated: true`となる。
- focused test: Increment 4 **5件**、Increment 70 web_fetch **5件**成功。`v0:check`、`v0:fmt`、
  `v0:lint`、`git diff --check`成功。
- 同じgpt-6-astra xhigh reviewerが変更箇所と採用2件の解消だけを15分以内でread-only再reviewし、
  **findingなし**。reviewerはfull gateを実行していない。
- full gate、実provider call、binary build／配置、pushは実施していない。

## Slice 5 — Managed resource lifecycle

### 対象

- `v0/agent/definitions/`のmanaged resource ref／identity／manifest、external Definition／Tool Definitionの
  import・revision validation・immutable store・transport、selector／slot binding／built-in catalog
- 上記lifecycleを直接検証するIncrement 33／34／69／70／76／77等のtest

Definitionのinstruction・skillの内容合成はSlice 6、Worker capsuleとHost orchestrationは後続Sliceの対象。
CLI install／list／inspect、Worker起動時のexact revision解決は到達先としてread-only参照できるが、本Sliceでは修正しない。

### 評価基準

- logical ref、content digest、manifest、local custody、activation bindingのownerと変換が追いやすいか。
- Agent／Toolのmanaged lifecycleで、意味を増やさない重複や旧compatibility seamがないか。
- install、immutable revision readback、transport、select／activate、同一revisionの再利用が現行product契約どおり
  成立したまま単純化できるか。
- test helperの都合がproduction manifest／store／selector contractへ逆輸入されていないか。

構想・architecture・roadmap、外部provider contract、SQLite schemaの変更は対象外。一般的hardening、未観測variant、
網羅matrixを評価対象にしない。findingには明示要件・実行証拠・現行sourceから利用者影響への経路、保持すべき
product動作、単純化案、regression risk、対応するfocused testを要求する。

### Slice 5 review結果

gpt-6-astra xhigh reviewerはmanaged ref／identity／manifest、import、revision validation、store、transport、
selector／binding／catalogと、CLI／Workerの直接呼出経路をread-onlyで確認した。Agent／Tool store・validatorに
構造の重複はあるが、現行product動作または利用者影響を示せず、採用基準を満たすfindingは**なし**。
追加cross-slice findingもない。focused testはIncrement 33 **11件**、34 **6件**、69 **4件**、70 tool declaration
**2件**、76 **3件**、77 **5件**の計**31件**成功。full gate、compiled binary、実provider callは未実施。

## Slice 6 — Composition／instructions／skills

### 対象

- `v0/agent/instructions/`のbase instruction、component、compose、runtime facts、role、mandatory finalizer
- `v0/agent/definitions/agent_instructions.ts`、`skills.ts`、`agent_definition.ts`のcomposition contract
- `v0/agent/runtime/runtime.ts`と`v0/agent/worker_agent_api.ts`のcomposition materialization経路
- 上記を直接検証するIncrement 16／103等のtest

managed resourceのimport／store／bindingはSlice 5、Worker capsule／Host orchestrationは後続Sliceの対象。
native `AGENTS.md`／`SKILL.md` discoveryとprovider requestへの最終instruction投影は到達先としてread-only参照できるが、
本Sliceで修正しない。

### 評価基準

- built-in core、user `instruction.md`、role、workspace instruction、Skill、runtime facts、tool guidelineの
  合成順とprovenance ownerが追いやすいか。
- immutableな選択結果とturnごとの実行時inputを意味なく重複して表現・copyしていないか。
- root／planner、外部Definition、Skillの現在のproduction動作を維持して単純化できるか。
- test fixtureのためだけの合成分岐や旧compatibility seamがproduction経路に残っていないか。

構想・architecture・roadmap、外部provider contract、SQLite schemaの変更は対象外。一般的hardening、未観測variant、
網羅matrixを評価対象にしない。findingには明示要件・実行証拠・現行sourceから利用者影響への経路、保持すべき
product動作、単純化案、regression risk、対応するfocused testを要求する。

### Slice 6 review結果とowner照合

gpt-6-astra xhigh reviewerはinstruction合成とWorker composition、関連test、native discoveryとprovider投影の直接
callerをread-onlyで確認した。Increment 16 **4件**、103 **7件**、native Skill関連 **2件**が成功した。coordinating
ownerは以下1件を現行source、architectureのAgentManifest契約、Increment 109のasync agent宣言へ照合して採用した。
full gate、compiled binary、実provider call、変更は行っていない。

1. **async agent宣言がexecution manifestから欠落する（P2）**: builtin rootの`AgentCapabilityDeclaration.asyncAgents`と
   `resolved.resourceSelection.resources`は`agent:planner`を含み、`spawn_subagent`も利用可能である。しかし
   `worker_agent_api.ts`の`manifestFor()`はmodel／instructions／skills／toolsを別途列挙し、async agentsを落とす。
   Worker readyから保存されるexecution manifestの`resources`では、選択されたasync agentをreadback・比較できない。
   manifestを確定済みresource selectionから投影し、二重列挙をなくす。

ほかの採用findingと追加cross-slice findingはない。instruction順序とselected baseのmandatory finalizer経路は現行契約に
整合している。

### Slice 6修正計画（承認済み・実施済み）

1. `worker_agent_api.ts`の`manifestFor()`が`capabilities`からresource listを再構築する経路を除き、
   `effectiveResolved.resourceSelection.resources`を唯一のprojection元にする。default／planner双方で、model、
   instructions、skills、tools、async agents、追加toolのidentityをmanifestへ渡す。
2. mandatory base finalizerは現行どおりbase identityをmanifestとresolved selectionへ追加し、Worker runtimeの
   model切替時の`model:` identity置換は維持する。provider-visible instruction本文、tool可用性、async childの
   spawn contractは変更しない。
3. Increment 16へbuiltin root／plannerのmanifest resourcesとresolved selectionの一致、およびrootの
   `agent:planner`保持を確認するfocused regressionを追加する。provider-free Workerの保存execution manifestでも
   `agent:planner`のreadbackを確認する。対象focused test、必要な`v0:check`、format、lint、
   `git diff --check`を実行し、full gateと実provider callは行わない。
4. 同じgpt-6-astra xhigh reviewerが変更箇所とfindingの解消だけを15分以内でread-only再reviewする。

この計画は構想・architecture・roadmap、SQLite schema、model-visible tool contractを変えない。

### Slice 6実装・focused検証

- `manifestFor()`のcapability再列挙を除き、確定済みresource selectionを投影した。manifestは従来の辞書順を
  維持する。resolved selectionはresource kind順なので、順序の差だけをfocused testで正規化して照合した。
- builtin rootのmanifestは`agent:planner`を保持し、plannerのmanifestには含まれない。mandatory base finalizer、
  追加tool、model identity置換の経路は維持した。provider-free実Workerの保存execution artifactでも
  `agent:planner`のreadbackを確認した。
- focused test: Increment 16 **4件**、provider-free headless Worker artifact **1件**成功。`v0:check`、
  `v0:fmt`、`v0:lint`、`git diff --check`成功。reviewer追加確認のIncrement 70 tool declaration **2件**も成功。
- 同じgpt-6-astra xhigh reviewerが変更箇所と採用findingの解消だけを15分以内でread-only再reviewし、
  **findingなし**。full gate、実provider call、binary build／配置、pushは実施していない。

## Slice 7 — Worker capsule

### 対象

- `v0/agent/worker/worker_bootstrap.ts`、`worker_capsule.ts`、`worker_definition_revision.ts`、
  `worker_protocol.ts`、`worker_runtime.ts`、`worker_physical_io.ts`、`worker_probe_physical_io.ts`、
  `recalled_execution_context.ts`、`worker_history_projection.ts`
- `worker_builtin_*`のWorker-local Definition／Tool Definition entry
- 上記のWorker起動、module load、turn実行、event／result投影を直接検証するtest

Host orchestration（`worker_host_*`、child registry、queue、journal、artifact store、headless／TUI Host session）は
Slice 8以降の対象。managed revision storeはSlice 5、instruction compositionはSlice 6、history persistenceは
Slice 9以降の対象。直接callerは理解に必要な範囲でread-only参照できるが、本Sliceでは修正しない。

### 評価基準

- Worker起動からDefinition load、composition、turn実行、event／result送信までのownerと状態遷移が追いやすいか。
- Worker内で同じ状態・identity・count・evidenceを意味なく重複表現していないか。
- provider-freeとproduction physical I/O、cancel、async child RPC、checkpointの現行product動作を維持して
  単純化できるか。
- test fixtureのためだけのproduction seamや旧compatibility経路が残っていないか。

一般的hardening、未観測variant、網羅matrix、要件変更は評価対象にしない。findingには明示要件・実行証拠・現行source
から利用者影響への経路、保持すべきproduct動作、単純化案、regression risk、対応するfocused testを要求する。

### Slice 7 review結果とowner照合

gpt-6-astra xhigh reviewerはWorker capsule／bootstrap／runtime／physical I/O／protocol／built-in entryと直接test・callerを
read-onlyで確認した。Worker foundation **26件**、model switching **3件**、recall **6件**、context revision **1件**の
計**36件**が成功した。coordinating ownerは以下2件を現行source、production利用経路、Increment 89のdirect causal
contractへ照合して採用した。full gate、実provider call、binary確認、変更は行っていない。

1. **配送済みWorker messageの無期限保持（P2）**: `worker_capsule.ts`はsubscriberへmessageを配送した後、対応
   waiterがなければ同じmessageをprivate queueへ追加する。production `WorkerSupervisor`はsubscribeのみでqueueを
   消費しない。provider-freeのproduction sessionで8 KiB taskを3回成功させると、保持message数は
   **33→41→49**、queueのJSON相当bytesは**151,867→335,427→575,575**と増え、完了済みevidenceと過去turnの
   完全transcriptが残った。この数値はheap使用量ではない。購読配送とprobe／waiter用inboxを分け、productionが
   消費しない履歴を保持しない。
2. **planner rootのcontextから直接Worker fact参照が欠落（P2）**: `worker_runtime.ts`の`sourceForMessage()`だけが
   composition roleから`planner` laneを作るが、root実行の`runAgentTurn`、provider evidence、context deltaは
   `parent` laneを使う。provider sequence mapを誤ったlane keyで引くため、標準planner compositionのread→finalで
   current-execution／tool-result source relation **4件すべて**の`sourceWorkerSequence`が欠けた。同じdefault
   compositionでは4件とも保持した。Increment 89 §3が要求する直接fact相関がplanner rootのcontext readbackで
   失われる。root executionのlane authorityを共有し、roleからの再判定を除く。

追加cross-slice findingはない。未観測のprovider／permission variantや一般的hardeningは採用しない。

### Slice 7修正計画（承認済み・実施済み）

1. `worker_capsule.ts`で、active waiterには従来どおりmessageを配送し、subscriberへ配送したunmatched messageは
   probe用queueへ保存しない。subscriberがないprobe／`waitForMessage`経路だけunmatched messageを保持する。
   `close()`／`terminate()`と、waiter登録前後の受信順序を維持する。
2. `worker_runtime.ts`のroot `sourceForMessage()`でroleからlaneを再導出せず、model request／provider observationと
   同じ`parent` laneを使う。plannerのrole・model selectionは変更せず、current-execution／tool-resultの
   `sourceWorkerSequence`を対応factへ結ぶ。
3. Worker foundationのprovider-free production sessionで複数turnを実行し、subscriber配送後のmessage queueが
   増えないことを確認する。既存のprobe wait／close／terminate testも実行する。Increment 89でprovider observation
   port付きのdefault／planner root双方について、read→final後のcurrent-execution／tool-result source relationが
   direct Worker sequenceを保持するfocused regressionを追加する。
4. 対象focused test、必要な`v0:check`、format、lint、`git diff --check`を実行する。full gateと実provider callは
   行わない。同じgpt-6-astra xhigh reviewerが変更箇所と採用2件の解消だけを15分以内でread-only再reviewする。

この計画は構想・architecture・roadmap、SQLite schema、model-visible tool contractを変えない。

### Slice 7実装・focused検証

- `WorkerCapsule.enqueue()`はactive waiterへ従来どおり配送し、subscriberがいる場合は配送済みmessageを
  probe用queueへ蓄積しない。subscriberがいないprobe／`waitForMessage`経路のqueueは維持した。
- `WorkerGeneration.sourceForMessage()`はplanner roleからlaneを再導出せず、root実行の`parent` laneを使う。
  provider observation付きのdefault／planner rootの双方で、read→final後のcurrent-execution／tool-result
  source relationがdirect Worker sequenceを保持することを確認した。
- focused test: Worker foundation **27件**、Increment 89 **2件**、model switching **3件**、recall **6件**成功。
  provider-free production sessionの3 turnで購読済みmessage queueが空のまま残ることを確認した。
  `v0:check`、`v0:fmt`、`v0:lint`、`git diff --check`成功。
- 同じgpt-6-astra xhigh reviewerが変更箇所と採用2件の解消だけを15分以内でread-only再reviewし、
  **findingなし**。full gate、実provider call、binary build／配置、pushは実施していない。

## Slice 8 — Host orchestration

### 対象

- `v0/agent/worker/worker_host.ts`、`worker_host_authority.ts`、`worker_host_children.ts`、
  `worker_host_contract.ts`、`worker_host_coordinator.ts`、`worker_host_journal.ts`、
  `worker_host_outcome.ts`、`worker_host_queue.ts`、`worker_host_session.ts`、
  `worker_host_supervisor.ts`、`worker_host_types.ts`、`worker_child_contract.ts`
- `worker_headless_runner.ts`、`worker_tui_session.ts`のHost呼出入口と、上記のadmission、message配送、
  child lifecycle、commit／settlementを直接検証するtest

Worker capsule内はSlice 7、Session canonical stateはSlice 9、history semantic model／production persistenceは
Slice 10・11の対象。関連するartifact validation／storeとCLI／TUI callerは到達先としてread-only参照できるが、
本Sliceでは修正しない。

### 評価基準

- admission、Worker generation、message queue／journal、child lifecycle、canonical commit／settlementのownerと
  状態遷移が追いやすいか。
- 同じauthority、counter、cleanup outcome、manifest／evidenceを意味なく二重表現していないか。
- root／async child、cancel、generation replacement、no-session、headless／TUIの現行product動作を維持して
  単純化できるか。
- test helperや過去のcompatibility seamがproduction Host contractへ逆輸入されていないか。

一般的hardening、未観測variant、網羅matrix、要件変更は評価対象にしない。findingには明示要件・実行証拠・現行source
から利用者影響への経路、保持すべきproduct動作、単純化案、regression risk、対応するfocused testを要求する。

### Slice 8 review結果とowner照合

gpt-6-astra xhigh reviewerは指定Host sourceと直接caller・関連契約をread-onlyで確認した。coordinating ownerは
以下2件を現行source、Increment 110／112のchild lifecycle契約、provider-free production Worker経路の実行証拠へ
照合し、採用した。

1. **処理済みprovider observationがHost queueへ蓄積する（P2）**: `ExecutionCoordinator.receive()`は
   `provider_observation`をjournalへ渡した後、`runtime_event`以外を`HostMessageQueue`へpublishする。
   queueを待つ経路はready、model selection、terminal、closedだけなので、response bytes／SSE／parser transition等は
   generation終了まで消費されない。標準`ProviderEvidenceRecorder`のobservationをprovider-free実Workerへ配送した
   3 turnではqueueが3→6→9件、serialized payloadが12,300→24,599→36,898 bytesと増えた。これはheap測定
   ではない。通常のprovider利用で処理済みresponseをturnごとに保持し続ける。
2. **child登録前のawait中にparent cleanupが完了し、後からrunが再登録される（P2）**:
   `ChildRunRegistry.spawn()`はactive parent確認後に`builtinAsyncAgentRefFor('planner')`をawaitし、再確認せず
   runを登録・admitする。その間に`cleanupParent()`／`releaseParent()`が完了すると、cleanup observationにない
   childが後からadmit／settleされ、解放したregistryにも残る。実builtin ref解決を使うdirect registry再現では、
   cleanup完了→release→child admission→cancelled settlementの順となり、3回で保持runが1→2→3件に増えた。
   Increment 110のawait可能なcleanupと112のscope解放契約に反する。

root admission中cancelの候補は、再現がproduction SQLite storeの同期返却にはない追加barrierに依存したため採用しない。
provider環境の二重materialization／headless default差異はcross-slice ledger 5に維持し、CLI／Host入口を扱う
Slice 12で検討する。その他の構造に新たなcorrectness findingは確認されなかった。focused testはIncrement 109
**9件**、110 **12件**、111 **6件**、91 **10件**、92 **11件**、Worker foundation **27件**の計**75件**成功。
child raceはregistry境界で再現済みで、実Hostでの競合時刻、compiled binary、実provider、full gateは未確認。

### Slice 8修正計画（承認済み・実施済み）

1. `worker_host_coordinator.ts`の受信処理では、`provider_observation`のjournal記録、request-start時の
   auxiliary watchdog解除、runtime-eventのSurface投影を既存順序で終え、応答待ち対象以外をqueueへ送らない。
   ready／model selection／commit proposal／turn failure／worker error／terminal turn end／closedの配送を維持する。
2. `worker_host_children.ts`のbundled planner ref解決直後、run生成・登録・durable admissionの前にparent scopeを
   再確認する。cleanup済みparentへのspawnは既存のclosed-scope errorを返し、通常spawn、exact ref選択、登録済み
   admissionへjoinするcleanup、childのterminal durabilityを維持する。
3. focused regressionでは、provider-free実Workerの複数turnでprovider observationのjournal／evidence readbackと
   Host queueの非蓄積を確認する。childではref解決中のcleanup／release後にadmission、settlement、保持runが
   発生しないことと通常spawnを確認する。変更箇所のfocused test、必要な`v0:check`、`v0:fmt`、`v0:lint`、
   `git diff --check`を実行する。full gateと実provider callは行わない。
4. 同じgpt-6-astra xhigh reviewerが変更箇所と採用2件の解消だけを15分以内でread-only再reviewする。

この計画は構想・architecture・roadmap、SQLite schema、外部provider／model-visible tool contractを変更しない。

### Slice 8実装・focused検証

- `ExecutionCoordinator.receive()`は非runtimeの`provider_observation`をjournalへ記録・flushした後に返し、
  応答待ちqueueへ保持しない。runtime-event投影、request-start watchdog解除、terminal配送は既存順序を維持した。
- `ChildRunRegistry.spawn()`はbundled planner ref解決直後にparent scopeを再確認し、cleanup済みscopeでは
  run登録・durable admissionへ進まず既存errorを返す。
- provider-free実Workerの3 turnで、標準recorderから配送したrequest start／response start／response bytesが
  各artifactのprotocol traceに残り、Host queueは各turn後に空であることを確認した。Worker自身のevidenceも
  3 turn分readbackした。Increment 92の既存Host journal testでは、provider request startのdurable readbackと
  queue非蓄積を確認した。child ref解決中のcleanup／releaseを3回繰り返し、後発admission／settlement・保持runが
  生じないことを確認した。
- focused test: Worker foundation **28件**、Increment 92 **11件**、109 **9件**、110 **13件**、111 **6件**成功。
  `v0:check`、`v0:fmt`、`v0:lint`、`git diff --check`成功。full gate、実provider call、binary build／配置、
  pushは実施していない。
- 同じgpt-6-astra xhigh reviewerが変更箇所と採用2件の解消だけを15分以内でread-only再reviewし、
  **findingなし**。reviewerの変更対応focused test **3件**と`git diff --check`も成功した。

## Slice 9 — Session canonical state

### 対象

- `v0/agent/worker/worker_host_authority.ts`のcanonical projection、record construction／validation、checkpoint、
  model selection／titleの状態更新
- `v0/agent/session/session.ts`、`semantic_context.ts`、`session_store_contract.ts`、
  `session_record_codec.ts`、`session_store.ts`のSession record型・validation・canonical state境界
- 上記のnew／resume、commit、checkpoint、model selection、title、transcript projectionを直接検証するtest

`worker_host_coordinator.ts`のcommit caller、`session_history.ts`／`session_navigation.ts`のread projectionは到達先として
read-only参照できる。history semanticsとexportはSlice 10、Deno file I/O／SQLite実装はSlice 11、Surface表示は
Slice 13以降の対象で、本Sliceでは修正しない。

### 評価基準

- canonical transcript、state revision、model selection／change、title、checkpointのownerとcommit後projectionが
  一貫しているか。new／resume、no-session、失敗・取消後の現在地が人間の操作に合うか。
- Direct `Session`とWorker Hostの`SessionAuthority`に、現行product経路で意味のない二重実装・二重状態があるか。
  動作・利用者影響を確認できない抽象的な重複だけではfindingにしない。
- record validation／codec、checkpoint projection、automatic compaction noticeが必要な意味を保ったまま
  単純化できるか。cross-slice ledger 2／4は実経路の影響が確認できる範囲だけ照合する。
- test helperや過去のcompatibility seamがcanonical Session contractへ逆輸入されていないか。

一般的hardening、未観測variant、網羅matrix、後方互換の新設、要件変更は評価対象にしない。findingには明示要件・
実行証拠・現行sourceから利用者影響への経路、保持すべきproduct動作、単純化案、regression risk、対応する
focused testを要求する。

### Slice 9 review結果とowner照合

gpt-6-astra xhigh reviewerは指定sourceと直接commit caller、new／resume／model selection／title／checkpointの
投影をread-onlyで確認した。coordinating ownerは次の1件をIncrement 70のweb_fetch契約、現行source、
provider-freeの実tool／WorkerGeneration／SessionAuthority再現へ照合し、採用した。

1. **正常なweb_fetch結果がcanonical commitで拒否される（P2）**: `web_fetch`は本文を最大1 MiB保持し、
   URL／status／content-type／切り詰め状態を先頭へ付ける。一方`session_record_codec.ts`は通常tool result全体へ
   user／assistant本文用の1 MiB上限を適用する。100 B本文はcommit可能だが、ちょうど1 MiB本文では結果が
   1,048,669 Bとなり、正常な2 step後に`SessionAuthority.proposalRecord()`がrecordを作れず、Hostがturnを
   `contract_failure`として不採用にする。上限を超えて正常に切り詰めた本文でも1,048,686 Bで同じ結果となる。
   両方ともmodel request encoderは受理する。人間が取得・回答したturnを保存・再開できない。

Direct `AgentSession`とHost `SessionAuthority`の二重実装、およびcross-slice ledger 2／4には、今回の採用基準を
満たす具体的なcorrectness影響を確認できなかった。追加findingはない。既存focused testはIncrement 12 **3件**、
35 **3件**、76 **3件**、auto-compaction **4件**、89 **2件**、saved codec **2件**の計**17件**成功。再現は
provider-free経路であり、実provider、compiled binary、full gate、永続化実装全体は未確認。

### Slice 9修正計画（承認済み・実施済み）

1. `session_record_codec.ts`のtool result検証をuser／assistant用1 MiB本文判定から分け、通常tool resultには
   文字列の正当性を適用する。`delegate_to_planner`専用の既存2 MiB envelope判定、user／assistant本文の1 MiB、
   Session record全体の8 MiB、codecのcanonical encoding／decodingは維持する。`web_fetch`本文を狭めない。
2. 実`web_fetch`をstubbed HTTP responseで動かし、本文ちょうど1 MiBと超過後に切り詰めた結果を
   provider-free WorkerGeneration／SessionAuthorityのproposalへ渡す。両方の正常turnが採用可能で、
   `encodeSessionRecordV6()`／`decodeSessionRecordV6()`後もtool result本文とmetadataを保持するfocused regressionを
   追加する。既存のuser／assistant上限、planner envelope、codec roundtripも確認する。
3. 変更箇所のfocused test、必要な`v0:check`、`v0:fmt`、`v0:lint`、`git diff --check`を実行する。
   full gateと実provider callは行わない。同じgpt-6-astra xhigh reviewerが変更箇所と既存1件の解消だけを
   15分以内でread-only再reviewする。

この計画は構想・architecture・roadmap、SQLite schema、外部provider／model-visible tool contractを変更しない。

### Slice 9実装・focused検証

- `session_record_codec.ts`の通常tool resultは文字列の正当性を検証し、user／assistant本文用1 MiB判定を
  重ねない。旧`delegate_to_planner`結果の2 MiB、user／assistant本文の1 MiB、record全体の8 MiBは維持した。
- 実`web_fetch`をstubbed HTTP responseで動かし、完全な1 MiB本文と超過後に切り詰めた本文を
  provider-free `WorkerGeneration`のcommit proposalへ渡した。`SessionAuthority.proposalRecord()`が両turnを受理し、
  V6 recordのencode／decode後もURL／status／content-type／truncated表示と本文が残ることを確認した。
  saved codecではuser／assistantの1 MiB境界と旧planner結果の2 MiB境界を確認した。
- focused test: Increment 70 web_fetch **6件**、saved codec／auto-compaction **21件**、Increment 12 **3件**、
  35 **3件**、76 **3件**、89 **2件**成功。`v0:check`、`v0:fmt`、`v0:lint`、`git diff --check`成功。
  full gate、実provider call、binary build／配置、pushは実施していない。
- 同じgpt-6-astra xhigh reviewerが変更箇所と採用1件の解消だけを15分以内でread-only再reviewし、
  **findingなし**。reviewerのweb_fetch **6件**、saved codec **3件**も成功した。

## Slice 10 — History semantic model

### 対象

- `v0/agent/history/context_attribution.ts`、`exact_byte_plan.ts`、`history_store_contract.ts`、
  `history_v7_model.ts`、`history_view.ts`、`human_history.ts`
- `v0/agent/session/session_history.ts`、`history_export.ts`、
  `v0/agent/worker/worker_history_projection.ts`、`recalled_execution_context.ts`のsemantic projection／readback
- 上記のcanonical／non-canonical identity、context occurrence／relation、capture coverage、human history、
  recallを直接検証するtest

`sqlite_history_v7_*`はSlice 11のphysical storage実装として到達先だけread-only参照できる。Host journal／commit
caller、CLI／TUI history入口、provider evidence／artifact storeも到達先として参照できるが、本Sliceでは修正しない。

### 評価基準

- execution、turn、canonical adoption、occurrence／relation、capture coverageの意味とownerが一貫しているか。
  normal／diagnostic profile、root／async child、commit失敗・取消・interruptionでも観測済みfactを正しく区別できるか。
- modelへ渡したcontextと、人間がhistory／recallで読める記録が現行product契約に沿うか。semantic authorityと
  derived viewの間で、意味のない二重変換・状態・validationがないか。
- exact byte／capture durability／history projectionが正常なprovider／tool outputを狭めず、診断に必要な事実を
  readbackできるか。physical SQLite layoutや性能最適化だけの提案はSlice 11へ送る。
- test helperや過去のcompatibility seamがsemantic contractへ逆輸入されていないか。

一般的hardening、未観測variant、網羅matrix、要件変更は評価対象にしない。findingには明示要件・実行証拠・現行source
から利用者影響への経路、保持すべきproduct動作、単純化案、regression risk、対応するfocused testを要求する。

### Read-only review結果とowner照合（2026-09-23）

利用者指定のgpt-6-astra xhigh reviewerが、History semantic modelと直接callerを45分上限で確認した。
provider-freeの実WorkerGenerationから一時SQLite v7へ保存してrecallする経路、同一recordのCLI session viewと
resumeメインlogを再現した。既存focused testはIncrement 38の6件、99の4件、89の2件、94の対象5件が成功。
ownerは以下の3件を、明示契約、現行sourceから利用者影響への経路、修正後に保持する動作で照合して採用した。

1. **P2: recallへprovider継続用stateが混入する。** Increment 38 §2は、provider-native reasoning／replay
   stateをrecalled contextへ混ぜないと明記する。`recalled_execution_context.ts`のjournal mapperは
   `assistant_message`全体を複製するため、保存された`providerState.reasoningDetails`がrecall JSONへ入り、
   次taskのuser reference本文としてmodelへ渡る。元journalとprovider continuationに必要なstateは保持し、
   recall用assistant observationだけをprovider-neutralなcontent／visible text／tool callsへ投影する。
2. **P2: 受理・消費済みsteering指示がrecallから欠落する。** Increment 38は停止executionの元指示と
   保存済み観測を次taskで参照できることを求め、Increment 89はsteeringを次requestへ結び付く独立のuser
   occurrenceとする。実Workerがtool実行中に受理して次model stepで消費した`steering_message`はjournalへ
   残るが、recall mapperのkind選別で消える。初期taskと区別したsteering observationをjournal順で保持し、
   停止turnの判断前提を次taskへ一度だけ投影する。
3. **P3: CLI session viewがresumeメインlogと一致しない。** Increment 99は`session` viewを「resume時の
   メインlog相当」「同じ投影」と定義する。tool call付きassistant中間textの後にfinalがある同一transcriptで、
   `history_view.ts`は中間文とfinalを別々に追記するが、`restoredPresentationMessages`からのメインlogは
   同一turnのassistant entryをfinalへ更新し、tool行の後へ移す。CLIにも同じturn内の最終配置を適用し、
   `tool>`の結果・順序とassistant final本文を保つ。

### 修正計画（承認済み・実施済み）

1. `v0/agent/worker/recalled_execution_context.ts`のv2 journal observationを、source evidenceとは別の
   provider-neutral projectionとして整える。assistantの`providerState`だけをrecallから除き、visible textと
   tool callsはexactに保持する。`steering_message`を初期`user_message`と区別するkindで時系列に加える。
   journal／artifact／provider evidenceの保存形式とreadbackは変更しない。
2. `v0/agent/history/history_view.ts`の`renderSessionView`を、同一turnの中間assistant文がfinalで置換され、
   finalがtool activityの後に配置されるresumeメインlogの意味へ合わせる。canonical／detail view、SQLite
   物理保存、TUIの既存表示動作は変更しない。既存projectionとの同一record比較で意味を一致させる。
3. Increment 38のfocused testへ、provider-free実Worker→一時SQLite v7→停止executionのrecall→次taskの
   referenceを通す回帰確認を加える。保存済みproviderStateはreadbackでき、recall本文には入らず、受理・
   消費済みsteeringが元taskと区別され一度現れ、visible assistant／tool内容が残ることを確認する。
   Increment 99のfocused testへmixed assistant text＋tool call＋finalの同一recordを追加し、CLI
   session viewを`restoredPresentationMessages`→`reduceUiEvent`の実表示entryと照合する。
4. 変更箇所のfocused test、`v0:check`、`v0:fmt`、`v0:lint`、`git diff --check`を実行する。
   gpt-6-astra xhigh reviewerが変更箇所と採用3件の解消を15分以内でread-only再reviewする。
   このSliceではauthoritative `v0:gate`、実provider call、binary build／配置、commit、pushを行わない。

利用者は2026-09-23にこの計画を承認した。構想、architecture、roadmap、外部contract、受入水準は変更していない。

### 実装・focused検証

- `recalled_execution_context.ts`はassistant messageのcontent／visible textをrecall用に構築し、
  `providerState`を投影しない。保存journal側のstateは維持した。受理済み`steering_message`を初期user
  messageと区別した観測としてjournal順に投影する。
- `history_view.ts`は同一turnのassistant entryを更新し、tool activity後のfinalをresumeログと同じ位置へ置く。
  canonical／detail view、TUIの既存表示動作、SQLite物理保存は変更していない。
- normal-v1の一時SQLite v7へ実`WorkerGeneration`のjournalを保存し、steeringを次requestで消費した後の
  uncommitted executionをrecallした。元journalにはprovider replay stateが残る一方、次taskのmodel requestには
  stateが入らず、steeringが一度だけ入り、visible assistant／tool内容も残ることを確認した。同一recordの
  CLI session viewは`restoredPresentationMessages`→`reduceUiEvent`の表示entryと一致した。
- focused testはIncrement 38 **7件**、99 **5件**成功。`v0:check`、`v0:fmt`、`v0:lint`、
  `git diff --check`成功。指定のgpt-6-astra xhigh reviewerが変更箇所と採用3件の解消を15分以内で
  read-only再reviewし、**追加findingなし**。reviewer側の同じfocused **12件**と差分チェックも成功した。
  authoritative `v0:gate`、実provider call、binary build／配置、commit、pushは実施していない。

## Slice 11 — Production persistence

### 対象

- `v0/agent/history/sqlite_history_v7_production_store.ts`、`sqlite_history_v7_store.ts`、
  `sqlite_history_v7_prototype.ts`の実storage、reconcile、journal、capture、snapshot read、projection drain
- `v0/agent/session/session_store.ts`、`session_store_paths.ts`のDeno file I/Oと保存先管理、
  provider evidence／execution artifactのphysical storeとの接続、および直接検証するtest

history semantic contractはSlice 10、Host admission／commit callerはSlice 8、Session record／codecはSlice 9の
対象であり、到達先としてread-only参照できる。CLI／TUI callerも到達先として参照できるが、本Sliceでは修正しない。

### 評価基準

- 実行journal、canonical commit、non-canonical settlement、reconcile、capture、read-only snapshotが、
  同じfactを二重のauthorityにせず現行product経路で永続化・readbackできるか。
- normal／diagnostic capture profile、root／async child、失敗・取消・interruptionで実際に観測された内容と
  durability状態を保てるか。保存形式、境界、file／lock lifecycleに意味のない複製や迂回がないか。
- Sessionのnew／resume、history CLIのread-only参照、provider evidence／artifact readbackが、同一workspaceの
  保存先・transaction境界に沿って動くか。正常なprovider／tool outputを物理保存で狭めないか。
- test helperや旧compatibility seamがproduction storage contractへ逆輸入されていないか。

一般的hardening、未観測variant、permission matrix、性能最適化だけの提案、SQLite schema変更は対象にしない。
findingには明示要件・実行証拠・現行sourceから利用者影響への経路、保持すべきproduct動作、単純化案、
regression risk、対応するfocused testを要求する。

### Read-only review結果とowner照合（2026-09-23）

利用者指定のgpt-6-astra xhigh reviewerがproduction storageと直接callerを、data lossを扱うため45分上限で
read-only確認した。ownerはIncrement 99／108の明示契約、現行source、provider-free実Workerと一時SQLiteの
再現へ照合し、以下の2件を採用した。

1. **P2: detail exportが複数時点の履歴を混在させる。** Increment 99はlive writerと並行するexportを
   単一read transactionのsnapshotにすると定める。`streamHumanHistoryExport()`はexecution一覧、Session、
   occurrence／content、manifest／diagnosticを別接続・別SELECTで読む。CLIはrecordごとにstdoutへ`await`する。
   実Workerの1 turn後にexportのheader／session metadataを読み、2 turn目をcommitして残りを読むと、metadataは
   `messageCount=2`／`nextTurn=2`なのに出力は4 messages・2 turns・1 executionになる。新turnの会話だけが
   入り、対応executionと証拠が欠ける。export全体のread transactionを単一ownerにし、全recordを同じ接続・
   snapshotから読み、generator終了時に接続を解放する。
2. **P2: model選択rollbackが保存済みturnの関連付けを破壊する。** Increment 108はWorkerがmodel選択を拒否
   したら永続変更をrollbackすると定める。Coordinatorの`handle.commit()`→拒否→`handle.rollback()`から、
   SQLite handleの`#replaceSession()`が全message／turnを削除し、`#writeSessionTx()`が全messageへ最新turn番号を
   付け、既存turnのexecution IDなしで再挿入する。実Workerの2 turn後に同じ順を実行すると、message turnは
   `[1,1,2,2]`から`[2,2,2,2]`、両turnのexecution IDは`null`となり、最初のexecution transcriptも
   2件から0件になった。Session recordのmetadataだけは元に戻る。SQLite Worker handleのmodel metadata／
   model-change suffixを戻し、既存message／turn／outbox／executionのidentityを保持する。Direct `AgentSession`の
   別interfaceによるdraft transcript rollbackは変更しない。

reviewerの既存focused testはIncrement 94の対象**6件**、12 **3件**、99 **5件**成功。Worker拒否ackの実注入と
CLI stdoutを使った並行再現、full gate、実providerは未実施。上記の原因と到達経路の確認には、同じ操作順を
production store／generatorで実行した証拠を使用した。

### 修正計画（承認済み・実施済み）

1. `sqlite_history_v7_production_store.ts`の`streamHumanHistoryExport()`で、最初のexecution照会より前に
   read-onlyの単一connection／transactionを開始し、Session、execution、message／turn、occurrence／content、
   relation、manifest、diagnostic attachmentをそのsnapshotから順に出す。必要なcore read処理は
   `sqlite_history_v7_prototype.ts`側も同じconnectionで呼べる純粋なread helperへ整理する。JSONLの内容・順序、
   streaming、live writerのcommit可能性を維持し、generator完了・途中終了・例外でtransactionと接続を解放する。
   SQLite schemaとCLI出力形式は変更しない。
2. 同production storeの`WorkerSessionHandle.rollback()`を、model選択のmetadataと追加されたmodel-change
   suffixのtransactional復元へ絞る。既存message／turn／projection outbox／execution関連行を削除・再挿入しない。
   model、revision、change履歴が元に戻ることと、既存turnの所属・execution ID・readbackが保たれることを
   確認する。Direct `AgentSession`のrollbackは変更しない。
3. focused regressionではprovider-free実Workerの1 turnを保存したdetail exportを途中まで読み、別turnを
   commitして続きが開始時snapshotと整合することを確認する。2 turn後のmodel metadata commit→rollbackでは
   Session metadata、各messageのturn、turnのexecution ID、最初のexecution transcript、projection状態を
   確認する。Increment 94／12／99など変更先と直接callerの既存focused testも実行する。
4. `v0:check`、`v0:fmt`、`v0:lint`、`git diff --check`を実行する。gpt-6-astra xhigh reviewerが変更箇所と
   採用2件の解消を15分以内でread-only再reviewする。このSliceではauthoritative `v0:gate`、実provider call、
   binary build／配置、commit、pushを行わない。

利用者は2026-09-23にこの計画を承認した。構想、architecture、roadmap、SQLite schema、外部contract、
受入水準は変更していない。

### 実装・focused検証

- `streamHumanHistoryExport()`は最初のexecution照会より前にread transactionを開始し、Session metadata、
  message／turn、execution、occurrence／content、relation、manifest、diagnostic attachmentを同じconnectionで
  読む。coreのread helperは呼出側のconnectionを受け取れるようにし、通常のcore読取は維持した。generatorの
  完了・途中return・例外ではtransactionを閉じる。
- SQLite `WorkerSessionHandle.rollback()`は追加model-change suffixとmetadataをtransaction内で戻し、
  保存済みmessage／turn／projection outboxを削除・再挿入しない。Session recordとsession headのrevisionは
  元に戻り、既存execution関連付けを保持する。Direct `AgentSession`のrollbackは変更していない。
- provider-free実Workerの1 turn後にdetail exportを開始し、header／Sessionを読んだ後に2 turn目をcommitした。
  writerはcommit可能で、export全体は開始時の2 messages・1 turn・1 executionと一致した。2 turn後の
  model metadata commit→rollbackでは、Session record、message turn `[1,1,2,2]`、両turnのexecution ID、
  最初のexecution transcript、projection outboxを変更前と照合した。
- focused testはIncrement 94 **23件**、12 **3件**、99 **5件**成功。`v0:check`、`v0:fmt`、`v0:lint`、
  `git diff --check`成功。指定のgpt-6-astra xhigh reviewerが変更3ファイルと採用2件の解消を15分以内で
  read-only再reviewし、**追加findingなし**。reviewer側の関連test **5件**と差分チェックも成功した。
  authoritative `v0:gate`、実provider call、binary build／配置、commit、pushは実施していない。

## Slice 12 — CLI／runtime／build

### 対象

- `v0/agent/cli/*`、`v0/agent/runtime/*`、`v0/agent/worker/worker_headless_runner.ts`、
  `worker_tui_session.ts`の起動入口とprovider environment引渡し
- `scripts/build_henji.ts`、`mod.ts`、`deno.v0.json`のruntime／build配線、および直接検証するtest

Provider catalog／credential契約はSlice 2、transportはSlice 3、Host内部はSlice 8、Session／historyはSlice 9〜11の
対象として到達先だけread-only参照できる。TUI control／render／inputはSlice 13〜15の対象で、本Sliceでは修正しない。

### 評価基準

- `henji run`、TUI、history／session／module／tool CLIが、同じconfigとworkspaceから意図したWorker／Session／
  physical I/Oへ到達し、現行product契約どおりのmodel selection、表示／終了結果を返すか。
- cross-slice ledger 5のTUI二重config loadとheadless default差異を、実際のexternal declarationと
  provider-free起動経路で照合する。一invocationのeffective provider environmentをどこが所有するか、
  picker／初期selection／Workerへ渡す過程に意味のない再materializationがないか。
- runtime manifest、path、build entry、CLI引数処理が正常利用を狭めず、失敗時の原因とexit結果を追えるか。
  build artifact生成やbinary配置はこのreviewで実行しない。
- test helperや旧compatibility seamがproduction CLI／runtime contractへ逆輸入されていないか。

一般的hardening、未観測provider variant、網羅matrix、要件変更は対象にしない。findingには明示要件・実行証拠・
現行sourceから利用者影響への経路、保持すべきproduct動作、単純化案、regression risk、対応するfocused testを
要求する。

### Read-only review結果とowner照合（2026-09-23）

利用者指定のgpt-6-astra xhigh reviewerがCLI／runtime／build配線と直接callerをread-onlyで確認した。
coordinating ownerはIncrement 63／64の外部宣言・実効catalog契約、現行source、隔離configとprovider-free
実Workerの再現へ照合し、cross-slice ledger 5を次の1件として採用した。

1. **P2: provider環境の所有が分かれ、headlessのdefaultsとTUIの選択が不一致になる。** TUI CLIは外部宣言を
   一度読んでHost picker／defaultへ設定するが、`createWorkerSession()`が再読込みしてWorkerへ渡す。
   二回の間にcatalogからmodelを除くと、Host pickerが有効と判定するmodelへのselect RPCをWorkerが
   `Worker rejected model selection`で拒否した。またheadless `runHeadlessWorker()`はfactoryだけを通り、
   初期selection未指定でHost authorityが同梱静的defaultへ落ちる。外部宣言の`openrouter-chat` defaultsを
   `qwen/qwen3.8-flash / auto`へ変更した実行では、headlessの保存artifact rootModelは
   `deepseek/deepseek-v4.1-flash / high`、同じ宣言をTUI側で解決した初期selectionはqwenだった。
   一invocationで解決した同じprovider宣言をHost catalog、初期selection、Workerへ渡す。

cross-slice ledger 6のlazy resume後renameは、Increment 76の明示契約と実Worker→presentation経路で問題を確認したが、
同期navigation／presentation portを変えるためSlice 13へ送る。ほかに採用findingはない。reviewerの既存focused
testはIncrement 14の対象**4件**、15の対象**2件**、76の対象**1件**が成功。実TTY、CLI stdout通し、binary build、
実provider、full gateは未実施。

### 承認済み修正計画

1. TUI CLIが起動前に解決したprovider宣言を、一invocationのimmutable snapshotとして
   `createWorkerSession()`へ渡す。factoryは渡されたsnapshotを再loadせず、渡されないheadless等の入口では
   外部宣言を一度だけ解決する。同じsnapshotをHostの実効catalogとWorker start commandへ使う。
2. factoryで新規／nonpersistent rootの初期modelを実効catalogから選ぶ。default Agentは外部宣言を反映した
   `openrouter-chat` default、plannerは既存role defaultを使い、明示的なTUI `--provider`／保存済みdefault／
   `initialModelSelection`／resume recordの選択優先順位を維持する。保存済みSessionのmodelを上書きしない。
   宣言なし起動時の同梱defaultも維持する。
3. focused regressionで外部defaults付きprovider-free headless実Workerのartifact rootModel、TUIが解決した
   宣言をfactoryへ渡した後にconfig fileを変更してもHost／Workerが同じcatalogを使ってmodel選択できること、
   明示provider・保存済みdefault・planner・resumeの既存動作を確認する。TUI Surface変更に当たるため、
   隔離XDGのtmux上でproduction TUIを起動し、実provider callをせず初期選択とpickerの表示・操作を確認する。
   実provider callが必要になった場合は、対象・回数・保存先を示して別承認を得る。
4. 変更箇所のfocused test、`v0:check`、`v0:fmt`、`v0:lint`、`git diff --check`を実行する。
   gpt-6-astra xhigh reviewerが変更箇所と採用1件の解消を15分以内でread-only再reviewする。このSliceでは
   authoritative `v0:gate`、binary build／配置、commit、pushを行わない。ledger 6はSlice 13まで修正しない。

利用者は2026-09-23にこの計画を承認した。構想、architecture、roadmap、provider外部contract、
model-visible tool contract、受入水準は変更していない。

### 実装・focused検証

- TUI CLIは解決済みprovider宣言を`createWorkerSession()`へ渡し、factoryは渡された宣言を再読込せず
  Host catalogとWorker start commandに共有する。headlessではfactoryが一度解決し、default Agentの
  初期modelを実効`openrouter-chat` defaultから選ぶ。plannerは既存のrole defaultを使い、明示的な
  初期selectionと保存済みSession modelの優先順位を維持した。
- 外部宣言のdefaultを`qwen/qwen3.8-flash / auto`にしたprovider-free headless実Workerのartifact
  `rootModel`を確認した。TUI相当の解決後に設定fileから同modelを除いても、渡したsnapshotによる
  Host catalog判定とWorker select RPCが一致した。headless plannerのrole default、既存の明示provider、
  保存済みdefault、resume／model切替も関連focused testで確認した。
- 隔離XDGのtmux上でsource production `agent:tui`を起動した。初期footerは
  `provider:openrouter-chat model:qwen/qwen3.8-flash auto`。`/provider` pickerで
  `openrouter-responses`へ切替えるとそのproviderのdefaultが表示され、再び`openrouter-chat`を選ぶと
  `qwen/qwen3.8-flash auto`へ戻った。Ctrl-Dで終了した。実provider callは行っていない。
- focused testはIncrement 14 **24件**、15 **6件**、66 **3件**、76 **3件**成功。
  `v0:check`、`v0:fmt`、`v0:lint`、`git diff --check`も成功。authoritative `v0:gate`、
  binary build／配置、commit、pushは実施していない。
- 指定のgpt-6-astra xhigh reviewerが変更箇所と採用P2の解消を15分以内でread-only再reviewし、
  **追加findingなし**。reviewer側の関連focused test **4件**と`git diff --check`も成功した。

## Slice 13 — Surface contract／control

### 対象

- `v0/presentation/*`のintent／event／state projection／navigation adapter契約とcontrol flow
- `v0/tui/controller.ts`、`controller_contract.ts`、`controller_editor.ts`、`controller_overlay.ts`、`state.ts`、
  `slash_command.ts`、`pending_input.ts`のUI intent処理、および直接検証するtest

CLI／Host／Session境界は到達先としてread-only参照できる。render／layoutはSlice 14、入力decoder／editor／terminal
lifecycleはSlice 15の対象で、本Sliceでは修正しない。

### 評価基準

- 人間の操作がpresentation intentからHost navigation／session操作へ一度だけ届き、結果・失敗理由が
  UIへ正しく戻るか。実際のresume、rename、new session、model／provider選択、history／recallの経路を重視する。
- cross-slice ledger 6のlazy resume後renameをIncrement 76の明示契約と実Worker再現へ照合し、必要な
  navigation／presentation contract変更範囲を明確にする。
- control state、adapter state、Host stateの責務や変換が重複していないか。変更に意味がある場合は
  product動作を維持する最小の形、regression risk、focused検証を示す。

一般的hardening、未観測variant、網羅matrix、要件変更は対象にしない。findingには明示要件・実行証拠・
current sourceから利用者影響への経路、保持すべきproduct動作、単純化案、対応するfocused testを要求する。

### Read-only review結果とowner照合（2026-09-23）

利用者指定のgpt-6-astra xhigh reviewerがSurface contract／controlと直接callerをread-onlyで確認した。
ownerはIncrement 76のlazy activation、Increment 6のbusy Ctrl-C、既存PTYのsame-chunk操作契約、
canonical steeringのsame-turn意味、現行sourceとprovider-free再現を照合し、次の3件を採用した。

1. **P2: lazy resume直後のrenameが拒否される。** Increment 76はrenameをWorker起動の契機となるlive操作と
   明記する。しかしpicker resumeが返す`LazyWorkerSession.renameTitle()`は未起動Hostで`unavailable`を返し、
   同期`renameCurrent`／presentation経路からWorkerを起動できない。保存Session→別Session→lazy resume→renameの
   実Worker経路でtitleが保存されなかった。resume時のWorker 0個を維持し、renameで初めて起動して結果を返す。
2. **P2: 同じ入力chunkのEnter→Ctrl-Cがbusy cancellationへ届かない。** `processModernEvents()`は
   `busy`をchunk開始時の値として固定する。`task\r\x03`はEnterでbusyへ遷移しても後続Ctrl-Cをidle clearへ
   流し、productionと同じController→presentation adapter経路でcancel 0回、task実行継続を再現した。
   分割chunkではcancel 1回。Increment 6のbusy Ctrl-C契約と既存PTYのsame-chunk確認に反する。
3. **P2: steering付き会話のresume後、次の回答が保存済み回答を表示上書きする。** canonical transcript中の
   steeringは同じturnの追加user messageだが、`restored_log`はuserごとにturnを増やす。復元行とlive行が
   `turn-N:assistant`を共有するため、実Workerでsteeringを消費・commitしたSessionの復元回答が
   `turn-2:assistant`となり、次の正規turn 2回答に置換された。保存transcriptは残っていても人間の会話ログから
   前の結論が消える。復元行のIDをlive行から分離し、既存の復元表示順と集約を維持する。

reviewerの関連focused test **11件**は成功。追加2件はprovider-free実経路で再現し、renameは既存実Worker
再現とsourceを照合した。render／layout、input decoder／terminal内部の追加review、tmux、実provider call、
full gateは行っていない。一般的hardeningや未観測variant由来のfindingは採用していない。

### 承認済み修正計画

1. `LazyWorkerSession.renameTitle()`が`ensureStarted()`を待ってHostのrenameを呼ぶ。
   `SessionNavigationHost`からpresentation adapter／controller fallbackまでrename結果をawait可能にし、
   成功時のtitle表示と保存、busy／unavailable／起動失敗時の既存表示を維持する。resumeだけではWorkerを
   起動しない。同期Host renameは内部のまま使い、外側のnavigation操作だけ非同期へ揃える。
2. `TuiController.processModernEvents()`の固定`busy`引数を除き、各eventを処理する時点の状態でidle／busy
   動作を選ぶ。Enter直後のCtrl-C／Esc／steering等が実際の状態へ届くようにし、二回目Ctrl-C、
   cancellation後の入力抑止、既存のfollow-up操作を維持する。
3. `restored_log`で復元したentryのIDをlive turn eventのIDと別namespaceにする。同じ復元内の
   assistant/tool集約、表示順、本文、anchorの一意性を維持し、次のlive turnのprogress／finalが過去の
   assistant entryを置換しないようにする。canonical transcriptとSession history viewの内容は変えない。
4. focused regressionは、(a) provider-free実Workerの保存Session→別Session→lazy resume→最初のrenameで
   Worker起動回数と保存title、adapter/controllerの結果表示、(b) production相当のcontroller＋adapterで
   同一chunk／分割chunkのEnter→Ctrl-Cが同じcancel結果になること、(c) steeringを含む実Workerの
   保存transcript復元後に次turnを描画し、旧・新回答と一意のentry IDが両方残ることを確認する。
   直接影響するIncrement 35／76／99、TUI controller／presentationの既存focused testも実行する。
5. TUI Surface変更として、隔離XDGのtmux上でsource production TUIを起動し、実provider callなしで
   `/new`→`/sessions` resume→`/rename`の操作・保存title readbackと、復元表示を確認する。
   steeringを伴う新しい実provider turnは別承認がない限り行わず、(4)のprovider-free実経路で検証する。
6. `v0:check`、`v0:fmt`、`v0:lint`、`git diff --check`を実行し、同じgpt-6-astra xhigh reviewerが
   変更箇所と採用3件の解消を15分以内でread-only再reviewする。authoritative `v0:gate`、
   binary build／配置、commit、pushはこのSliceで行わない。

利用者は2026-09-23にこの計画を承認した。構想、architecture、roadmap、外部contract、
受入水準は変更していない。

### 実装・focused検証

- `LazyWorkerSession.renameTitle()`は最初のrenameでWorkerを起動し、navigation／presentation／controllerの
  rename結果を非同期で届ける。resume自体ではWorkerを起動しない。
- modern controllerは各入力event時点のidle／busy stateを使う。Enter後の同一chunk Ctrl-Cがbusy
  cancellationへ届き、cancellation後の入力抑止と二回目Ctrl-C動作を維持した。
- `restored_log`は復元中のassistant／tool集約を終えてからentry IDに`restored:`を付け、次のlive
  `turn-N` entryと分離した。本文、表示順、canonical transcript、Session history viewは変えていない。
- focused regression: provider-free実Workerの保存Session→新Session→lazy resume→最初のrenameでは、
  Worker数がresumeで2のまま、renameで3となり保存titleが一致。production相当Controller→presentation
  adapterの同一chunk／分割chunk Enter→Ctrl-Cはいずれもcancel 1回。実WorkerGenerationのsteering付き
  committed transcriptを復元し、次turn後も旧・新回答と一意のentry IDを確認した。
- 隔離XDGのtmuxでsource production `agent:tui`を起動した。provider-free実Workerで保存した会話を
  `/new`→`/sessions`→resumeで復元し、`user> seeded conversation`と
  `assistant> worker answer: seeded conversation`を表示。最初のlive操作`/rename Verified resume`で
  header／footerが更新され、保存recordのreadbackも`Verified resume`だった。Ctrl-Dで終了した。
  実provider callは行っていない。steering付き次turnの表示はprovider-freeのfocused実経路で確認した。
- focused testはIncrement 35 **3件**、38 **8件**、76 **4件**、99 **5件**、TUI presentation／controller／
  overlay **53件**成功。`v0:check`、`v0:fmt`、`v0:lint`、`git diff --check`成功。
  authoritative `v0:gate`、binary build／配置、commit、pushは実施していない。
- 指定のgpt-6-astra xhigh reviewerが変更箇所と採用3件の解消を15分以内でread-only再reviewし、
  **追加findingなし**。非同期rename直後のCtrl-D／`/new`を実Worker＋production adapter／controller経路で
  確認し、Worker readyを100 ms遅らせても元Sessionの保存title、切替先title、終了コード0に回帰はなかった。
  reviewer側のfocused test **5件**と`git diff --check`も成功。full gate・実provider callは行っていない。

## Slice 14 — Surface rendering／layout

### 対象

- `v0/tui/assistant_layout.ts`、`conversation_renderer.ts`、`editor_render.ts`、`layout.ts`、
  `render.ts`、`startup_render.ts`、`tui_renderer.ts`、`terminal_text.ts`の表示・layout経路と直接検証するtest

presentation event／UI stateとcontrollerはSlice 13の到達先としてread-only参照できる。入力decoder／editor、
terminal lifecycleはSlice 15の対象で、本Sliceでは修正しない。

### 評価基準

- production TUIの会話本文、tool活動、startup、footer、overlay、scroll／viewportが、人間の操作と
  実Session状態を失わず読めるか。既存の大きなassistant本文、全角文字、resize、復元表示の実行証拠を重視する。
- rendering ownerとlayout ownerの状態・変換・測定が不要に重複していないか。現行の表示順、terminal write、
  anchorの意味を維持したまま簡潔にできる箇所だけを候補にする。
- 表示結果がterminal幅・高さや実際の更新順によって誤る具体的な経路があれば、再現、利用者影響、
  最小変更、focused検証を示す。

一般的hardening、未観測端末variant、網羅matrix、要件変更は対象にしない。findingには明示要件・実行証拠・
current sourceから利用者影響への経路、保持すべき動作、単純化案、対応するfocused testを要求する。

### Read-only review結果とowner照合（2026-09-23）

指定のgpt-6-astra xhigh reviewerが対象8ファイル、直接callerと関連testをread-onlyで確認した。reviewerの
focused **24件**は成功。ownerは現行source、Increment 53／84／95の採用済み動作、production相当のrenderer
再現を照合し、次の2件を採用した。

1. **P2: 長いassistant本文の過去表示位置がresizeで別の項目へ移る。** `layout.ts`はassistant行の
   `sourceScalarOffset`を元の本文位置ではなくMarkdown装飾・折り返し後の描画文字数から積算する。同じanchor値を
   幅変更後のlayoutで探索すると別の内容を指す。300項目の長いlistを実`TuiRenderer`で80×24表示しPageUp 15回
   進めると先頭は`item-220`だが、160×24へresizeすると`item-227`になり、読んでいた項目が画面から消えた。
   Increment 95は厳密な元source offset対応を対象外としresizeを未確認としていたが、今回の具体的な
   閲覧位置喪失はHost-local viewportの保持動作に反する。
2. **P2: compact Session pickerで選択中のSessionを見ずにresumeできる。** `layoutUi`はoverlayが表示領域を
   超えると選択位置に関係なく末尾だけを表示する。production相当のstartup／projectionと三行footerがある
   80×10画面で8 Sessionを開くと、選択0の行は隠れてSession 2〜7だけが見える。実`ControllerOverlay`へEnterを
   渡すと、非表示のSession 0で`resume_session`がdispatchされた。Increment 53の1 Session 1行、選択marker、
   Up／Down、Enter resumeの動作と矛盾する。

不要重複として、`editor_render.ts`の`layoutEditorText`／`pendingMetadataRows`と関連型・`render.ts`再exportは
repository内でtestからしか参照されない。productionのeditor／footerは`layout.ts`の別実装を使う。
`cellWidth`も`layout.ts`と`editor_render.ts`に同じ実装が重複する。公開packageはDefinition composition APIのみで、
これらのTUI helperは公開contractではない。editorのsoft-wrap境界cursorは編集位置の誤りを確定できずfindingへ
採用しない。一般的hardening、入力decoder／terminal lifecycle内部は確認対象外。full gate、実provider call、
tmux確認、ファイル変更は行っていない。

### 承認済み修正計画

1. `conversation_renderer.ts`と`assistant_layout.ts`のHost-local assistant行に、元のlogical line／table record行と
   その行内位置を識別できるmetadataを付ける。`layout.ts`はページ移動に必要な単調増加する行offsetを保持し、
   `tui_renderer.ts`はresize時に旧anchor行の元位置を新layoutへ写す。list／段落／heading／quoteは既存
   `wrapCellsWithSource`等の元文字位置を利用する。表は元record行を維持する粒度とし、全Markdown構文の
   cell単位での厳密対応は要求しない。保存transcript、Presentation contract、通常の表示本文は変更しない。
2. `layout.ts`のSession picker overlayは、表示領域より長い場合も現在の選択行を表示windowへ含める。高さが
   許す場合は操作案内とpage行を残す。論理pageの8件、1 Session 1行、日時・title・短縮ID・turn数・状態、
   Up／Down・Enter resumeの意味は維持し、controllerの選択stateは増やさない。
3. 使われない`layoutEditorText`／`pendingMetadataRows`と関連型・`render.ts`再exportを削除し、testは実際の
   `layoutUi` input／footerへ寄せる。文字cell幅計算は`terminal_text.ts`へ一本化し、`layout.ts`、
   `assistant_layout.ts`、`startup_render.ts`から共有する。外部package exportは変更しない。
4. focused検証は、300項目listのPageUp→80列から160列へのresize後も元の項目が見えること、list／表／段落で
   oldest→latestへのPageDownが停止しないこと、三行footer付き80×10 pickerで初期選択とUp／Down後の選択行が
   常に見えEnter対象IDと一致すること、標準80×24 pickerと全角editor／startup表示が維持されることを確認する。
   直接影響するTUI test、`v0:check`、`v0:fmt`、`v0:lint`、`git diff --check`を実行する。
5. Surface変更として、隔離XDGのtmux上でsource production TUIを起動し、provider-freeで保存した長い会話と
   8 Sessionを使ってPageUp→resizeとcompact `/sessions`の表示・選択を確認する。実provider callは行わない。
   同じgpt-6-astra xhigh reviewerが変更箇所と採用2件の解消だけを15分以内でread-only再reviewする。
   authoritative `v0:gate`、binary build／配置、commit、pushはこのSliceで行わない。

利用者は2026-09-23にこの計画を承認した。構想、architecture、roadmap、保存Session、Presentation contract、
検証水準は変更していない。

### 実装・focused検証

- assistant renderer行へ元のlogical lineと行内位置を追加し、layout行へ保持した。既存の描画offsetはPageUp／
  PageDown用として維持し、anchored viewportのresize時だけ旧表示行の元位置から新layoutの行へ写す。
  list／段落／heading／quote／code fenceは元の行を保持し、表は元record行を保持する。canonical transcriptと
  表示本文は変更していない。
- Session pickerのoverlayが表示領域を超えるとき、上部の操作案内・page行を表示可能な高さで残し、選択行を
  含むwindowを表示する。controllerの選択stateと8件単位の論理pageは変更していない。
- testだけが使っていた`layoutEditorText`／`pendingMetadataRows`とその型・再exportを削除した。共通の
  `cellWidth`を`terminal_text.ts`へ置き、assistant、startup、layoutで共有する。testはproductionのinput／
  footer layoutへ寄せた。
- focused testはTUI retained／conversation／overlay **56件**、Increment 84 **12件**成功。新規testでは
  300項目listのPageUp→80列から160列へのresize後も同じ元item行が先頭に残り、表／段落の履歴がresize後も
  oldest→latestへ進むことを確認した。三行footer付き80×10のSession pickerは初期・中間・末尾の選択行とIDを
  表示し、80×24表示も維持した。`v0:check`、`v0:fmt`、`v0:lint`、`git diff --check`は成功。
- 隔離XDGのtmux上でsource production `agent:tui`を起動し、provider-free実Workerで作った8保存Sessionを
  `/sessions`で表示した。80×10の三行footer下で初期選択の短縮ID `4acd1c85`と、Down 7回後の選択
  `61da6869`をmarker付きで読めた。最初のSessionをEnterでresumeし、300項目の保存会話をPageUp 15回で
  `item-268`付近まで遡った。80→160列のresize後も`item-268`が先頭に残り、PageDownで`item-299`の最新へ
  戻った。Ctrl-Dで終了し、tmux serverは停止した。実provider callは行っていない。
- 同じgpt-6-astra xhigh reviewerが15分以内に変更差分と採用2件の解消をread-only再reviewし、
  **追加findingなし**。元の300項目list／PageUp 15回の再現で80→160列後も`item-220`を先頭に維持した。
  実`ControllerOverlay`＋三行footerの80×10で選択0・Down 7後の選択7がmarker／ID付きで見え、Enterの
  `resume_session` IDと一致した。削除helperへの残参照はなく、全角editor／startup表示も確認した。
  reviewer側のfocused **26件**、対象testの型検査、`git diff --check`は成功。tmux確認はownerの実行証拠を
  照合し、reviewer自身は再実施していない。
- authoritative `v0:gate`、binary build／配置、commit、push、実provider callは実施していない。

## Slice 15 — Input／editor／terminal lifecycle

### 対象

- `v0/tui/input.ts`、`input_contract.ts`、`input_decoder.ts`、`input_editor.ts`、`input_history.ts`、
  `input_value.ts`、`file_reference.ts`、`terminal.ts`の入力・編集・completion・terminal lifecycle経路と、
  直接検証するtest

review時はcontroller／render／layout／CLI entryを到達先としてread-only参照する。下記承認待ち計画では
非同期出力失敗をHost終了へ伝える接続だけ、controller／CLI entryの隣接箇所を変更対象へ加える。
Worker／Host Sessionとproduction validation harnessは修正しない。

### 評価基準

- 実terminalからの文字・control key・paste・resize／signalが人間の意図したeditor／controller操作へ届き、
  複数行・全角・cursor・入力履歴・path completionの通常利用を保つか。現在のactive sourceと実行証拠を重視する。
- alternate screen、raw input、cursor、起動前画面が通常終了、cancel、signal、terminal write failureで
  復元されるか。具体的な失敗経路がある場合だけ調べ、仮想端末variantやpermission matrixを増やさない。
- decoder／editor／history／file reference／terminal間で同じ状態・parse・測定が不要に重複していないか。
  product動作を保ったままownerを明確にする局所的な単純化候補を示す。

findingには明示要件・実行証拠・current sourceから利用者影響への経路、保持すべき動作、最小変更、対応する
focused検証を要求する。一般的hardening、未観測variant、網羅matrix、要件変更は対象にしない。

### Read-only review結果と採用判断

gpt-6-astra xhigh reviewerは対象8 file、直接のcontroller／renderer境界、関連契約とfocused testを確認し、
focused **21件**が成功した。ownerはcurrent sourceと現workspaceで照合した。ファイル変更、full gate、
実provider call、実OSのwrite障害やreal TTY signalの再現は行っていない。

1. **bare Esc後の新しい矢印キー消失（採用）**: `input_decoder.ts`の`unknownAfterBareEscape`がbare Esc
   timeout後、通常文字を受けても残る。実`TuiController`へ`ab`→Esc→80 ms→`c`→Left→`X`を送ると、
   意図した`abXc`ではなく`abcX`になる。Increment 97／98はこの挙動を明示的に対象外としており、
   承認済みの動作としていない。新しいESCで始まる完全なCSIを、古いbare Escの残りとして捨てている。
2. **非同期出力失敗後の復元control破棄（採用）**: `terminal.ts`の`CoalescingWriter`は一回の
   `writeChunk` rejection後に永久`failed`となり、以後の`enqueue`を捨て、`flush()`も成功扱いにする。
   acquire後のframeを一度rejectし、その後は書けるbackendで再現すると、restore後にrawは解除されても
   bracketed pasteの解除とalternate screenからの退出は届かず、`restoreStatus()`は`ok`だった。
   architectureのterminal復元契約に反する。
3. **現workspaceでのTab補完全面停止（旧採用仕様の再判断）**: `file_reference.ts`のregular file
   **1,024件**上限に現repoが到達し、indexが`incomplete`となる。実FSでは1,025件目で停止した。
   その時点で列挙1,566 entries、path合計67,650 bytes、最大depth 15で、他の上限は未到達。
   実`ControllerEditor`の`README`補完もtext/cursor不変のまま`path index unavailable`だった。
   `docs/plans/daily-editor-no-lost-input.md`で選んだwhole-index discardには合致しており、実装逸脱の
   findingにはしない。ただし通常repoでpath completionというproduct機能が全く使えないため、以下の
   上限変更を利用者判断として提案する。

### 承認済みSlice 15修正計画

保持するproduct動作は、通常の文字／cursor／履歴／paste／path補完と非同期描画を人間がTUIで使え、
正常終了・cancel・signal・出力失敗で起動前のterminal mode／画面／cursorへ復元すること。今回の変更は
TUI入力・terminal経路に限り、provider、Session、外部API、storageへ触れない。

1. `input_decoder.ts`から`unknownAfterBareEscape`状態とそのCSI拒否分岐を削除する。新しいESCから始まる
   arrow／Home／Endは通常どおりdecodeし、途中CSIのtimeout回収とAlt+Enterの既存状態は維持する。
2. `terminal.ts`の出力queueは一回の非同期rejectionを記録してHostへ通知し、以後の復元controlまで
   永久破棄しない。復元時は残りのcontrolを順序どおり試行し、先のwrite失敗を`restoreStatus()`の
   `failed`とCLIの失敗終了へ反映する。出力失敗を受けてactive turnのsettlement後にrestoreを開始する接続に限り、
   `controller.ts`／`tui_cli.ts`の隣接箇所も変更対象へ加える。frame coalescing、FIFO、非同期write、
   terminal復元の既存順序は維持する。OSが以後も全writeを拒否する場合の画面復元は保証できない。
3. 現workspaceのpath completionを成立させるため、`file_reference.ts`の独立した
   `MAX_FILES=1,024`制限を廃止する。既存のvisited entries 4,096、retained path bytes 256 KiB、
   depth 32、単一path 4,096 bytesと、これらを超えた際のwhole-index discardは維持する。
   `fromCandidates`はproductionと同じ4,096件／256 KiBに揃える。これは旧選定の**1,024件上限という
   明示仕様の変更**であり、Slice計画の包括承認からは推定しない。構想・architecture・roadmapは変更しない。
4. 上記経路で確認した不要重複として、`file_reference.ts`のUnicode well-formed判定を
   `input_value.ts`へ一元化し、repo内callerのない`InputDecoder.push／finish／hasPendingEscape`、
   `TuiEditor.moveHome／moveEnd`、`WorkspacePathIndex.empty／match／rootPath`、`INPUT_*` aliasを削除する。
   TUI moduleは`jsr.json`の公開APIに含まれず、利用中のmethodやcontractは削除しない。

検証は、実`TuiController`でbare Esc後の文字＋LeftとUp履歴を確認し、既存の途中CSI／Alt+Enter動作を
focused確認する。非同期frame rejectionを一度起こすterminal backendでHostの失敗終了、raw／paste／
alternate screen／cursor復元と失敗readbackを確認し、writerの順序・coalescingをfocused確認する。
実repoを用いたindex構築と`README`のTab補完、上限超過時の既存`incomplete`動作を確認する。
該当`deno test`、`v0:check`、`v0:fmt`、`v0:lint`、`git diff --check`を実行する。TUI Surface変更なので、
隔離XDGのtmux上でproduction TUIのEsc→文字→Leftと実repoのTab補完、通常終了後の画面復元を
provider-freeで確認し、操作と観測を本書に記録する。同じreviewerは変更箇所と既存findingの解消だけを
15分以内で再reviewする。authoritative `v0:gate`は全Slice収束後に一回だけ実行する。

利用者は2026-09-23に本計画を承認した。これは旧1,024 file上限の変更と、出力失敗のHost終了接続のための
controller隣接箇所の修正を含む。構想・architecture・roadmap、外部provider契約は変更しない。

### 実装・focused検証

- `InputDecoder`の`unknownAfterBareEscape`と新しいCSI拒否分岐を削除した。bare Esc後に通常文字と新しい
  Left／Upを受ける。途中CSIのtimeout回収とAlt+Enterは既存decoder状態のまま維持した。
- `CoalescingWriter`はwrite失敗を一回通知して記録し、その後のcontrolを順序どおり試行する。`flush()`は
  queueを排出した後に失敗を返す。`DenoTerminal`→`TerminalLifecycle`→`TuiController`の通知でactive turnを
  settleして復元へ入り、先の失敗は`restoreStatus=failed`とCLIの失敗終了へ届く。同期的なwrite throwでは
  `pump`代入前に処理が終わり`flush()`が停止しない経路も実装中のfocused確認で発見し、pump開始を
  microtaskへ移して同じ出力失敗経路で修正した。frame coalescingとFIFOは維持した。
- `WorkspacePathIndex`の独立した1,024 file上限を除去し、最大4,096 visited entries／256 KiB retained
  path bytes等の既存上限とwhole-index discardは維持した。`fromCandidates`も4,096件／256 KiBに揃えた。
  使われないroot値と`empty`／`match`／`rootPath`を除去した。Unicode well-formed判定を
  `input_value.ts`へ一元化し、使用されない入力method aliasと`INPUT_*` aliasも除去した。
- focused testは`keymap_readline_test.ts` **7件**、Increment 74 terminal write **6件**、retained TUI
  **42件**の計**55件**成功。新規の実controller経路ではbare Esc→文字→Leftで`abXc`となり、別のbare Esc後に
  Upで入力履歴を戻せた。一回のframe rejection後にcontrollerはexit 1、raw解除、paste解除、alternate
  screen退出、cursor表示を確認し、復元失敗statusも`failed`となった。writerの順序・frame coalescingと
  同期write throw後の`flush()`完了も確認した。
- 実repoの`buildWorkspacePathIndex(Deno.cwd())`は`complete=true`、regular file **1,209件**。
  `completePath('README')`は`"./README.md"`を返した。`fromCandidates`でも1,200件目を補完できた。
  `v0:check`、`v0:fmt`、`v0:lint`、`git diff --check`は成功した。
- 隔離XDGのtmuxでsource production `agent:tui`を100×30で起動。`ab`→bare Esc→100 ms→`c`→Left→`X`は
  `abXc`と表示され、`README`→Tabは`"./README.md"`になった。Ctrl-Dで終了し、別の起動で空editorから
  Ctrl-Dのpane終了コード**0**と画面クリアを確認した。taskをsubmitせず、実provider callはなかった。
  tmux serverを停止し、作成した隔離XDG一時領域を削除した。
- authoritative `v0:gate`、binary build／配置、commit、pushは行っていない。

### 限定再review

同じgpt-6-astra xhigh reviewerが15分以内に変更箇所と採用2件の解消をread-only再reviewし、**追加finding
なし**。bare Esc後のLeft／Up、途中CSI timeoutとlegacy／xterm Alt+Enterを確認した。active turn中の
非同期write rejectionではcancel 1回→settlement→復元→exit 1となり、raw／paste／alternate screen／cursorが
復元され`restoreStatus=failed`。同期throw後のpump／flush停止も解消した。実repo indexはcomplete／1,209
filesで実`ControllerEditor`の`README`＋Tabが`"./README.md"`となり、4,096 entries制限は維持された。
削除aliasの残参照はない。reviewerのfocused **17件**、対象型検査、`git diff --check`は成功。実OS write障害と
tmuxは再実施せずownerのproduction TUI証拠へ依拠した。full gate、実provider call、ファイル変更なし。

## Slice 16 — Production validation harness

### 対象

- `v0/agent/validation/fixture_model.ts`、`production_cli_e2e.ts`、
  `production_cli_e2e_contract.ts`、`real_provider_acceptance.ts`、`work_tools_sentinel.ts`、
  `work_tools_sentinel_launcher.ts`と、直接の`tests/v0/production_cli_e2e_test.ts`等のoffline test

production CLI／Worker／provider／tools／artifact readerは検証対象の到達先としてread-only参照できるが、
本Sliceでは修正しない。compiled binary、実provider、credential、実workspaceを使うlive validationは
利用者から別の明示指示がないため実行しない。

### 評価基準

- validation harnessが実production command／Worker／provider／tool経路のどの動作を確認でき、どの結果を
  合否としているかを、現行のproduct契約と実際のdata flowに照合する。fixtureの期待を外部service仕様に
  格上げせず、実際に必要な結果を誤って拒否・成功扱いしないかを調べる。
- provider request／response、tool結果、execution artifact等、原因特定に必要な証拠をどこで保存・readback
  できるかを確認する。credential値とAuthorizationは表示・記録しない。
- 同じ入力検証、結果判定、evidence projectionがvalidation module間で不要に重複する箇所だけ、保持すべき
  product動作と最小の単純化案を示す。

findingには明示要件・実行証拠・現行sourceから利用者影響への経路、最小変更、対応するfocused検証を要求する。
一般的hardening、仮想provider variant、permission matrix、live test追加による形式的coverageは対象外。

### Read-only review結果と採用判断

gpt-6-astra xhigh reviewerは対象6 module、直接offline test、必要なproduction callerを確認した。
`agent:e2e:test`のprovider-free **5件**は成功。compiled binary、実provider、実credential、live E2E、
full gate、ファイル変更は行っていない。ownerは現行sourceと実`deno run`の権限挙動を照合した。

1. **P2: work-tools sentinelの固定Deno childを起動できない（採用）**: `deno.v0.json`の
   `agent:work-tools:sentinel:credential-file`は`--allow-run=deno`だが、
   `work_tools_sentinel_launcher.ts`は固定絶対pathのDeno 2.9.4をspawnする。旧採用計画
   `docs/plans/local-work-tools-real-model-sentinel.md`はtaskにもこの絶対pathの許可を明示する。
   実task相当の`deno run --no-prompt --allow-run=deno -`では`deno`がgranted、固定pathはpromptであり、
   同条件で固定pathの`--version`だけを起動しても`NotCapable`だった。`deno eval`の権限照会は両方grantedと
   なり、実taskの再現には使えない。現taskはcredential／workspace準備後にchild起動で失敗する。
2. **P2: provider retryがsentinelのfetch上限を超え、失敗reportが実数を隠す（採用）**:
   旧計画は五つのtool処理に対し外部fetch開始最大5、成功時retry 0を定める。現
   `work_tools_sentinel.ts`の`GuardedModel`は`generate`を5回に制限するが、OpenRouter transportは
   HTTP 5xxで同一generateを最大2回retryできる。実adapter／loop／write tool、一時workspace、dummy
   credential／fake fetchで`503→503→write成功→503→503→503`を配送すると、actual fetch開始6、
   `runSentinel`返却値6に対してchild reportは`failureReport`のclampで5だった。
   約束した開始上限を超え、launcherへ渡る診断countも実数と違う。production provider adapterの
   retry動作そのものは変更対象ではない。

旧`agent:acceptance`はIncrement 11がdirect provider／loop fixtureとして意図的に残し、production CLI E2Eと
用途比較後の整理を別判断にしているため、重複だけを理由に削除しない。その他に具体的なcorrectness
findingまたは削除候補はなかった。

### 承認を求めるSlice 16修正計画

保持するproduct動作は、work-tools sentinelが固定Deno childを実taskの権限で起動でき、五つのtoolを
実経路で確認し、外部fetch開始最大5・成功時retry 0という既存scenarioを守り、失敗時も実際に始めた
fetch回数を親reportから読めること。実provider callやcredential読取りは今回行わない。

1. `deno.v0.json`の`agent:work-tools:sentinel:credential-file`だけ、`--allow-run`をlauncherの
   `DENO_COMMAND`と同じ固定絶対pathにする。binary、child argv/env、他taskの権限は変更しない。
2. `work_tools_sentinel.ts`のfetch wrapperで、`baseFetcher`を呼ぶ前に同一`generate`内の2回目のfetchを
   止める。`GuardedModel`の現在の呼出回数を用い、既存の最大5 generateと合わせてfetch開始も最大5に
   する。HTTP 5xx後にprovider adapterがretryしようとした場合は、追加fetchを開始せずsentinel失敗として
   報告する。production adapterのretry実装や通常product経路は変更しない。
3. `failureReport`が`externalRequests`を5にclampする処理を除き、実際に始めた回数を記録する。
   2の開始前制限により現行launcher parserの0〜5受理と成功時厳密5、`retryCount: 0`を維持する。
   report schema、tool順、workspace検証、credential境界は変更しない。
4. provider-freeのfocused testで、実`runSentinel`の五つのtool成功経路と、fake 5xxにより同一
   `generate`内でretryしようとした経路のfetch開始数・failure report・launcher readbackを確認する。
   必要な直接testを`tests/v0/`へ追加し、既存の`v0:test`へ登録する。固定pathはlive sentinelを実行せず、
   実taskと同じ`deno run --no-prompt`権限で`Deno.permissions.query`と固定Denoの`--version`起動を
   provider-freeで確認する。`v0:check`、`v0:fmt`、`v0:lint`、`git diff --check`を実行し、同じreviewerが
   変更箇所と2件の解消だけを15分以内で再reviewする。authoritative `v0:gate`は全Slice収束後に一回。

compiled binary、実provider、実credential、live E2E、commit、pushは本Sliceで行わない。構想・architecture・
roadmap、production provider契約、外部API、storageは変更しない。

### Slice 16実装・検証結果

- `agent:work-tools:sentinel:credential-file`の`--allow-run`をlauncherの固定Deno絶対pathに合わせた。
  実task相当の`deno run --no-prompt`でそのpathのrun権限が`granted`、固定childの`--version`が
  exit 0であることをprovider-freeで確認した。
- sentinelのfetch wrapperは同一`generate`内の2回目を開始前に停止し、失敗reportの
  `externalRequests`はclampせず実数を記録する。production adapterとreport schemaは変更していない。
- provider-freeの実`runSentinel` focused test **2件**が成功。五つのtoolを実行してfetch開始5・成功report・
  launcher parser readbackを確認し、HTTP 503ではretryの追加fetchを止めて開始1・`provider_failure`・
  `modelRequests=1`・report実数・parser readbackを確認した。直接testを`v0:test`へ登録した。
- `v0:check`、`v0:fmt`、`v0:lint`、`git diff --check`成功。authoritative `v0:gate`、実provider call、
  実credential、live sentinel、binary build／配置、commit、pushは行っていない。

### Slice 16限定再review

同じgpt-6-astra xhigh reviewerが15分以内に変更箇所と採用2件の解消をread-onlyで確認し、**追加finding
なし**。固定path権限、同一generateの追加fetch停止、最大5開始、実数report、launcher parser受理、五つのtool
成功経路を照合した。reviewerのfocused **2件**と対象`git diff --check`も成功。実child起動はownerの
`--version`証拠を参照した。実credential／provider、live sentinel、full gateは未確認。ファイル変更なし。

## Slice 17 — Corpus／evaluation

### 対象

- `v0/corpus/*`、`v0/eval/*`、`v0/corpus/task-corpus.v1.json`と、これらを直接検証するoffline test

production core／provider／toolとvalidation harnessはdata flow確認の到達先としてread-only参照できるが、
本Sliceで修正しない。実provider、credential、live corpus run、compiled binaryは使用しない。

### 評価基準

- task corpusのload／validation／canonical identity／scoringからoffline・live evaluationのexecution・reportへ
  どのdataが渡るかを追い、明示された評価目的と現行product経路に対して誤った合否や証拠欠落がないかを調べる。
- offline fixtureを実provider仕様と混同せず、live結果の観測値とreportが原因追跡に使えるかを確認する。
  credential値とAuthorizationは記録・表示しない。
- 同じ意味のvalidation、result projection、report整形の重複で、product動作を保ちながら単純化できる箇所を
  特定する。未観測variant、仮想failure、一般hardening、網羅matrixは対象外。

findingには明示要件・実行証拠・現行sourceから利用者影響への経路、最小変更、対応するfocused検証を要求する。
通常reviewは30分以内、新しい証拠・結果・中間結論が10分ない場合は中断する。reviewerはread-onlyで
full gateを実行しない。

### Read-only review結果と採用判断

同じgpt-6-astra xhigh reviewerはcorpus load／identity／scoring、offline・live runner／report、固定credential
launcherと直接callerを確認した。公式offline taskはexit 0、**24/24 passed**。現行`tests/v0`にはcorpus／evalを
直接importするtestは見つからなかった。live再現はdummy credentialとfake fetchを実adapterへ渡すprovider-free
確認のみ。実credential、実provider、live run、compiled binary、full gate、ファイル変更はない。ownerは次の
3件を現行source、旧採用計画、実`deno run`の権限挙動へ照合して採用した。

1. **P2: live corpusの固定Deno childを起動できない（採用）**: `deno.v0.json`の
   `agent:corpus:eval:live:sentinel:credential-file`は`--allow-run=deno`だが、
   `live_corpus_credential_launcher.ts`は固定絶対pathのDeno 2.9.4をspawnする。旧採用計画
   `docs/plans/pi-json-result-live-sentinel.md`はtaskにも同じ絶対pathを明示する。実task相当の
   `deno run --no-prompt --allow-run=deno -`では固定pathが`prompt`、そのchildの`--version`起動は
   `NotCapable`。credential読取り後、child起動で失敗し評価を開始できない。
2. **P2: provider 5xx retryで実fetchがcase上限を超え、live reportを返せない（採用）**: 現
   `live_corpus_execution.ts`のfetch wrapperはsuite合計上限だけを制限する。一方、現provider adapterは
   同一`generate`内でHTTP 5xxを最大2回retryする。実adapterにfake 503を返すと、先頭caseでfetchが3回
   始まり、`runLiveCorpusEval('sentinel')`はcase error reportを返さず`report_contract_invalid`をthrowする。
   V2 validatorはerror caseの外部回数をそのtaskの`maxRequests=2`以下とし、成功caseの集計も
   `model step数=fetch開始数`と照合する。旧`docs/plans/live-corpus-evaluation.md`はapplication retry 0、
   実request数と失敗caseを含むreportを定める。production provider adapterは変更対象外。
3. **P2: 正常なassistant metadata／tool前文をtranscript_malformedとする（採用）**:
   `offline_corpus_transcript.ts`のassistant `exactKeys(role,content)`は、現core `AssistantMessage`の
   optional `providerState`／`text`を拒否する。reasoning state保持はIncrement 12の明示契約。実adapterで
   正しい`character_count→submit_json_result`を配送すると先頭caseはpassedだが、同じtool応答に
   `reasoning_details`または`content: "Counting now."`を加えるだけで`transcript_malformed`となり、後続caseが
   中断する。正常なprovider応答を評価失敗としている。

V1 read validatorの保持は明示契約であり、削除しない。現行sourceと実利用影響に結び付く追加の削除候補は
採用しない。直接testが現行treeにない事実は検証範囲の記録であり、独立findingにはしない。

### 承認を求めるSlice 17修正計画

保持する動作は、固定live sentinelを現task権限で起動でき、各model stepの外部fetchは一回までで、503失敗も
case・実request数・後続`not_run`を含むV2 reportとして返し、正常なassistant metadata／tool前文がある
corpus実行でも元のtool結果とoracleで評価できること。今回は実provider・credentialに触れない。

1. `deno.v0.json`の`agent:corpus:eval:live:sentinel:credential-file`だけ、`--allow-run`をlauncherの
   `DENO_COMMAND`と同じ固定絶対pathにする。binary、child argv／env、他taskは変更しない。
2. 現行V2の`runLiveCorpusEval`に限り、各caseの`generate`呼出しとfetch開始を対応付け、同一`generate`
   内の2回目の`delegate fetch`を開始前に止める。suite合計上限も維持し、実fetch開始数をそのままcase／合計
   reportへ渡す。既に受け取ったHTTP 503によってretryを抑止した場合はそのstatusをrunner境界で保持して
   `provider_http_error`に分類し、追加fetchの抑止を`report_contract_invalid`へ変えない。production adapter、
   V2 report schema／validator、V1 read validatorは変更しない。
3. `offline_corpus_transcript.ts`のassistant message検査は、現core contractで認めるoptional `text`と
   `providerState`を受け入れる。scoreに必要な`role/content`、final text、tool call/result相関、terminal判定は
   維持し、optional fieldは元transcriptに保持したままobservation／oracle／report schemaへ混ぜない。
4. provider-freeのfocused testを`tests/v0/`へ追加し、`v0:test`に登録する。実`runLiveCorpusEval`＋実adapterの
   fake 503でfetch開始1、`provider_http_error`、先頭caseの実数と残り`not_run`、V2 report serialize／readbackを
   確認する。正常な六case成功と、先頭caseの`reasoning_details`／tool前文が同じscoreと後続継続を得ることを
   確認する。固定pathは実task相当の`deno run --no-prompt`でpermission queryと固定Denoの`--version`だけ
   provider-freeで確認する。`v0:check`、`v0:fmt`、`v0:lint`、`git diff --check`を実行し、同じreviewerが変更箇所
   と3件の解消だけを15分以内で再reviewする。authoritative `v0:gate`は全Slice収束後に一回。

compiled binary、実provider、実credential、live E2E、commit、pushは本Sliceで行わない。構想・architecture・
roadmap、production provider／tool契約、corpus data、external API、storageは変更しない。

### Slice 17実装・検証結果

- `agent:corpus:eval:live:sentinel:credential-file`の`--allow-run`をlauncherの固定Deno絶対pathに合わせた。
  実task相当の`deno run --no-prompt`で権限`granted`、固定childの`--version`がexit 0と確認した。
- 現行V2 `runLiveCorpusEval`は各`generate`の最初のfetchだけを開始する。503後の追加fetchを開始前に止め、
  観測したHTTP statusにより`provider_http_error`を保つ。case／suiteの実fetch数と既存report schemaは維持した。
  production adapterとV1 read validatorは変更していない。
- corpus transcript mapperは現core assistantのoptional `providerState`／`text`を受け入れ、score対象の
  `role/content`、tool相関、terminal判定は維持した。
- provider-freeの実`runLiveCorpusEval` focused test **4件**が成功。fake 503でfetch開始1・
  `provider_http_error`・残り`not_run`・V2 serialize／readbackを確認した。六case実tool成功は12 fetch／
  6 passed、先頭応答に`reasoning_details`またはtool前文を加えても同じreportと後続継続を得た。直接testを
  `v0:test`へ登録した。
- `v0:check`、`v0:fmt`、`v0:lint`、`git diff --check`成功。authoritative `v0:gate`、実provider call、
  実credential、live run、binary build／配置、commit、pushは行っていない。

### Slice 17限定再review

同じgpt-6-astra xhigh reviewerが15分以内に変更箇所と採用3件の解消をread-onlyで確認し、**追加finding
なし**。固定path権限、503時の開始数1・HTTP失敗report、V2 serialize／readback、assistant optional fieldと
元transcript／score／terminal判定の維持を照合した。reviewerのfocused **4件**と公式offline task
**24/24 passed**、対象`git diff --check`が成功。実child起動はownerの`--version`証拠を参照した。
実credential／provider、live run、full gateは未確認。ファイル変更なし。

## Slice 18 — Cross-cutting convergence

### 対象と評価基準

- cross-slice ledger 1〜6の解消状態と、Increment 112 baselineから本Incrementで変更したsource／testの
  component接続点を確認する。各Sliceで既に確認した局所実装の全面再reviewは繰り返さない。
- production CLI／Host／Worker／provider／tool／Session／history／TUI、validation harness／corpus evaluationの
  境界で、承認済み修正の組合せが明示product動作を壊さないか、責務ownerや同義の状態が不要に重複して
  いないかを現行sourceと実経路へ照合する。
- 正本の構想・architecture・roadmapと各Increment要件に抵触する場合は独自に要件変更せず、根拠と影響を
  報告する。findingには明示要件・実行証拠・現行sourceから利用者影響への経路、最小変更、focused検証を要する。

read-only reviewは同じgpt-6-astra xhigh reviewerが初回30分以内で実施し、新しい証拠・tool結果・中間結論が
10分間なければ確認済み／未確認範囲を返す。一般hardening、未観測provider variant、仮想failure、
permission matrix、既存test件数そのものをfindingにしない。reviewerはfull gateを実行しない。実provider、
credential、compiled binary、production stateの変更は行わない。

### Slice 18 review結果とowner判断

同じgpt-6-astra xhigh reviewerはbaseline `9570565a`からの変更に対し、cross-slice ledgerとcomponent接続点を
read-onlyで確認した。**追加findingなし**。各Sliceの局所reviewは全面反復せず、count、evidence、
Session／history、TUI、validation／corpusの受渡しを確認した。focused **7件**（terminal artifact readback、
provider snapshot／default 3件、lazy rename、web_searchの共有evidence／request admission 2件）が成功した。
実provider、credential、compiled binary、production state、full gateはreviewer側で使用せず、ファイル変更なし。

ledger 1のterminal tool／artifact、5のprovider environment、6のlazy resume後renameは各採用修正と
実経路で解消済み。ledger 2のexecution control二重入口、3のparent／aggregate budget表現、4のlegacy
metricsは構造として残るが、現callerの同一owner配線、単一実counterと同じlimit、現変更との組合せで
利用者へ至るcorrectness影響は確認できず、今回の採用基準により見送る。ledger 3ではmodelとweb_searchの
共有request admissionが維持されている。

### Increment 113最終検証

全Slice収束後の安定候補に対してcoordinating ownerがauthoritative `deno task --config deno.v0.json v0:gate`を
**一回**実行し、exit 0。`v0:check`、`v0:fmt`、`v0:lint`、登録済み`v0:test`が成功した。
`git diff --check`も成功。Slice 14・15の隔離XDG production TUI実経路確認は各Slice結果に記録済み。
実provider callとcredential読取りは行っていない。commit・push・binary配置は下記に記録する。

### Commit・push・binary配置

- 実装・test・計画記録をclean commit `6a9e2324916f390b9c8716b35955c2546f5cf5c8`へまとめ、
  `origin/main`へpushした。push前のremote先端は`8f57788e`で、途中のIncrement 112／113 commitも含めて
  `6a9e2324`まで進んだ。
- Deno 2.9.7でrepository task `henji:compile`をclean commitから実行し、`dist/henji`をbuildした。
  `--version`はproduct `0.4.0`、build `fa0f7b9ef773fc402deb0bd43fc74a4fb66915e267c0d9cea83cd5537611c72d`、
  source `6a9e2324916f390b9c8716b35955c2546f5cf5c8`、embedded runtime
  `b9d5cc74c199dbb30216ae700682a3d6c9cef215ee8f204740fef7a66bc74db6`を返した。
- 同じdirectoryの一時fileから`~/.local/bin/henji`へ原子的に置換した。build artifactと配置binaryはbyte一致し、
  配置binaryのSHA-256は`f241920e59a7fc63bb0ceaa595b4824269b3b8feda5a307a76157a0f5fd33049`。
  配置後の`--version`も上記identityと一致した。隔離XDGの`henji sessions list`／`henji history`は
  ともにexit 0で、実provider callは行っていない。
