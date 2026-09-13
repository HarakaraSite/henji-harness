# Henji 機能インベントリと反復型実装ロードマップ

ステータス: **採用済み — roadmapであり、各phaseの実装認可ではない**

作成日: 2026-09-06

実装状況の初回照合基準commit: `29c84cf17063da3565672ce4a37cdbf76334995e`

## 目的と正本

この文書は、次の正本から導かれる機能を列挙し、現行production経路の実装状況、Host / Worker
architectureとの対応、未実装機能の実装順序、各phaseで必要になる判断を一か所にまとめる。

- 構想: [`concepts/experience-driven-self-revision.md`](concepts/experience-driven-self-revision.md)
- architecture: [`architecture/henji-host-agent-worker.md`](architecture/henji-host-agent-worker.md)
- active sourceとcommand authority: [`../v0/`](../v0/)、[`../deno.v0.json`](../deno.v0.json)

上記commitはこの文書を作成したときの初回照合時点を示す。その後の変更を含む現コードの実装状況はactive
sourceを正本とする。両者に差があればactive sourceを優先する。`docs/plans/`に残る個別計画と結果は過去の
実装・検証の証拠であり、現在の実装状況やこのroadmapの機能順序を決める正本ではない。
`archive/`の旧roadmap、spike、旧extension管理実装も現在のproduct経路またはroadmapとはみなさない。

## roadmapもループする

Henjiの開発は、一度のroadmapで完全なproductを定義して作り切る工程にしない。一つのloopでは、通常利用へ
戻せる狭い機能増分を選び、実装後の経験を次のloopの入力にする。

```text
構想
  ↓ 必要なproduct動作
architecture
  ↓ 責務・状態・lifetime・commit境界
roadmap
  ↓ 今回の狭い増分と順序
実装・実利用
  ↓ 困難、有用な成功、違和感、利用者の判断
次の構想 / architecture / roadmap
```

実装で行き詰まったときは、現在の設計を前提に機能を狭めて通過しない。目的や必要な動作が違っていたら
構想へ、責務や境界が違っていたらarchitectureへ、順序や増分が違っていたらroadmapへ戻る。局所的な
実装問題なら同じphase内で直す。戻った結果、このroadmapの後続phaseは変更または破棄できる。

各loopの完了はHenji全体の完成を意味しない。将来、自己改訂の実装を人間が開始すると決めた場合の最初の
self-revision loopは、対象をDefinitionの改訂に絞って一度通常利用へ戻るところまでを目標にする。その前に、
repositoryと導入済みDenoへ依存しないstandalone executableと、Agent Definitionの実行可能なmodule closureを
immutable revisionとして保持・解決する基盤を通常利用で成立させ、別installationへ同じrevisionを移送できる
ところまでをIncrement 32〜34で段階的に扱う。
instructions、skills、context、tool、delegation、model、agent loop、runtime、Host / Worker連携、
Surfaceへの対象拡張は、通常利用の経験を受けて後続loopで一つずつ選ぶ。`AGENTS.md`と`SKILL.md`のnative
discoveryはmanaged installへ置き換えず、Henji独自Instructionや任意のmanaged Skillとは別authorityにする。
この依存順は、自己改訂を直近の実装incrementとして採用したことを意味しない。

通常利用で得た新しい構想として、canonical conversationだけでなくnon-canonical execution evidenceと、その
executionに関与したAgent側の状態を人間が振り返れるdurable historyを必要機能へ加える。改訂されたresourceを
後続executionへ適用する`/rebuild`相当の操作も必要機能の候補として管理する。durable historyにはSQLiteを採用し、
Increment 40のcanonical history cutover、41のlive execution journal、42のexact context attribution、43のhuman
history viewを順に実装した。Increment 44では旧filesystem storeをproduction module graphから除き、SQLiteを
唯一のdurable history経路に統一した。
`/rebuild`はこのprogramへ含めず、採用時に対象resourceから別途計画する。調査、第三者review、
各Incrementの成果境界と残る判断は
[`roadmap-inputs/durable-history-and-context-rebuild.md`](roadmap-inputs/durable-history-and-context-rebuild.md)に
分離する。

## 実装状況の読み方

| 表記 | 意味 |
| --- | --- |
| 実装済み | active sourceに現在のproduct動作がある。未観測の将来variantまでは含めない |
| 部分実装 | 後続機能に使える実装はあるが、列挙したproduct動作全体は成立していない |
| 未実装 | active production経路にそのproduct動作がない |

## 構想とarchitectureから導かれる機能一覧

### SurfaceとSessionの通常利用

| ID | 必要な機能 | 構想・architectureとの関係 | 現コードの状態 |
| --- | --- | --- | --- |
| F01 | 人間が外部文書やhelpを先に読まずHenjiへ依頼し、進捗と結果を理解して通常利用を続けられる。配布後はrepositoryや導入済みDenoへの固定参照なしに、任意のworkspaceから同じproduction経路を利用できる | 改訂前後の経験を生む通常利用。SurfaceはHostが所有し、実利用で改善する | **部分実装**。production TUIと非対話commandがあり、依頼・進捗・結果を表示できる。非対話commandはHost側のheadless SurfaceとしてTUIと同じWorker経路を一turn使い、final-only stdoutまたはfailure JSONを返す。TUIはturnとuser/output境界、入力前後を空行で分け、busy/cancelling開始から毎秒進む経過時間を含む一時statusとcwd・Session短縮ID・root provider・model・effortを二行footerへ表示し、`user>`、settledした`assistant>`、`tool>`、`system>`のlabelをblue/yellow/green/magentaで識別する。選択中root providerのcredential fileが存在しなければrequest前からfooter第一行へ表示し、editor先頭の`/`に一致するbuilt-in slash command候補を`ready`または`busy`の直後へ逐次表示する。候補が1件ならTabで完全なcommand名へ補完し、複数候補では入力を変えない。recoverable taskは空editorへ戻り、別draftがあれば`/recover`で取り出せる。idle Ctrl-Cは入力をclearしてreadyを保つ。F1 keyと`/help`のhelp overlayは残るが、compact startupに固定help hintは表示しない。現在のinstalled launcherはrepository内のTypeScriptと導入済みDenoに依存し、standalone executableではない |
| F02 | 構成済みのsystem instructionを含むprovider/model requestを実行し、複数step、tool call/result、planner delegationを進めるagent turn | AgentCompositionとturn semanticsはWorkerが所有する。F02はF06で構成済みの入力を各model requestへ渡し、tool call/result loopを実行する | **実装済み**。production TUIと非対話commandの共通Worker経路にprovider/model request、複数step、tool call/result、planner delegationがある。標準root turnは最大64 model stepsで、TUIはOpenRouterを既定に保ちつつ、起動時の`--root-provider openai`またはidle時の`/provider`でOpenAI direct Responses rootへ切り替えられる。`/model`と`/effort`はactive providerのcurated catalogを使い、同一Session内のselectionとして保存する。一turnのtool loop中は選択を固定し、delegated plannerはrootから継承せずOpenRouter planner defaultを使う。TUI起動時の`--provider-timeout-ms`は、未指定時120,000 msのrequest単位deadlineを同じWorker invocationのroot、planner、context compactionへ適用する。deadline到達はresponse不正と区別して表示し、自動retryまたはmodel fallbackはしない。`skill` toolの結果はtranscriptへ入り、次のmodel stepから参照される。`read`はcomplete-lineの`offset`・`limit` windowを返し、default parentの`bash`は切り捨てたstdout/stderrを`bash_output`で保存上限まで継続取得できる。default parentの`web_search`はroot providerと独立したOpenRouter Sonarを一回呼び、検索結果に限定した回答のlocal citationを直接source linkへ正規化して次のmodel stepへ渡す。追加model requestは親budgetとcountへ含み、未加工のraw response、SSE/parser transition、provider/API/model/auth-profile identityをevidenceへ保持する。increment 9のcitation正規化はproduction retained TUIで受入済み |
| F03 | workspaceの`AGENTS.md`とworkspace/user scopeの`SKILL.md`をnative規約でzero-install discoveryし、実行中に共有するsnapshot/catalogを作る | 他harnessと共有するfile format、配置、discovery、activationをHenji独自managed resourceで置換しない。将来のmanaged SkillとHenji Instructionは追加authorityとして分離する | **部分実装**。Worker generationの起動時にworkspace rootのinstructionとworkspace配下の`.zot/skills`、`.claude/skills`、`.agents/skills`を一度読み、実行中に共有するimmutableなinstruction snapshotとskill catalogを構築する。user-scope Skill discoveryは未実装である。tool call時には再読せず、snapshot/catalog自体はSessionへ永続化しない。`skill` toolを呼んだ場合の結果はF02のtranscriptへ入る。managed Skill revision、Henji Instruction revision、改訂候補の生成・採用も未実装である |
| F04 | canonical conversation、non-canonical execution evidence、context attributionを再起動後も区別して利用する | Hostがdurable storageとcanonical採用を所有し、Workerがconversation/contextの意味を所有する。物理的なstorage commitとcanonical adoptionを分ける | **実装済み**。Increment 40〜44でworkspace-local SQLite schema v3を唯一のproduction history正本とし、canonical turnのatomic adoption、settled non-canonical execution、active executionのlive journalとrestart reconciliation、tool effect、`/recall` projection、instruction・skill・tool contract・runtime fact・model requestのexact context attribution、provider evidence、diagnostic、artifactをdurableに相関した。旧filesystem storeはproduction経路から除外済みである |
| F05 | 人間が保存済みSessionのcanonical/non-canonical historyとcontext attributionを通常利用中に参照する | 経験を人間が確認し、診断、`/recall`、後の改訂指示へ使うSurface機能。history rendererとmodel projectionを分ける | **実装済み**。Increment 43の`/history`はcurrent Sessionのcanonical/non-canonical executionを一つのread-only timelineとしてkeyset paginationし、tool activity、projection、context attribution、model request、provider evidence、diagnostic、artifactのexact detailを辿れる。case-sensitive literal検索、canonical-only Markdown export、durable history全体のstreaming JSONL exportがあり、閲覧・検索・exportはmodel context projectionと分離されている。将来`/rebuild`等が新しいtransition kindを導入する場合は、その個別Incrementでhistory projectionを拡張する |

### AgentCompositionと現在のHost / Worker runtime

| ID | 必要な機能 | architecture上の責務・境界 | 現コードの状態 |
| --- | --- | --- | --- |
| F06 | executable TypeScriptのAgentDefinitionがprovider、model、effort、loop、tools、subagents、context、instruction、skillをAgentCompositionへ合成する。外部DefinitionはHenjiが管理するmodule identityとrevisionから選べる | Definition moduleの取込・保存・解決・readbackはHost、Definition評価とcomposition実行はWorker。F03のinstruction snapshot本文とskill catalogのmanifestをsystem instructionへ合成し、skill本文を取得する`skill` toolをregistryへ組み込む | **部分実装**。built-in `default` / `planner`とworkspace-local external Definitionがある。現Definitionはmodel、registry/tools、subagent、maxSteps、system instruction等を選べ、built-inのmaxSteps既定値は64である。TUIのsession-level model/effort overrideはDefinition revisionを変えず、Workerが返されたroot compositionのmodel routeだけへ反映する。delegated plannerは固定planner defaultを使う。選択済みwork toolと`web_search`はWorker-local `ToolComponentCatalog`からmaterializeし、external Definitionは同一identity・nameのroot componentを明示置換できるが、plannerへは暗黙伝播しない。`web_search`はHenji-owned contractと交換可能backendを分離し、初期backendにOpenRouter Sonarを使う。built-in instructionは`v0/agent/instructions/`でHenji共通、role、active tool guideline、workspace instruction、skill manifest、runtime facts（cwdのみ）の順にnamed componentを合成し、実際のcomponent identityをmanifestへ記録する。Henji共通componentは、翻訳・要約・派生物作成でcurrent sourceを直接読み、指示外の事実・contract変更やtemporary artifactだけのtracked file変更を避け、完了前のsource照合と確認済み・推定情報の区別を求める。defaultとplannerはmaterialize済みregistryから自分が持つtoolのguidelineだけを受け、OpenRouter/OpenAI adapterには同じresolved本文をprovider固有fieldへ写像する。skill本文は一括注入せず、modelが`skill` toolを呼んだ場合だけtool resultとして渡す。loopとcontext/compactionは`WorkerGeneration`の固定実装である。任意pathからのmanaged install、module catalog、revision readbackは未実装である |
| F07 | Worker起動前にDefinitionの実行可能なmodule closureまたは同等の自己完結bundleをimmutable revisionとして参照する | Hostがentryと実行に必要なlocal dependencyをmanaged storeへ固定して`DefinitionRevisionRef`を確定し、Workerがstore内の確定revisionだけを解決・評価する | **部分実装**。canonical specifier、entry SHA-256、source bytesをv2〜v5 Sessionに保存するが、現Workerは元specifierから依存を解決する。local dependency closure、dependency lineage、managed revision storeは未実装 |
| F08 | 評価後の構成をdata-onlyなAgentManifestとして説明し、executionから使用したAgent側の基底設定をreadbackできる | Workerがprojectionを返し、Hostはidentity/admission authorityや実際のmodel input全体と混同しない | **部分実装**。role、maxSteps、実際のroot provider/model/effort、planner provider/model/effort、profile、effective model resource IDsをexecution artifactに残す。Definition/build attributionもあるが、instruction内容、読み込んだskill、tool contract、供給・観測したenvironment情報を一つのcontext attributionとしてreadbackする機能はない |
| F09 | built-inとexternal Definitionを同じDeno Web Worker capsuleで実行する | Web Workerはlifecycle/data境界であり別trust tierではない | **実装済み**。TUIと非対話commandが同じsession factoryを入口に、同じloader、bootstrap、runtime、protocol、commit経路を使用する |
| F10 | UIをWorkerから分離し、Host側の交換可能なSurfaceとして扱う | terminal / Surface I/O、layout、draft、cursor、viewportはHost、Workerはheadless | **部分実装**。data-only presentation contract、Host-owned TUI adapter、terminal lifecycle分離があり、turn/input境界、二行footer、viewport復帰、plain assistant本文renderer、conversation label style、history export operationもHost-localに実装する。Surfaceを選択・load・置換する一般product interfaceはない |
| F11 | HostがWorker generationを起動、停止、監視、置換する | Worker generationのlifecycle ownerはHost | **部分実装**。起動、cooperative close、cancel、terminate、settlementはある。durable Instanceを保ったrestart/replacementはない |
| F12 | Host / Worker間でdata-only command、event、effect、proposal、ackを交換する | 関数は境界を越えず、protocolがapplication semanticsを運ぶ | **実装済み（現在のslice）**。TUIとone-shot headless CLIの両方がstart/turn/proposal/commit/ack/closeを使い、TUIにはsteer/cancel/checkpointとidle時のprovider/model selection/ackもある。将来機能のmessage、handshake、version migrationは未決 |
| F13 | WorkerのproposalをHostが検証・永続化し、durable write後だけcommittedとする | durable Session storeがcanonical。Worker stateはephemeral | **実装済み**。base state revision、transcript、next turn、Definition bindingを検証してcommit/ackする |
| F14 | Instance、Definition revision、generation、base state revisionを相関し、admit済みwriterだけをcommitできる | Hostのadmissionとrevision fencing | **部分実装**。Session、ephemeral instance correlation、generation、base state revision、Definition refを現在の一Session内で検証する。durable `AgentInstance` identityがない |
| F15 | tool effectとstate commitを区別し、不明なeffectを自動replayしない | Workerはeffect evidenceを返し、Hostはsettlementを記録する | **実装済み（現在のtool経路）**。tool event、execution artifact、`automaticReplay: false`、`effectCommitRelation: not_transactional`がある |

F02、F03、F06の境界は次のとおりである。F03がWorker generation起動時にinstruction snapshotとskill
catalogを作り、F06がinstruction本文とskill manifestをsystem instructionへ合成するとともに`skill` toolを
registryへ組み込む。F02は、そのsystem instructionを各model requestへ渡し、modelが`skill` toolを呼んだ
場合は、起動時のcatalogに保存した該当skill本文をtool resultとしてtranscriptへ加え、次のmodel stepへ渡す。
したがって、skill一覧は最初のmodel requestから見えるが、skill本文は最初から一括してmodelへ渡されない。
これはnative discovery経路の責務である。将来のmanaged Skill revisionとHenji独自Instruction revisionはF03の
zero-install入力を置換せず、F24で各resource kindのselection authorityと合成順を決めて追加する。

### 現在のSurface実装であるproduction TUI

F番号はcomponentではなく、利用者が必要とするproduct機能に付ける。production TUIはF01の通常対話、
F05のSession/history/context参照、F10のHost-owned Surfaceを横断して実現する現在のSurfaceであるため、
TUI自体には独立したF番号を付けない。現在のproduction TUIには、次の実装がある。

- turnとuser/outputの表示専用境界を持ち、`user>`、settledした`assistant>`、`tool>`、`system>`のlabelを
  blue/yellow/green/magentaで識別するconversation log、前後を空行で分けた複数行入力欄、一時status行と
  cwd・Session短縮ID・root provider・model・effortの固定identity行からなる二行footer。
- request/evidence metadataやraw tool resultを常時展開せず、assistantと短いtool activityを追える表示。
- ready / busy / cancelling / failure、busy開始から毎秒進む経過時間、history位置、pending input、操作結果の
  一時表示と、ASCII・日本語・wrapを含むcursor位置。
- alternate screenによる現在Sessionの隔離、PageUp / PageDownによるviewport移動、過去表示中の位置と
  `Esc latest`表示、PageDown末尾到達・idle Esc・通常task admissionによる最新追尾への復帰、終了時の
  terminal復元。
- 過去表示中のdraft保持、boundedな入力履歴、更新日時・手動title・短縮ID・turn数を二行表示するSession選択、
  `/rename <title>`によるcurrent Sessionの命名、`/help`・`/sessions`・`/provider`・`/model`・`/effort`・
  `/history export`・`/recall`・`/recover`・`/exit`、readline編集、一意なslash command候補のTab補完、Tabによるworkspace-relative path補完、Alt+Returnによる改行。`/history export`は
  current bindingのcommit済みcanonical transcriptをworkspace別state rootへMarkdown snapshotとして保存する。
- plain textを既定とするHost-local assistant本文renderer。terminal styleは最終frameだけに加え、layout、
  Presentation event、canonical transcriptへ混入させない。
- busy中の一回のsteeringとfollow-up、cancel、uncommitted inputの固定lane、recoverable taskのeditor自動復元と
  `/recover`、idle Ctrl-Cによるdraft clear。

現行sourceでは、旧Ctrl-G / Ctrl-T / Ctrl-Lの機能入口を除去し、Ctrl-Kをreadlineの行末削除としている。
保存済みcausal historyとcontextの内部projection・controller処理は残るが、現在の人間向け入口はない。
modified ReturnのdecoderはShift / Alt / Ctrl sequenceを改行として処理するが、各terminalがどのsequenceを
送るかはactive sourceが規定するproduct動作ではない。

この実装状況は、`v0/tui/input.ts`、`v0/tui/state.ts`、`v0/tui/layout.ts`、`v0/tui/render.ts`、
`v0/tui/controller.ts`、`v0/tui/terminal.ts`、`v0/tui/pending_input.ts`、`v0/tui/file_reference.ts`、
`v0/agent/cli/tui_cli.ts`、`v0/presentation/tui_presentation_adapter.ts`と照合した。

### durable AgentInstanceとrevision transition

F16〜F18は現在の通常利用に必要な機能ではない。人間が将来self-revision loopを開始すると決めた場合に、
同じagent identityをSessionやWorker generationをまたいで維持し、採用したDefinition revisionへ切り替える
ための基盤である。

| ID | 必要な機能 | architecture上の責務・境界 | 現コードの状態 |
| --- | --- | --- | --- |
| F16 | Worker generationより長く存続するdurable AgentInstanceを持つ | resident Hostがdurable lifecycle ownerとなり、stable identity、metadata、active Definition bindingを所有する | **未実装**。現`instanceCorrelation`は`WorkerHostSession`ごとに生成され、永続化されない |
| F17 | SessionをAgentInstanceへ所属させ、Instance単位でwriterとinputをserializeする | 一Sessionは一Instanceに属し、同一Instanceのwriter generationは同時に一つ | **未実装**。Sessionはworkspace、agent、Definitionには結び付くがInstance IDを持たず、別Sessionをまたぐwriter ownershipはない |
| F18 | 同じInstanceのDefinition revision bindingを人間の判断でdurableに切り替える | restartとrevision transitionを区別し、Hostがbindingをcommitする | **未実装**。現行はstartup selectorと保存済みrefが一致する場合だけreopenし、revision transitionを拒否する |

### 経験駆動の改訂ループ

| ID | 必要な機能 | 構想・architecture上の責務 | 現コードの状態 |
| --- | --- | --- | --- |
| F19 | 通常利用の困難、成功、違和感、利用者判断を、後のWorkerがSessionをまたいで読める経験として残す | Hostがdurable historyとstorage mechanism、Workerが経験の意味と選択を所有する。canonical/non-canonicalとcontext attributionを区別する | **部分実装**。canonical transcript、checkpoint、non-canonical execution artifact、`/recall`はあるが、Instance/cross-sessionの経験正本、利用者判断、目的・理由、Agent側基底設定との統一attributionを扱う機能はない |
| F20 | 人間の明示的なアクションまたは指示を契機に、Worker内AIが経験を解釈して改訂候補を作る | 候補生成の意味はWorker。人間の契機なしに自発生成しない | **未実装**。通常agentがfileを編集できることは、この候補生成product flowの実装とはみなさない |
| F21 | 生成候補をactive revisionと分離して保存し、人間が内容と由来をreadbackできる | Workerがsource/diff/data候補を返し、Hostがnon-active candidateとして保存する | **未実装** |
| F22 | 人間の採用アクションまたは明示的承認でだけ候補を採用する | Hostがimmutable revisionを確定し、AgentInstance bindingをdurableに切り替える | **未実装**。production経路ではなかった旧extension操作実装は削除済み |
| F23 | 改訂後のHenjiで通常利用へ戻り、そこで得た変化を次の経験にする | loopを閉じるproduct動作。統制実験や定量測定は必須ではない | **未実装（end-to-end）**。通常利用自体はあるが、候補生成・採用との一続きのloopがない |
| F24 | 経験に応じてDefinition以外のresourceも改訂対象にできる | managed revision候補、native external input/state、binary platform authority、追加architecture判断が必要な対象を区別する。対象kindごとにcontent、contract、dependency、activation、scope、execution placement、lifecycle、durability、evidenceをarchitectureへ反映してから実装する | **未実装**。候補にはHenji Instruction、任意のmanaged Skill、tool、model profile、subagent、Surface data/code、integration declaration、context/compaction、provider adapter、loop、storage等がある。native `AGENTS.md`/Skill discoveryやMCP connectionをmanaged installへ置換せず、最初のloopではDefinition以外を採用しない |
| F25 | exact managed resource revisionをinstallation間でtransportする | export packageはstore layoutと分離し、manifestとcontent closureを運ぶ。credential、Session、workspace、binary、active bindingを混入させず、import先がidentity、contract、digestを検証してlocal custodyへpublishする | **未実装**。Increment 34ではAgent Definitionだけをexport/importする。他resourceのlocal managed化はtransportを必須前提にしない |

### Durable historyとcontext適用

| ID | 必要な機能 | architecture上の責務・境界 | 現コードの状態 |
| --- | --- | --- | --- |
| F26 | 人間がsettled non-canonical executionを選び、その保存内容を次の一つのtaskへ明示的に投影する | Hostがsource選択、次taskへの一回のprojection、source/target attributionを所有する。sourceをcanonical化、resume、自動retryしない | **実装済み**。Increment 38の`/recall`がcurrent Sessionのexecutionを選び、次task内のmodel requestへdata-only contextを渡す。sourceはnon-canonicalのままで、targetだけが通常のatomic commit対象になる |
| F27 | 人間が明示した`/rebuild`相当の操作で、対象resourceからAgent側の新しい基底設定を構築し、後続executionへ適用する | Hostがgeneration transitionを調整し、Workerが解決済み設定からAgentCompositionを構築する。過去turn/context attributionは書き換えず、history viewとmodel projectionを分ける | **未実装**。現在はWorker generation起動時にworkspace instructionとskill catalogをsnapshot化し、既存Sessionのまま人間が再構築する操作はない。Increment 40〜43のdurable history programから分離し、44以降で採否を判断する。最初の対象resource、`AgentContextGeneration` identity、Worker交換、draft維持、transitionのcommit/failure semanticsは未決である。Agent Definitionとtoolは対象候補だが対応確定ではない |

## architectureで例示する採用未決の将来オプション

以下は、現時点のarchitectureで例示している採用未決の将来オプションであり、将来機能の網羅的な一覧では
ない。現時点の構想から実装を要求されるものでもない。人間が明示的に機能を要求するか、通常利用の経験から
必要性を判断して採用した場合に、architecture上の責務を具体化してroadmapへ追加する。ここにない機能も、
同じ構想・architecture・roadmapのloopで追加できる。

| 例示ID | 将来オプション | 採用した場合のarchitecture |
| --- | --- | --- |
| C01 | Worker不在時にもInstance宛てinputを保持するmailbox | Hostがdurable queue、Workerがdequeue eventの意味を所有する |
| C02 | 非同期または複数Surface間のmessage routing | HostがmessageをInstance/Sessionへ対応付け、Workerはoutputの意味を生成する |
| C03 | scheduleによるwake-up | Hostがtime/deliveryとenqueue、Workerがschedule intentとevent処理を所有する |
| C04 | 常にaddress可能なagent operationとdelivery | Phase 1のlifecycle ownerへ、外部からの常時到達性、delivery、継続稼働とそのservice supervisorを加える。Worker常駐は不要 |
| C05 | 一般的なInstance-wide mutable state | HostがInstance revision、lock、persistenceを所有し、Sessionとの二重正本を避ける |

## 機能一覧と主なarchitecture領域の対比

一つの機能が複数領域に関わる場合があるため、この表は各F番号の主な対応先を引く索引であり、網羅的な
責務表ではない。

| architecture領域 | 対応する機能 |
| --- | --- |
| Surface / human interaction | F01、F05、F10、F20〜F23、F25〜F27 |
| HenjiHost lifecycle | F07、F11、F14、F16〜F18、F25〜F27 |
| Host storage | F04、F13、F15〜F19、F21〜F23、F25〜F27 |
| Agent Worker | F02、F03、F06、F08、F09、F12、F19、F20、F26、F27 |
| commit / revision boundary | F07、F13〜F15、F18、F21、F22、F25〜F27 |

F24のarchitecture領域は固定しない。次のself-revision loopで選んだ改訂対象に応じて、Agent Worker、Host、
storage、Surface、またはそれらの境界のどこへ対応させるかを決める。

現在のprovider/tool物理I/OはWorker bootstrap内で構築される。architectureはこのplacementを将来も固定する
決定にはしていない。最初のloopで変更する具体的理由がなければ現配置を保ち、別の境界を設計しない。

## 反復型実装ロードマップ

| 分類 | 対応する機能 | 詳細 |
| --- | --- | --- |
| 通常利用と改善 | F01〜F15、F26、F27 | 通常利用で見つかった問題を改善する。F26はIncrement 38で実装済み。F04/F05/F08/F11/F15はIncrement 40〜43のdurable history programで拡張し、Increment 44でSQLiteを唯一のproduction history経路に統一した。F27は別計画で判断する |
| 配布とDefinition revisionの前段基盤 | F01、F03、F04、F06、F07、F09、F25 | Increment 32〜34でstandalone executable、native discovery、local managed Agent Definition、Definition transportを順に成立させる |
| Self-revision Cycle 1 | F16〜F23を中心とし、F01、F05、F11、F14も拡張・再利用する | Phase 1〜5 |
| Cycle 1後の改訂対象拡張 | F24 | 後続のself-revision loop |
| 追加オプション | C01〜C05は非網羅的な例示。採用時に正式なF番号を付ける | 構想から要求されていない将来オプション |

### 通常利用で見つかった問題を改善する（F01〜F15、F26、F27）

人間が改善を直接要求するか、通常利用で具体的な問題や改善機会が見つかった場合は、F01〜F15、F26、F27のどの
product動作に関わるかを確認し、通常利用へ戻せる狭いincrementの個別実装計画を
`docs/increments/increment-N.md`として作る。このroadmapへ個々のincrementや作業履歴を追加しない。
契機がなければ実装作業は発生しない。この改善とSelf-revision Cycle 1は別であり、一方から他方の開始は
自動決定しない。

TUIの改善もこの扱いに含む。入力・表示・操作性は主にF01、Session/history/contextの利用はF05、Surfaceの
分離・load・置換はF10へ対応付ける。既存Fで表せない新しいproduct動作には新しいF番号を付ける。Surface
自体をself-revisionの対象にする場合は、Cycle 1後のF24で扱う。目的を変える場合は構想、Host / Worker /
Surface境界を変える場合はarchitectureへ先に戻る。

#### Durable history program（F04、F05、F08、F11、F15、F26）

workspace-local SQLiteを正本とする次の順序で実装した。詳細な調査、破壊的cutover条件、第三者reviewの結果は
[`roadmap-inputs/durable-history-and-context-rebuild.md`](roadmap-inputs/durable-history-and-context-rebuild.md)を
正本とし、各Incrementの具体的schema/APIと検証結果は個別Increment文書に記録する。

1. Increment 40: destructive SQLite canonical history cutover。task、execution、canonical turn、model requestを
   関係付ける。旧JSONはscan、import、変換、互換読込せず、空のSQLite authorityから開始する。旧filesは自動削除
   しないが新しいproduct経路からは到達不能とし、SQLite failure時もfallbackしない。
2. Increment 41: live execution journal。dispatch前のactive executionとHost-observed eventをdurableにし、
   Session writer lockの内側でrestart reconciliationする。
3. Increment 42: exact context attribution。instruction、skill、tool contract、runtime factのcontent snapshotを
   execution/model requestへ相関する。
4. Increment 43: human history view。canonical/non-canonical timeline、検索、evidence navigation、durable history
   全体のexportを提供し、model context projectionとは別責務にする。

過去turnの暗黙継承はcanonical由来に限定するが、model inputには現在executionのuser/assistant/tool message、
明示的にadmitした`/recall` projection、現在のtask/runtime inputも含む。`/recall`本文はcanonical turnへ複製しない。
完全再現性、過去Workerの保存、外部状態の再現は完了条件にしない。

`/rebuild`（F27）はIncrement 40〜43から分離した。historyとcontext attributionの通常利用は確認済みであり、
対象resource、`AgentContextGeneration`、activation/transition semanticsは採用時に別途計画する。

#### AgentCompositionを拡張する場合（F06）

通常利用またはself-revision loopで、effort、loop、context/compactionのいずれかをDefinitionごとに変更する
具体的な必要が生じた場合は、その一要素についてDefinition input/output、AgentComposition内の表現、
Manifestの説明範囲、generation/turn単位の構築時期を決める。全要素を一度に一般化せず、変更がWorkerの
責務内に収まらなければ実装前にarchitectureへ戻る。

#### Surfaceをload・置換する場合（F10）

第二のSurfaceを採用する、現在のSurfaceを置換する、またはself-revision操作をTUI固有実装へ閉じない必要が
生じた場合に開始する。その時点でSurface identity、Hostによるload/selection、input actionからWorker
commandへの変換、output delivery、active Sessionとのbinding、置換時の状態引継ぎを決める。

### Increment 32 — standalone executableとexternalization共通境界

対象機能: F01、F03、F04、F06、F07、F09

Self-revision Cycle 1へ入る前に、Deno runtimeとproduction entryを含む単一の`henji` executableを作り、binary、
XDG config/data/state、workspace inputの配置とauthorityを分離する。同時に、将来のresource kindが共有できる
versioned `ManagedResourceRef` envelope、logical refとprocess-local physical descriptorの分離、build/API contract
attributionを導入する。汎用plugin loaderやexternal Definition installはまだ実装しない。

- executableはrepositoryやPATH上のDenoを参照せず、任意path・任意workspaceからTUI、非対話command、
  diagnostics、`--version`を利用できる。
- Worker bootstrap、built-in Definition、embedded `@henji/agent` API、現行runtimeをcompile artifactへ含め、
  build revision、Deno version、target、embedded runtime digest、supported API contractをreadbackできる。
- Session、execution artifact、diagnostic/evidenceをpath非依存logical ref schemaへ切り替える。開発版旧schemaは
  移行せず、別identityへ黙って再解釈しない。
- 現行`--definition <path>`を廃止し、unmanaged Definition refを新schemaへ持ち込まない。Increment 33完了までは
  built-in Definitionだけを利用する。
- workspace `AGENTS.md`とworkspace Skillのnative zero-install discoveryをcompiled binaryでも維持し、未実装の
  user-scope Skill discoveryを加える。具体的な互換locationとprecedenceは個別計画で現行sourceと参照するnative
  contractを照合して確定する。managed installは要求しない。MCPと他resource kindは実装対象外である。
- release automation、tag/publish、複数platform matrix、新しいsandbox/permission modelは対象外とする。

完了時は、別path・isolated XDG root・任意workspaceからcompiled binaryのTUI/非対話turnを実providerで完了し、
Session/evidenceからbuild identityとbuilt-in logical refをreadbackできることを確認する。同じproduction経路で
workspace `AGENTS.md`、workspace Skill、user-scope Skillがinstall操作なしに発見・適用されることも確認する。

### Increment 33 — local managed Agent Definition revision

対象機能: F06、F07、F09

任意pathのTypeScript Definitionと許可されたlocal module closureをHenji管理下へinstallし、元source pathではなく
exact managed revisionから新しいSessionを開始できるようにする。

- `module install`、list、inspect、exact revision selectorを提供し、module ID、parent/planner role、entry、closure、
  API contract、origin lineage、local custodyを区別してreadbackできる。role未指定時はparentとする。
- static relative `.ts` import/exportとembedded `@henji/agent`だけを初期contractに含め、remote URL、JSR、npm、
  computed dynamic importは対象外とする。
- identity manifest、origin lineage、local custody metadataを分け、closure全fileとdependency bindingをcanonical
  digestへ含める。初期binding listは空でよい。
- installとactivationを分離し、登録だけで既存SessionやWorkerを変更しない。元sourceを変更・削除しても保存済み
  revisionを起動でき、sourceを編集して再installした場合は新revision、同じcontentなら同じrevisionにする。
- external parent Definitionに同梱したbuilt-in toolのsame-identity replacementは許すが、新tool identity、planner
  replacement、独立tool revision、AIから呼べるinstall、hot reload、remove/GCは対象外とする。
- built-in/externalの両方を同じWorker capsule、protocol、atomic commit経路で実provider turnまで確認し、Session、
  execution artifact、provider evidenceからHenji buildとexact Definition refを相関できるようにする。

### Increment 34 — Definition revision transport

対象機能: F07、F25

Increment 33のexact Agent Definition revisionをstore layoutとは独立したpackageへexportし、別PCまたは別XDG data
rootへ同じlogical identityとしてimportできるようにする。

- packageはrevision manifestとsource closureを含み、import時にresource kind、module ID、role、API contract、
  closure全file、canonical digestを検証してtarget managed storeへatomicにpublishする。
- original source lineageとimport先のlocal custody metadataを分け、同一revisionがあれば既存revisionを返す。
- target binaryがsupportしないcontractでもcustody目的のimportは許し、実行時にidentityを変えず明示的な
  compatibility failureを返す。
- credential、Session、workspace、Henji binary、built-in Definition、AgentInstance active binding、remote registryは
  packageへ含めない。
- 初期package contentはAgent Definitionだけとする。他resourceのlocal managed化はIncrement 34を必須前提にせず、
  transportが必要なkindだけ後からpackage envelopeを拡張する。

完了時は、異なるisolated XDG data rootへexport/importしたrevisionのlogical refとdigestが一致し、元sourceなしで
通常taskを完了し、target Henji buildと移送したDefinition refをexecution evidenceからreadbackできることを確認する。

### Self-revision Cycle 1（F16〜F23を中心とするPhase 1〜5）

人間がSelf-revision Cycle 1の実装を開始すると決めた場合に、以下のPhase 1〜5をdependency orderとして使う。
対象は一つのdurable AgentInstance、一つのworkspace、Definitionだけとし、F01、F05、F11、F14を拡張・再利用
する。前段で成立したstandalone executableとmanaged Agent Definition revisionを前提とする。resident Hostは
Phase 1の前提に含め、Definition以外の改訂対象と採用未決の追加オプションは含めない。
各phaseの実装には個別の計画と承認が必要である。

ここでresident Hostとは、TUIやWorker generationから独立してAgentInstanceのlifecycleとdurable stateを所有する
役割を指す。外部から常時到達できるようHost processの稼働を保証することと、その非同期deliveryはPhase 1に
含めず、C04などの追加オプションを人間が採用した場合にだけ扱う。

### Phase 1 — durable AgentInstanceとrevision binding

対象機能: F11、F14、F16、F17、F18の基盤

利用者が必要とする動作:

- Henjiの同じInstanceをHost processやWorker generationの終了後にも選択・再開できる。
- resident Hostがdurable lifecycle ownerとして、各Instanceのactive Worker generationが0または1である
  状態を管理する。TUIや個々のWorkerをInstanceのlifecycle ownerにしない。
- Instanceが現在使う正確なDefinition revisionを人間がreadbackできる。
- 一つのInstanceに複数Sessionを所属させられ、active writerはInstance単位で一つになる。
- 同じrevisionのWorker再起動と、別revisionへのbinding transitionを区別できる。

このphaseで決めること:

- AgentInstance ID、durable metadata、workspaceとの関係、作成・選択・再開の人間向け操作。
- SessionからInstanceへの所属を保存するschemaと、既存schema-v1/v2 Sessionの扱い。
- active `DefinitionRevisionRef`をInstance metadataへ置く方法と、Session側に残す相関情報。
- 前段で登録・load可能になったexact `DefinitionRevisionRef`を、Instanceのcurrent/base revisionとしてbindし、
  readbackする方法を決める。candidateから新revisionを確定してbindingを切り替える方法はPhase 4で決める。
- compositionをgenerationごとに一度構築する現挙動をCycle 1でも維持するか。
- resident Hostのprocess/service境界、起動、停止、durable stateからの再開、Hostを起動する主体をどの
  実行環境へ置くか。外部deliveryのための常時稼働保証とservice supervisorはC04を採用した場合に決める。
- Instance writer admission、generation/lease identity、base Session revisionを運ぶprotocol変更。
- 同じInstanceへ複数inputが来たとき、どれをadmitし、拒否、待機、順次実行のどの動作を人間へ返すか。
  admitしたinputは一つのwriter generationへ順序付きで渡す。

このphaseで決めないこと:

- mailbox、routing、schedule、常にaddress可能な到達経路とdelivery。
- 外部deliveryのためにHost processの常時稼働を保証するservice supervision。
- candidateの形式や採用UI。
- Definition以外の改訂対象。

完了のproduct証拠:

- 一つのInstanceに属する二つのSessionを作成・再開し、同じactive revisionをreadbackできる。
- TUIとWorkerを終了・再生成してもresident HostがInstanceを所有し、Host自体の再起動後もdurable stateから
  同じInstanceとrevision bindingを再開できる。
- 別Sessionまたは古いgenerationがInstanceのcanonical stateをwriterとしてcommitできない。
- 同じInstanceへ重なるinputを与え、Phase 1で採用した拒否、待機、順次実行の動作が人間へ明示される。
  複数writerが同時に実行または順序外commitしない。

### Phase 2 — 経験の保存とWorkerからの参照

対象機能: F05、F19と、F20の入力境界

利用者が必要とする動作:

- 通常利用で得た困難、成功、違和感、目的、判断理由を、後の改訂指示で使う経験として残せる。
- 人間がcanonical turnとsettled non-canonical executionの双方、およびそれらに関与したAgent側の状態を
  区別してreadbackできる。
- 人間が改訂を指示したとき、Workerは選ばれた経験をSessionをまたいで読める。

このphaseで決めること:

- transcriptをそのまま経験とみなす範囲と、利用者判断などを別の経験recordとして残す範囲。
- Hostが観測したexecution evidenceをどの時点・粒度でdurableにし、canonical adoptionとどう相関するか。
- 当時のinstruction、skill、Agent Definition、tool contract、供給・観測したenvironment情報のうち、
  振り返りに必要な内容と、存在・発見・読込・modelへの投影をどう区別するか。
- 経験のcanonical domainをSessionまたはInstanceのどちらに置くか。個々のdatumは一方だけに属し、
  二重の正本にはしない。
- その物理保存先として既存のSession / Instance storeを拡張するか、経験専用storeを使うか。経験専用storeを
  使っても、それ自体をSession / Instanceとは別のcanonical domainにはしない。第三のcanonical domainが
  必要なら、このphase内で選ばずarchitectureへ戻って責務境界を決め直す。
- 何を自動的に保存し、何を人間の操作で明示的に残すか。
- Workerが読む経験を誰が選ぶか、どの時点でsnapshotにし、contextへどう投影するか。
- 長期間の経験をどう選択・圧縮するか。現checkpointを再利用するか、別の意味を持つ仕組みにするか。
- history/experienceのreadbackと改訂開始の入口を置くSurfaceを選ぶ。入口のexact actionとHost / Worker
  protocolはPhase 3で決める。
- cross-session経験にInstance-wide stateが必要なら、そのrevision、lock、persistenceをどう置くか。

完了のproduct証拠:

- Session Aで残した一つの経験を人間が確認でき、同じInstanceのSession BからWorkerが正確に参照できる。
- canonical conversation、non-canonical execution evidence、context attribution、context checkpoint、経験recordの
  関係をreadbackで区別できる。
- 経験の保存だけでは候補生成やrevision切替が始まらない。

### Phase 3 — 人間が開始するDefinition候補生成

対象機能: F20、F21

利用者が必要とする動作:

- 人間の明示的なアクションまたは指示でだけ、AIが保存経験を解釈してDefinition候補を作る。
- 候補は現行revisionを変えずに保存され、人間が内容、対象Instance、base revision、由来となる経験を
  readbackできる。
- 候補生成の失敗後も現行Definitionで通常利用を続けられる。

このphaseで決めること:

- Cycle 1の候補表現をcomplete source、diff、dataのどれにするか。
- AIへ渡す経験、current Definition、目的、人間の指示のexactな入力構成。
- 候補生成を担当するAgentComposition、必要なtool、model、maxSteps、turnとの関係。
- Phase 2で選んだSurface上で、人間の開始操作を表すexact actionとHost / Worker protocol messageを決める。
- candidate ID、base Definition revision、対象Instance、生成結果を保存するnon-active schema。
- 候補のsource/diff/dataと生成経緯を人間がreadbackするinterface。
- candidate生成がfile write等のeffectを使う場合、そのeffect evidenceと失敗時の状態をどう記録するか。
- provider/tool I/O placementを変更する具体的必要があるか。なければ現配置を維持する。

固定の採用評価matrixや定量scoreは導入しない。候補を見た人間が、自分の目的に照らして採用するかを判断
できればよい。

完了のproduct証拠:

- 人間の一回の指示からAIが一つのDefinition候補を生成し、non-active candidateとしてreadbackできる。
- candidate生成前後でInstanceのactive revisionと通常turnの挙動が変わらない。
- 人間のアクションまたは指示なしに候補生成が開始されない。

### Phase 4 — 人間承認による採用とrevision transition

対象機能: F18、F21、F22

利用者が必要とする動作:

- 人間が対象candidateを特定して採用アクションを行うか、提示されたcandidateを明示的に承認する。
- Hostは承認されたcandidateだけをimmutable Definition revisionとして確定し、Instance bindingを
  durableに切り替える。
- 次のadmit済みWorker generationは新revisionを使い、古いgenerationや未承認candidateはcommitできない。

このphaseで決めること:

- 人間に何を表示し、どのexact candidate/revisionへの採用・承認だと識別するHuman Gateにするか。
- 採用action、明示的承認、取消をSurfaceとprotocolでどう表すか。
- Phase 1で決めたcurrent/base revisionのidentity、保存、loadを基盤として、candidateをimmutable revisionへ
  確定するpromotion、dependency lineage、transition後のloader動作を決める。
- Instance binding transitionのatomic commitと、SessionのDefinition相関を更新する順序。
- active turnがある場合の採用可否、Worker close/restart、古いgenerationのfencing。
- 採用失敗時に旧bindingを維持する境界と、採用済み旧revisionへ人間が戻す操作を同じtransitionとして
  扱うか。
- revision transitionをexecution/evidence readbackへどう相関させるか。

完了のproduct証拠:

- 未承認candidateではactive revisionが変わらない。
- 人間が一つのcandidateを承認すると、Instanceのbindingが一度durableに切り替わる。
- Host再起動後の新Worker generationが承認済みrevisionを使い、旧generationはcommitできない。

### Phase 5 — 改訂後の通常利用とloop review

対象機能: F01、F19、F23

利用者が必要とする動作:

- 改訂後の同じInstanceで、普段と同じSurfaceから通常のtaskを完了できる。
- その利用で感じた変化、困難、有用な成功、違和感、判断を次の経験として残せる。
- 人間が次のloopへ進むか、同じphaseを直すか、roadmap・architecture・構想へ戻るかを判断できる。

このphaseで決めること:

- Cycle 1で改訂したDefinitionが通常利用へ現れたことを、どのrevision/session/execution readbackで確認するか。
- どの通常利用を行えば今回選んだ変更を人間が体験できるか。
- 次の経験として何を残すか。変更前後の統制比較や定量改善測定は要求しない。
- 観測された問題が実装、roadmap、architecture、構想のどこへ戻る問題か。
- Cycle 2で選ぶ一つの改訂対象。Cycle 1の成功だけから対象拡張を自動決定しない。

完了のproduct証拠:

- 人間が改訂済みHenjiで一つの実taskを完了し、使ったInstanceとDefinition revisionを確認できる。
- その経験が次のloopから参照可能である。
- 人間がCycle 1の結論と次に戻る層を決める。

### Cycle 1後に改訂対象を拡張する（F24）

Phase 5で得た経験を基に、人間が次のself-revision loopを開始すると決めた場合に扱う。Henji Instruction、任意の
managed Skill、context、tool、delegation、model profile、agent loop、runtime、Host / Worker連携、Surface data/code、
integration declaration等から、そのloopで必要な対象を一つ選ぶ。対象はこの一覧に限定しない。

選択時には、managed revision候補、すでに外部にあるinput/state、binaryに残すplatform authority、追加architecture
判断が必要な対象のどれかを先に分類する。そのうえでcontent、contract、exact dependency、activation authority、
scope、execution placement、lifecycle、durability、Session/evidence attributionを決める。共通envelopeへ格納できる
ことだけを外部化理由にしない。

native `AGENTS.md`/Skillはzero-install discoveryを維持し、managed SkillやHenji Instructionを追加しても置換しない。
MCPもnative protocol connection、credential、server、runtime capability、実行recordを分け、Henji managed installを
接続の前提にしない。MCP connection/server artifactのexact pinやtransportが必要になった場合だけ、Integration
resourceとして別incrementを採用する。

目的を変える必要があれば構想、責務・状態・lifetime・commit境界を変える必要があればarchitectureを先に
改訂し、その結果から対象機能と実装順序をroadmapへ追加する。Cycle 1の完了だけを理由に対象を自動的に
拡張しない。

## 構想・architectureの未決事項と判断phase

| 未決事項 | 判断するphase | Cycle 1での扱い |
| --- | --- | --- |
| 経験の具体的な残し方と読み方 | Phase 2 | 一つのInstanceをまたぐ最小のexperience flowだけ決める |
| execution evidenceのdurable write粒度 | Increment 41 | canonical adoptionと観測途中の物理保存を分け、現行の実送出経路とlatencyを確認してevent粒度を決める |
| `AgentContextGeneration`のidentityとAgent側基底設定の範囲 | F27の最初のincrement | canonical conversation、projection、execution中の動的inputまで一つのgenerationへ固定しない |
| `/rebuild`対象resourceとtransition semantics | F27の最初のincrement | Cycle 1のDefinition binding transitionへ自動的に統合せず、選んだresourceのauthorityに合わせる |
| 人間の候補生成アクション・指示のinterface | Phase 2–3 | Phase 2で入口を置くSurfaceを選び、Phase 3でexact actionとprotocolを決める。一般Surface APIは必要時だけ扱う |
| 人間の採用アクション・承認とHuman Gate | Phase 4 | exact candidateを人間が識別し承認できる最小経路を決める |
| provider/tool物理I/Oのplacement | Phase 3で必要性を確認 | 具体的理由がなければ現在のWorker内配置を維持し、永久決定にはしない |
| Worker protocolのmessage、handshake、error、versioning | Phase 1–4の採用機能ごと | 各phaseに必要なmessageとfailure semanticsだけ追加する |
| Compositionをgeneration単位またはturn単位で構築するか | Phase 1 | Cycle 1で実行中再構成を必要としなければ現行generation単位を維持する |
| Definition identity、dependency lineage、load、rollout | Increment 32〜34、Phase 1、Phase 4 | Increment 32で共通identity/cutover、33でlocal closureのinstall/load、34でtransportを成立させ、Phase 1でcurrent/base binding、Phase 4でcandidate promotionとbinding transitionを決める |
| Worker restart、cancel、concurrency、lease、backpressure | Phase 1と4 | Instance writerとrevision transitionに実際に必要なsemanticsだけ決める |
| cross-session memory / Instance-wide state | Phase 2 | 経験のcanonical domainに必要な場合だけ採用する |
| mailbox、routing、schedule | 後続loopで採用時 | Cycle 1には含めない |
| effectのidempotency、deduplication、recovery | Phase 3–4で実effectを選んだ場合 | 使用するcandidate/adoption effectの契約に合わせる。一般解は作らない |
| deployment、service supervision、migration | Phase 1と、C04を採用する後続loop | Phase 1でHostの実行先、起動主体、durable stateからの再開を決める。外部deliveryのための常時稼働保証、service supervision、常時到達性はC04採用時に決める |
| Definition以外の改訂対象 | Phase 5の次loop判断 | 通常利用の経験から一つずつ選ぶ |
