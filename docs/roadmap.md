# Henji 機能インベントリと反復型実装ロードマップ

ステータス: **採用済み — roadmapであり、各phaseの実装認可ではない**

作成日: 2026-09-06

実装状況の初回照合基準commit: `29c84cf17063da3565672ce4a37cdbf76334995e`

現行source照合commit: `63da37ced134920966f59e8b1948777b1c1c3eb6`（2026-09-26）

## 目的と正本

この文書は、次の正本から導かれる機能を列挙し、現行production経路の実装状況、Host / Worker
architectureとの対応、未実装機能の実装順序、各phaseで必要になる判断を一か所にまとめる。

- 構想: [`concepts/experience-driven-self-revision.md`](concepts/experience-driven-self-revision.md)
- architecture: [`architecture/henji-host-agent-worker.md`](architecture/henji-host-agent-worker.md)
- active sourceとcommand authority: [`../v0/`](../v0/)、[`../deno.v0.json`](../deno.v0.json)

初回照合commitはこの文書を作成したときの照合時点を示す。その後の変更を含む現コードの実装状況はactive
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
実装問題なら同じincrement内で直す。戻った結果、このroadmapの後続案は変更または破棄できる。

各loopの完了はHenji全体の完成を意味しない。人間が通常利用の経験から改訂を指示し、Henji自身が一部incrementの
実装を担う運用は始まっている。Agent自身の経験解釈・候補生成や、専用product flowの一巡まで実証済みとは
一括して扱わない。自己改訂を支える次の増分は、Agent自身の観測・振り返り、実行構成の選択、変更の反映に
不足する具体的な動作から選ぶ。

これまでの基盤整備では、repositoryと導入済みDenoへ依存しないstandalone executableと、Agent Definitionの実行可能なmodule closureを
immutable revisionとして保持・解決する基盤を通常利用で成立させ、別installationへ同じrevisionを移送できる
ところまでをIncrement 32〜34で段階的に扱った。Definition以外の最初の追加resourceとして、Increment 51で
Henji共通base instructionをmanaged revisionとして導入し（Increment 103でbuilt-in最小core＋user
`instruction.md`直接読み込みへ置換）、Worker-core合成とexecution attributionを追加した。
instructions、skills、context、tool、delegation、model、agent loop、runtime、Host / Worker連携、
Surfaceへの対象拡張は、通常利用の経験を受けて後続loopで一つずつ選ぶ。`AGENTS.md`と`SKILL.md`のnative
discoveryはmanaged installへ置き換えず、Henji独自Instructionや任意のmanaged Skillとは別authorityにする。
これらは利用できる基盤であり、durable InstanceやDefinition専用candidate管理を追加することを自己改訂の
開始条件にはしない。最初の対象をDefinitionに限定せず、観測・構成操作・改訂反映の手段自体も対象にできる。
各機能の方向付けは、その個別incrementの実装認可を意味しない。

通常利用で得た新しい構想として、canonical conversationだけでなくnon-canonical execution evidenceと、その
executionに関与したAgent側の状態を人間が振り返れるdurable historyを必要機能へ加える。改訂されたresourceを
後続実行へ適用する`/rebuild`相当の操作も必要機能の候補として管理する。durable historyにはSQLiteを採用し、
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
| F01 | 人間が外部文書やhelpを先に読まずHenjiへ依頼し、進捗と結果を理解して通常利用を続けられる。配布後はrepositoryや導入済みDenoへの固定参照なしに、任意のworkspaceから同じproduction経路を利用できる | 改訂前後の経験を生む通常利用。SurfaceはHostが所有し、実利用で改善する | **部分実装**。production TUIと非対話commandがあり、依頼・進捗・結果を表示できる。非対話commandはHost側のheadless SurfaceとしてTUIと同じWorker経路を一turn使い、既定はfinal-only stdoutまたはfailure JSON、`--json`はcurated NDJSON event stream、`--stream`はlive assistant textを返す（Increment 104）。TUIはturnとuser/output境界、入力前後を空行で分け、busy（表示は`working`）lifecycle開始から毎秒進む経過時間とspinnerを含む一時statusとcwd・Session短縮ID・Session titleを二行目、root provider・model・effortを三行目に持つ三行footerへ表示し、`user>`、settledした`assistant>`、`tool>`、`system>`のlabelをblue/yellow/green/magentaで識別する。選択中root providerのcredential fileが存在しなければrequest前からfooter第一行へ表示し、editor先頭の`/`に一致するbuilt-in slash command候補を`ready`または`working`の直後へ逐次表示する。候補が1件ならTabで完全なcommand名へ補完し、複数候補では入力を変えない。recoverable taskはeditorを変更せず停止理由と入力履歴（Up）での再送を案内する。idle Ctrl-Cは入力をclearしてreadyを保つ。F1 keyと`/help`のhelp overlayは残るが、compact startupに固定help hintは表示しない。Increment 32でstandalone executableが成立し、現在のinstalled launcherはrepository checkoutやPATH上のDenoを参照せず任意のworkspaceから起動できる。実行中もPageUp／PageDownで会話履歴を参照でき、履歴表示中のfooterは`PgDn latest`／`Esc cancel`を示す（Increment 128）。履歴位置は`history record N of M`または`history start`（Increment 130）。assistant本文とthinkingはlive snapshotで追従し、thinkingはmodel stepごとに置換して確定する（Increment 132 A／B）。Increment 133でprocess所有と端末分離を実装し、隔離XDGのsource／compiled TUI経路で確認した。常用利用での入力欠落解消は継続観測とし、Increment 132 Cの長時間入力・履歴移動遅延は未再現・未完了である |
| F02 | 構成済みのsystem instructionを含むprovider/model requestを実行し、複数step、tool call/resultを進めるagent turn | AgentCompositionとturn semanticsはWorkerが所有する。F02はF06で構成済みの入力を各model requestへ渡し、tool call/result loopを実行する | **実装済み**。production TUIと非対話commandの共通Worker経路にprovider/model request、複数step、tool call/resultがある。標準root turnは最大128 model stepsで、TUI・`henji run`は起動時の`--max-steps N`でrootの上限を上書きできる。TUIは`openrouter-chat`を既定に保ちつつ、起動時の`--root-provider <provider-id>`またはidle時の`/provider`で同梱4 routeとexternal宣言providerへ切り替えられる。`/model`と`/effort`はactive providerのeffective catalogを使い、同一Session内のselectionとして保存する。一turnのtool loop中は選択を固定する。外部の名前付きAgentは同梱の名前別model既定を持たず、通常のroot selection経路を使う。TUI・`henji run`起動時の`--provider-timeout-ms`は、未指定時300,000 msのrequest単位deadlineを同じWorker invocationのroot、async child、context compactionへ適用する。deadline到達はresponse不正と区別して表示し、自動retryまたはmodel fallbackはしない。`skill` toolの結果はtranscriptへ入り、次のmodel stepから参照される。`read`はcomplete-lineの`offset`・`limit` windowを返し、default parentの`bash`は切り捨てたstdout/stderrを`bash_output`で保存上限まで継続取得できる。default parentの`web_search`はroot providerと独立したOpenRouter Sonarを一回呼び、検索結果に限定した回答のlocal citationを直接source linkへ正規化して次のmodel stepへ渡す。追加model requestは親budgetとcountへ含み、provider/API/model identity、HTTP status、解析失敗の項目と値の形を短いrequest factへ保持する。increment 9のcitation正規化はproduction retained TUIで受入済み。OpenRouter Responses route、data-only Provider declaration、built-in ID整列はIncrement 58〜68で実装済みである。Increment 101でauth profileをpattern一般化し、新しいprovider IDの宣言がoptional `headers`（`{credential}`／`{sessionId}`）を持てるようにした。OpenCode Go（`opencode-go-chat`／`opencode-go-responses`）はexternal宣言で追加する |
| F03 | workspaceの`AGENTS.md`とworkspace/user scopeの`SKILL.md`をnative規約でzero-install discoveryし、実行中に共有するsnapshot/catalogを作る | 他harnessと共有するfile format、配置、discovery、activationをHenji独自managed resourceで置換しない。managed SkillとHenji base instructionは追加authorityとして分離する | **部分実装**。Worker generationの起動時にworkspace rootのinstructionと、workspace配下およびuser scope（`$ZOT_HOME`または`$XDG_STATE_HOME/zot`、`~/.claude`、`~/.agents`）の`.zot/skills`、`.claude/skills`、`.agents/skills`を一度読み、実行中に共有するimmutableなinstruction snapshotとskill catalogを構築する。tool call時には再読せず、`skill` toolの結果はF02のtranscriptへ入る。Increment 51でnative入力とは別authorityのHenji base instructionを追加した。Increment 103でbuilt-inを最小core（役割identityとcredential/Authorization境界）へ縮小し、外部contentを`$XDG_CONFIG_HOME/henji-harness/instruction.md`の直接読み込みへ変更した。managed Skill revisionと改訂候補の生成・採用は未実装である |
| F04 | canonical conversation、non-canonical execution evidence、context attributionを再起動後も区別して利用する。通常semantic historyに短いrequest factを含める | Hostがsemantic authorityのdurable storageとcanonical採用を所有し、Workerがconversation/contextの意味を所有する。物理的なstorage commitとcanonical adoptionを分ける | **実装済み**。Increment 40〜44でworkspace-local SQLiteを唯一のproduction history正本とし、Increment 94でproductionをhistory v7へ破壊的に切り替えた。Increment 121でraw診断attachmentを廃止し、短いrequest factをsemantic authorityへ統合した。v10 schemaは通常pathで新規deltaだけを処理し、旧DB migration、dual-read/write、fallbackは持たない |
| F05 | 人間が保存済みSessionのcanonical/non-canonical semantic historyとcontext attribution、短いrequest factを通常利用中に参照する | 経験を人間が確認し、診断、`/recall`、後の改訂指示へ使うSurface機能。history rendererとmodel projectionを分ける | **部分実装**。TUIのPageUpと別プロセスの`henji history` CLI（`session`／`canonical`／`detail`、read-only、stdout）を使う。Increment 117で未使用の永続化human history投影を削除し、CLIは元の記録から直接出力する。Increment 120で失敗・cancelのthinkingも通常履歴へ含めた。Increment 121で短いrequest factを`detail`と`/recall`から参照できる。Increment 129でツール呼び出しに添えたassistant本文（`assistant note>`）を対応tool行の前に保持し、TUI・session再開表示・`henji history --view session`で時系列に読めるようにした。保存Sessionの失敗行は赤色で表示し、recall可能なExecution IDと`/recall <id>`を案内する（Increment 122／125）。通常履歴のthinkingはmodel stepごとに一つのentryとして確定する（Increment 132 B）。検索は出力をviewer（`vi`／`glow`／`less`）で行い、product組み込みのliteral検索は持たない |

### AgentCompositionと現在のHost / Worker runtime

| ID | 必要な機能 | architecture上の責務・境界 | 現コードの状態 |
| --- | --- | --- | --- |
| F06 | executable TypeScriptのAgentDefinitionがprovider、model、effort、loop、tools、context、instruction、skillをAgentCompositionへ合成する。外部DefinitionはHenjiが管理するmodule identityとrevisionから選べる | Definition moduleの取込・保存・解決・readbackはHost、Definition評価とcomposition実行はWorker。F03のinstruction snapshot本文とskill catalogのmanifestをsystem instructionへ合成し、skill本文を取得する`skill` toolをregistryへ組み込む | **部分実装**。binaryにはbuilt-in `default`と`generic`を同梱し、外部Definitionをmanaged revisionとして選択できる。現Definitionはmodel、registry/tools、maxSteps、system instruction等を選べ、built-inのmaxSteps既定値は128である。TUIのsession-level model/effort overrideはDefinition revisionを変えず、Workerが返されたroot compositionのmodel routeだけへ反映する。同期subagentはIncrement 106で廃止した（`subagent:<name>` slotと`delegate_to_*`を削除）。child／subagentはDefinitionの固定roleではなくExecution間の親子関係として扱う。Increment 109で`agent:<name>` async catalog、`spawn_subagent`／`subagent_status`／`collect_subagent`／`cancel_subagent`、別Deno Worker・別ExecutionのV1 fork/joinを実装した。Increment 110でmanaged child Definitionとtool bindingのexact authority、durable admission／terminal、parent-execution-scoped addressability、parent cleanup後のcommit fenceをproduction経路へ収束させた。child resultはcollectのtool resultとしてのみ親contextへ入り、child executionはcanonical Sessionへ採用せずnoncanonical execution evidenceとして残す。組み込みdefaultは常時利用可能な`agent:generic`と設定済み`agent:<name>`のcatalogを宣言する。reviewerやplannerは通常の外部Definitionとしてbindできる。Increment 131で`spawn_subagent(agent, task, model?, tools?)`の起動時model指定と宣言済みtoolの絞り込みを実装した。model省略時は親Sessionの現在selectionを使う。`agent:generic`はinstall／bindingなしでspawnできる。選択済みtoolはmanaged resource kind `tool-definition`から供給する。Hostは`$XDG_CONFIG_HOME/henji-harness/tools.json`のactivation binding > bundled tool Definitionの順で`tool:<name>`ごとにexact revisionを解決し、WorkerがDefinition moduleを評価してmaterializeする。bundled tool Definitionは`bash`／`bash_output`／`edit`／`read`／`write`／`web_search`／`web_fetch`を既定供給し、固定`ToolComponentCatalog`／`workToolNames`と`AgentCompositionOptions.toolComponents`の同一identity置換seamは削除した。tool宣言は各Agent Definitionがownerで、`additionalTools`で追加identityを宣言できる。差し替えはinstall/bind単位で決まり、runtimeのbackend選択UIは持たず、各外部Agentは自分の宣言に従う。Increment 51以降、Definitionのinstructionはrole、active tool guideline、workspace instruction、skill manifest、runtime facts（cwdのみ）からなるbase抜きのcontributionである。Hostが解決したbuilt-in coreまたはuser fileの`instruction:henji-base`をWorker-core mandatory finalizerが先頭へ一度だけ加え、rootとasync childへ同じselected baseを適用する。Definitionがcore-owned base slotを宣言した場合は実行前に拒否する。defaultと外部Agentはmaterialize済みregistryから自分が持つtoolのguidelineだけを受け、OpenRouter/OpenAI adapterには同じfinal本文をprovider固有fieldへ写像する。skill本文は一括注入せず、modelが`skill` toolを呼んだ場合だけtool resultとして渡す。Increment 101で`authProfile`を非secret identityとしてpattern一般化し、credentialを`<XDG_CONFIG_HOME>/henji-harness/<authProfile>`から解決する。新しいprovider IDのdeclarationはoptional `headers`を持ち、`{credential}`（Chat経路のみ）と`{sessionId}`をrequest時に置換する。loopとcontext/compactionは`WorkerGeneration`の固定実装である |
| F07 | Worker起動前にDefinitionの実行可能なmodule closureまたは同等の自己完結bundleをimmutable revisionとして参照する | Hostがentryと実行に必要なlocal dependencyをmanaged storeへ固定して`DefinitionRevisionRef`を確定し、Workerがstore内の確定revisionだけを解決・評価する | **部分実装**。Increment 32〜34でlogical `DefinitionRevisionRef`、local module closureのmanaged store、canonical digest、exact revisionからのWorker load、transportを成立させた。Sessionはlogical refを保存し、Workerはmanaged store内の確定closureから依存を解決する。Increment 77でbuilt-in Definition/toolのrevisionを、binary同梱ランタイム全体のhashではなくresourceのclosure内容とcontractから算出し、build manifestへ埋め込むようにした。初期contractはstatic relative `.ts` import/exportとembedded `@henji/agent`だけで、remote/JSR/npm dependency、computed dynamic import、transitive dependency binding、revisionのremove/GCは未実装 |
| F08 | 評価後の構成をdata-onlyなAgentManifestとして説明し、executionから使用したAgent側の基底設定をreadbackできる | Workerがprojectionを返し、Hostはidentity/admission authorityや実際のmodel input全体と混同しない | **部分実装**。role、maxSteps、実際のroot provider/model/effort、childの実行model、profile、effective model resource IDsをexecution artifactに残す。Definition/build attributionに加え、instruction component、読み込んだskill、tool contract、runtime factとmodel requestのexact context attributionがある。Increment 51ではselected Henji baseのexact ref、selection source、content digest、exact textとfinal system instruction内のbyte projectionをmanifest・history・provider requestへ相関した（Increment 103でsourceはbuilt-in coreまたはuser `instruction.md`）。完全なAgentCompositionの再構築や全外部状態の再現は行わない |
| F09 | built-inとexternal Definitionを同じDeno Web Worker capsuleで実行する | Web Workerはlifecycle/data境界であり別trust tierではない | **実装済み**。TUIと非対話commandが同じsession factoryを入口に、同じloader、bootstrap、runtime、protocol、commit経路を使用する |
| F10 | UIをWorkerから分離し、Host側の交換可能なSurfaceとして扱う | terminal / Surface I/O、layout、draft、cursor、viewportはHost、Workerはheadless | **部分実装**。data-only presentation contract、Host-owned TUI adapter、terminal lifecycle分離があり、turn/input境界、三行footer、viewport復帰、plain assistant本文renderer、conversation label style、history export operation、headless CLIのcurated NDJSON／live text出力（Increment 104）もHost-localに実装する。Surfaceを選択・load・置換する一般product interfaceはない |
| F11 | HostがWorker generationを起動、停止、監視、置換する | Worker generationのlifecycle ownerはHost | **実装済み（現行generation経路）**。起動、cooperative close、cancel、terminate、settlementがある。Increment 91で同一Session・同一revisionにおけるforced-cancel後のgeneration置換を追加した。Increment 110でparent settle／cancel／close／replacementがchildのterminal確定、durable settlement、Worker terminationへjoinするlifecycleを実装した。Increment 133でprocessの物理ownerをHostへ移し、制御端末を継承しない共通executorと、正常return後のbackground groupも含むgeneration単位の所有を実装した。cancel／forced termination／replacement／closeは資源の清算へjoinし、WorkerのRegistryは出力storeを明示closeする。durable Instanceによる継続管理はF16を採用する場合の追加範囲であり、現行Sessionの再開・generation置換とは分ける |
| F12 | Host / Worker間でdata-only command、event、effect、proposal、ackを交換する | 関数は境界を越えず、protocolがapplication semanticsを運ぶ | **実装済み（現在のslice）**。TUIとone-shot headless CLIの両方がstart/turn/proposal/commit/ack/closeを使い、TUIにはsteer/cancel/checkpointとidle時のprovider/model selection/ackもある。Increment 133でWorker-local process proxyからHost共通executorへのdata-only request／responseを追加した。将来機能のmessage、handshake、version migrationは未決 |
| F13 | WorkerのproposalをHostが検証・永続化し、durable write後だけcommittedとする | durable Session storeがcanonical。Worker stateはephemeral | **実装済み**。base state revision、transcript、next turn、Definition bindingを検証してcommit/ackする |
| F14 | Session/execution、Definition revision、generation、base state revisionを相関し、admit済みwriterだけをcommitできる | Hostのadmissionとrevision fencing。durable Instanceを採用する場合はそのidentityも追加する | **実装済み（Session/execution単位）**。Session、ephemeral instance correlation、generation、base state revision、Definition refを相関して検証する。durable Instanceの永続identityとSession横断writer管理はF16/F17の追加範囲 |
| F15 | tool effectとstate commitを区別し、不明なeffectを自動replayしない | Workerはeffect evidenceを返し、Hostはsettlementを記録する | **実装済み（現在のtool経路）**。tool event、execution artifact、`automaticReplay: false`、`effectCommitRelation: not_transactional`がある |

F02、F03、F06の境界は次のとおりである。F03がWorker generation起動時にnative instruction snapshotとskill
catalogを作り、HostがHenji base instruction（built-in coreまたは`$XDG_CONFIG_HOME/henji-harness/instruction.md`）を
解決する。F06はWorker-core
finalizerでselected baseをDefinition-owned contributionの先頭へ合成し、native instruction本文とskill manifestも
system instructionへ合成するとともに`skill` toolを
registryへ組み込む。F02は、そのsystem instructionを各model requestへ渡し、modelが`skill` toolを呼んだ
場合は、起動時のcatalogに保存した該当skill本文をtool resultとしてtranscriptへ加え、次のmodel stepへ渡す。
したがって、skill一覧は最初のmodel requestから見えるが、skill本文は最初から一括してmodelへ渡されない。
これはnative discovery経路の責務である。Henji base instructionはこのzero-install入力を置換せず、
一つのcore-owned `instruction:henji-base` slotとしてその前段へ加わる。managed Skill revisionは未実装であり、
採用時にkind固有のselection authorityと合成順を決める。

### 現在のSurface実装であるproduction TUI

F番号はcomponentではなく、利用者が必要とするproduct機能に付ける。production TUIはF01の通常対話、
F05のSession/history/context参照、F10のHost-owned Surfaceを横断して実現する現在のSurfaceであるため、
TUI自体には独立したF番号を付けない。現在のproduction TUIには、次の実装がある。

- turnとuser/outputの表示専用境界を持ち、`user>`、settledした`assistant>`、`tool>`、`system>`のlabelを
  blue/yellow/green/magentaで識別するconversation log、前後を空行で分けた複数行入力欄、一時status行、
  cwd・Session短縮ID・Session titleの行、root provider・model・effortの行からなる三行footer。
- request/evidence metadataやraw tool resultを常時展開せず、assistantと短いtool activityを追える表示。
- ready / working（busy lifecycle） / cancelling / failure、working開始から毎秒進む経過時間とspinner、history位置、pending input、操作結果の
  一時表示と、ASCII・日本語・wrapを含むcursor位置。
- alternate screenによる現在Sessionの隔離、PageUp / PageDownによるviewport移動、過去表示中の位置と
  `history record N of M`または`history start`表示、idle時の`Esc latest`、busy時の`PgDn latest`／`Esc cancel`、
  PageDown末尾到達・idle Esc・通常task admissionによる最新追尾への復帰、終了時のterminal復元。
- 過去表示中のdraft保持、boundedな入力履歴、更新日時・手動title・短縮ID・turn数を二行表示するSession選択、
  `/rename <title>`によるcurrent Sessionの命名、`/help`・`/new`・`/sessions`・`/provider`・`/model`・`/effort`・
  `/recall`・`/exit`、readline編集、一意なslash command候補のTab補完、Tabによるworkspace-relative path補完、Alt+Returnによる改行。
  履歴参照はメインlogのPageUpと、別プロセスの`henji history` CLI（`session`／`canonical`／`detail`、read-only、stdout）で行う。
- assistant本文とthinkingのlive snapshot表示、stepごとに一つに確定するthinking entry、赤い失敗行とrecall可能な
  Execution ID・`/recall <id>`案内（Increment 122／125／132 A・B）。
- plain textを既定とするHost-local assistant本文renderer。terminal styleは最終frameだけに加え、layout、
  Presentation event、canonical transcriptへ混入させない。
- working中の一回のsteeringとfollow-up、cancel、uncommitted inputの固定lane、recoverable taskの停止理由表示、
  idle Ctrl-Cによるdraft clear。

現行sourceでは、旧Ctrl-G / Ctrl-T / Ctrl-Lの機能入口を除去し、Ctrl-Kをreadlineの行末削除としている。
保存済みcausal historyとcontextの内部projection・controller処理は残るが、現在の人間向け入口はない。
modified ReturnのdecoderはShift / Alt / Ctrl sequenceを改行として処理するが、各terminalがどのsequenceを
送るかはactive sourceが規定するproduct動作ではない。

この実装状況は、`v0/tui/input.ts`、`v0/tui/state.ts`、`v0/tui/layout.ts`、`v0/tui/render.ts`、
`v0/tui/controller.ts`、`v0/tui/terminal.ts`、`v0/tui/pending_input.ts`、`v0/tui/file_reference.ts`、
`v0/agent/cli/tui_cli.ts`、`v0/presentation/tui_presentation_adapter.ts`と照合した。

### durable AgentInstanceとrevision transition

F16/F17（durable AgentInstance、Instance単位writer ownership）は、複数Sessionを共通のidentity・active binding・
writerで束ねる具体的な必要が生じた場合に採用する。自己改訂を始める必須条件にはしない。
保存Sessionを現行Definitionで継続し、切替を記録するF18の範囲はIncrement 76で実装済みである。
Instance単位のbinding transitionはF16/F17を採用する場合の追加範囲とし、candidate採用との接続はF22で扱う。

| ID | 必要な機能 | architecture上の責務・境界 | 現コードの状態 |
| --- | --- | --- | --- |
| F16 | Worker generationより長く存続するdurable AgentInstanceを持つ | resident Hostがdurable lifecycle ownerとなり、stable identity、metadata、active Definition bindingを所有する | **未実装**。現`instanceCorrelation`は`WorkerHostSession`ごとに生成され、永続化されない |
| F17 | durable Instanceを採用する場合に、対象Sessionの所属とInstance単位のwriter・inputを管理する | 対象Sessionは一Instanceに属し、同一Instanceのwriter generationは同時に一つ | **未実装**。現行Sessionはworkspace、agent、Definitionに結び付くがdurable Instance IDを持たない。現在のSession単位の継続・writer管理は自己改訂に利用できる |
| F18 | 使用するDefinition revisionを人間の判断に従って切り替え、後続実行と過去の由来を区別する | Hostが選択とtransitionを記録する。durable Instanceを採用する場合はInstance単位bindingも所有する | **実装済み（Session継続時の切替）**。保存Sessionを現行Definitionで継続する切替（human起点・記録付き、Increment 76）は実装済み。Instance単位bindingの切替は採用時の追加範囲として未実装であり、候補採用との接続はF22で扱う |

### 経験駆動の改訂ループ

人間主導でHenji自身が一部incrementの実装を担う現在の運用と、Agent自身が経験を読み、変更候補・採用・適用を
相関して扱うproduct flowの整備状況を分ける。以下の「専用flow未実装」は運用上の改訂が未開始という意味ではなく、
専用candidate schemaや一式の管理機能を先に作る要求でもない。個々の成立範囲は採用incrementに記録する。

| ID | 必要な機能 | 構想・architecture上の責務 | 現コードの状態 |
| --- | --- | --- | --- |
| F19 | 通常利用の困難、成功、違和感、目的、利用者判断を、後のWorkerが必要に応じてSessionをまたいで読む経験として残す | Hostがdurable semantic historyとreadback、Workerが経験の意味と選択を所有する。durable Instanceや新しいstoreを前提にしない | **部分実装**。canonical/non-canonical履歴、checkpoint、`/recall`、context attributionと短いrequest factはある。保存Sessionとrepository上の通常利用メモ・increment文書も現在の改訂運用に使う。Agentが対象経験を発見・選択し、目的・理由やused／missing／unused assessmentへ結び付ける操作は未整備。自身の観測操作はF28で扱う |
| F20 | 人間の明示的なアクションまたは指示を契機に、Worker内AIが経験を解釈して対象機能の変更候補を作る | 経験の解釈と候補生成はWorker。最初の対象をDefinitionに限定せず、人間の契機なしに自発生成しない | **未実装（専用flow）**。Henjiが一部incrementの実装に関与する運用は開始済み。個々の実行で経験解釈・改善案形成まで担った範囲は別途記録し、file編集能力だけから候補生成flow全体を実証済みとはしない |
| F21 | 変更候補を現在の採用・実効状態と区別し、人間が内容と由来をreadbackできる | 対象に応じてsource/diff/data、由来と採用状態を相関する。全resource共通のcandidate schemaは前提にしない | **未実装（専用flow）**。repositoryの差分や個別increment文書を使う現在の運用はあるが、経験・候補・採用状態を相関して扱うproduct操作は未整備 |
| F22 | 人間の採用アクションまたは明示的承認に基づき、対象機能の変更を後続実行へ反映する | 人間が定めた目的・改訂範囲・採用境界に従い、人間またはAgentが適用を要求する。Hostは対象の状態適用を所有する。managed promotionとInstance bindingは採用する対象に応じた方式 | **未実装（専用flow）**。人間の指示による実装・採用と改訂後の通常利用は運用としてある。専用の候補採用と適用操作の接続は未整備。resource再構築はF27、Agentのroot model操作はF29として分けて扱い、操作ごとの承認を一律に追加しない |
| F23 | 改訂後のHenjiで通常利用へ戻り、そこで得た変化を次の経験にする | 改訂の循環を育てる動作。統制実験や定量測定は必須ではない | **部分実装（運用）**。人間が経験から指示し、Henji自身が一部incrementを実装し、改訂後のHenjiを通常利用する運用は始まっている。Agent自身の観測・経験解釈・候補生成・適用を一続きに扱うproduct flow全体は未実証 |
| F24 | 経験に応じてDefinition以外のresourceも改訂対象にできる | managed revision候補、native external input/state、binary platform authority、追加architecture判断が必要な対象を区別する。対象kindごとにcontent、contract、dependency、activation、scope、execution placement、lifecycle、durability、evidenceをarchitectureへ反映してから実装する | **未実装（専用flow）**。改訂対象をDefinition以外へ広げる方向は現在の構想に含み、Definitionだけの一巡完了を待たない。Increment 51でHenji base instructionを追加し、Increment 103でbuilt-in最小core＋user `instruction.md`直接読み込みへ置換したが、経験からのcandidate生成・比較・採用cycleではない。今後の候補には任意のmanaged Skill、tool、model profile、Surface data/code、integration declaration、context/compaction、provider adapter、loop、storage等がある。subagent Definitionのactivation slotはIncrement 65で導入しIncrement 72で一般化したが、Increment A（同期subagent廃止）で廃止した。child／subagentはDefinition roleではなくExecution間の親子関係として扱う。tool DefinitionはIncrement 69でmanaged resource kind `tool-definition`（install／`tools.json` activation binding／exact ref attribution）として成立し、`web_search`を最初の適用例とした。Provider設定の外部化とOpenRouter Responses routeはIncrement 58〜68で通常利用機能として成立したが、経験からのcandidate生成・比較・採用cycleではない。native `AGENTS.md`/Skill discoveryやMCP connectionをmanaged installへ置換しない |
| F25 | exact managed resource revisionをinstallation間でtransportする | export packageはstore layoutと分離し、manifestとcontent closureを運ぶ。credential、Session、workspace、binary、active bindingを混入させず、import先がidentity、contract、digestを検証してlocal custodyへpublishする | **部分実装**。Agent Definitionのexact revisionをexport/importする経路はIncrement 34で実装済み。他resource kindへのtransport一般化は未実装である。他resourceのlocal managed化はtransportを必須前提にしない |

### Durable historyとcontext適用

| ID | 必要な機能 | architecture上の責務・境界 | 現コードの状態 |
| --- | --- | --- | --- |
| F26 | 人間がsettled non-canonical executionを選び、その保存内容を次の一つのtaskへ明示的に投影する | Hostがsource選択、次taskへの一回のprojection、source/target attributionを所有する。sourceをcanonical化、resume、自動retryしない | **実装済み**。Increment 38の`/recall`がcurrent Sessionのexecutionを選び、次task内のmodel requestへdata-only contextを渡す。sourceはnon-canonicalのままで、targetだけが通常のatomic commit対象になる |
| F27 | 人間またはAgentが`/rebuild`相当の操作を要求し、対象resourceから実効構成を再構築して後続実行へ適用する | Hostが解決・状態適用とtransitionを所有し、Workerが要求・composition構築を担う。人間の改訂採用境界と過去attributionを維持する | **未実装**。新Session、`/new`、reopen、再起動では現在のbase instructionを取り込むが、conversationやdraftを保持するrebuild操作はない。最初の対象resource、要求元taskの継続、適用境界と引継ぎは採用incrementで定める。Definitionとtoolも対象候補。binaryの再compile・配置とは同一操作と決めない |
| F28 | Agentが自分の対象execution・実効構成を発見し、必要な履歴を選んで観測・振り返る | Hostは既存semantic authorityとattributionをreadbackし、Workerは目的に沿って材料を選び解釈する。人間向けrendererとAgent向けreadbackを分ける | **部分実装（材料・間接参照）**。会話・tool resultと、bashによるhistory CLI等の参照は可能。人間向けTUI/historyも充実している。自身のexecution・構成を発見して必要な材料を取得するproduct操作は未整備。raw常設収集、durable Instance、専用experience storeを前提にしない |
| F29 | Agentが`/model`相当の操作を要求し、後続のroot実行に使うmodel・effortを選べる | Workerが選択を要求し、HostがSession selectionと適用結果を所有する。人間の目的・採用境界内で操作する | **未実装（root操作）**。人間のidle時`/model`・`/effort`は実装済み。子実行はIncrement 131のgeneric／名前付きchildのspawn時model指定で選べる。rootのAgent向け操作、適用時点と保存scopeは採用incrementで定める |

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
| C04 | 常にaddress可能なagent operationとdelivery | 採用するHost lifecycle ownerへ、外部からの常時到達性、delivery、継続稼働とそのservice supervisorを加える。Worker常駐は不要 |
| C05 | 一般的なInstance-wide mutable state | HostがInstance revision、lock、persistenceを所有し、Sessionとの二重正本を避ける |

## 機能一覧と主なarchitecture領域の対比

一つの機能が複数領域に関わる場合があるため、この表は各F番号の主な対応先を引く索引であり、網羅的な
責務表ではない。

| architecture領域 | 対応する機能 |
| --- | --- |
| Surface / human interaction | F01、F05、F10、F20〜F23、F25〜F27 |
| HenjiHost lifecycle | F07、F11、F14、F16〜F18、F25〜F29 |
| Host storage | F04、F13、F15〜F19、F21〜F23、F25〜F29 |
| Agent Worker | F02、F03、F06、F08、F09、F12、F19、F20、F26〜F29 |
| commit / revision boundary | F07、F13〜F15、F18、F21、F22、F25〜F29 |

F24のarchitecture領域は固定しない。次のself-revision loopで選んだ改訂対象に応じて、Agent Worker、Host、
storage、Surface、またはそれらの境界のどこへ対応させるかを決める。

現在のprovider HTTPはWorker内で構築される。processの物理ownerはHostで、Workerのtoolはdata-only proxyから
共通executorを利用する（Increment 133）。tool結果とRegistry出力storeの意味はWorkerが所有する。このplacementを将来も固定する
決定にはしていない。最初のloopで変更する具体的理由がなければ現配置を保ち、別の境界を設計しない。

## 反復型実装ロードマップ

| 分類 | 対応する機能 | 詳細 |
| --- | --- | --- |
| 通常利用と改善 | F01〜F15、F26、F27 | 通常利用で見つかった問題を改善する。F26はIncrement 38で実装済み。F04/F05/F08/F11/F15はIncrement 40〜43のdurable history programで拡張し、Increment 44でSQLiteを唯一のproduction history経路に統一した。F27は別計画で判断する |
| 配布とDefinition revisionの前段基盤 | F01、F03、F04、F06、F07、F09、F25 | **実装済み（前段基盤）**。Increment 32〜34でstandalone executable、native discovery、local managed Agent Definition、Definition transportを順に成立させた。各F全体の残件は機能一覧を参照する |
| Henji base instruction | F03、F06、F08 | Increment 51でbase instructionを追加し、Increment 103でbuilt-inを最小core化して外部`instruction.md`の直接読み込みへ置換した |
| Provider外部化とOpenRouter Responses API | F02、F06、F24 | **実装済み**。Increment 58でOpenRouter Responses、59/60でdata-only宣言とoverride、61でprovider identity一般化、62でreplay scope、63で既定selection外部化とbuilt-in catalog/defaults override、64でcurated catalog移行、65でactivation-level slot bindingとplanner既定のdata化、66/67で通常利用上のprovider pickerとResponses effortを修正、68でbuilt-in provider IDを整列した。69でmanaged resource kind `tool-definition`を導入し`web_search`(Sonar)をbundled tool Definitionへ移設・固定catalogを削除、70でtool宣言のDefinition統一と追加identityの一般化（`web_fetch`）、71で`bash`／`read`／`write`／`edit`／`bash_output`をbundled tool Definitionへ移し固定catalogと置換seamを削除した。Increment A（同期subagent廃止）で`subagent:<name>` slotと`delegate_to_*`を削除し、plannerは`agent:planner`のroot-runnable Definitionとして残した（Increment 127で同梱を撤去し、外部Definitionの通常bindingへ移行）。 |
| 自己改訂を支える観測・構成操作 | F06、F19〜F24、F27〜F29 | generic childはIncrement 131で実装済み。Agent自身の観測、root model操作、rebuild等から必要な狭い増分を選ぶ。Definition限定・固定Phase順序にしない |
| durable Instanceによる複数Sessionの管理 | F16〜F18 | 共通identity・binding・writer管理が必要になった場合に採用する。自己改訂の前提にはしない |
| 追加オプション | C01〜C05は非網羅的な例示。採用時に正式なF番号を付ける | 構想から要求されていない将来オプション |

### 通常利用で見つかった問題を改善する（F01〜F15、F26、F27）

人間が改善を直接要求するか、通常利用で具体的な問題や改善機会が見つかった場合は、F01〜F15、F26、F27のどの
product動作に関わるかを確認し、通常利用へ戻せる狭いincrementの個別実装計画を
`docs/increments/increment-N.md`として作る。このroadmapへ個々のincrementや作業履歴を追加しない。
契機がなければ実装作業は発生しない。人間が通常利用の経験からHenji自身へ改訂を指示する運用もこのincrement単位で
進められる。Agent自身が経験解釈・改善案形成に関与した範囲は、担当した個別incrementの結果へ記録する。

TUIの改善もこの扱いに含む。入力・表示・操作性は主にF01、Session/history/contextの利用はF05、Surfaceの
分離・load・置換はF10へ対応付ける。既存Fで表せない新しいproduct動作には新しいF番号を付ける。Surface
自体も必要な時点でF24の改訂対象にできる。目的を変える場合は構想、Host / Worker /
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

以下のIncrement 32〜34は実装済みの当時計画・受入境界の履歴である。現在の実装状況は上記F一覧を参照する。
当時のparent／planner roleと同期delegationはIncrement 106で廃止し、現行childはIncrement 109／110／131の
async Executionとして扱う。

### Increment 32 — standalone executableとexternalization共通境界

対象機能: F01、F03、F04、F06、F07、F09

配布基盤として、Deno runtimeとproduction entryを含む単一の`henji` executableを作り、binary、
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
- このIncrement時点ではexternal parent Definitionに同梱したbuilt-in toolのsame-identity replacementを許した。
  この経路はIncrement 69〜71で廃止され、現行はtool Definitionのinstallとactivation bindingで差し替える。
  新tool identity、AIから呼べるinstall、hot reload、remove/GCはこのIncrementの対象外だった。
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

### Increment 51 — managed Henji base instruction

対象機能: F03、F06、F08

注: このmanaged revision方式はIncrement 103で`$XDG_CONFIG_HOME/henji-harness/instruction.md`の直接読み込みへ
置換された（以下の記述は当時の履歴）。

Definition以外で最初のmanaged resource kindとして`henji-instruction`を追加し、Henji共通baseを
`instruction:henji-base`という一つのsemantic slotで扱う。core-owned built-in revisionをfallbackとして持ち、人間が
install済みexternal exact revisionをinstallation/user scopeでactivateした場合だけ、次のWorker generationから置き換える。

- authoring packageは`henji-resource.json`と一つのUTF-8 `instruction.md`からなり、manifest metadataとinstruction exact
  bytesをcanonical digestへ含める。contentはtrim/normalizeせずmanaged revisionとcomponentへbyte-equivalentに投影する。
- installとactivationを分離する。installはXDG dataのlocal custodyだけを作り、activate/deactivateはXDG configのbindingを
  変更する。active generationのhot replacement、`/rebuild`、transport、removeは含めない。
- Hostはgeneration開始前にselected exact ref/contentをDefinition評価結果とは独立して解決する。active external revisionの
  resolution failureではbuilt-inへ暗黙fallbackせず、provider requestやSession mutationより前に失敗する。
- Worker-coreのmandatory finalizerだけがselected baseをDefinition-owned instruction contributionの先頭へ二つのLFで合成する。
  root（planner rootを含む）は同じselected revisionを使い、Definitionがcore-owned slotをnamed componentとして返すことは拒否する。
- context attributionはselected ref、slot、selection source、content digest、exact content、final system instruction内のprojection、
  provider requestを相関し、authoring source、custody、active binding、execution recordを別authorityとして保つ。

このIncrementの直接install/activateは人間操作であり、AIによるcandidate生成・比較・採用を含むF24のSelf-revision Cycle
完了とは扱わない。native `AGENTS.md`/Skillも置換しない。

### Provider外部化とOpenRouter Responses API

対象機能: F02、F06、F24

利用者希望（2026-09-17）をIncrement 58〜68で実装した。OpenRouter Chat CompletionsとResponses APIを併設し、
Provider設定をdata-only declarationへ外部化した。adapterはbinary-owned
（`openai-responses`/`openai-chat-completions`）で、providerの追加・catalog・既定をbinary更新なしで扱える。

- OpenRouter Responses API経路: 同じOpenRouter credentialでResponses API surfaceを使うrouteとadapterを扱う。
  実装済み（Increment 58）。tool call→streaming→canonical commit→evidenceを実providerで受入済み。
- Provider設定の外部化: Provider declarationをdata-only resourceとして外部化し、Hostがnon-secret auth profile
  catalogとcredential registry、request時のroute/credential解決を所有する。credential値、Authorization、tokenを
  portable artifact、Session、evidence、transcript、Definitionへ含めない。S2（Henji内credential登録）はこの
  registryへ接続する。
- 段階（実装順序）:
  1. Increment 58: OpenRouter Responses経路（built-in、実provider受入済み）。
  2. Increment 59/60: data-only provider宣言、Host解決、endpoint/catalog override、人間向けCLI。
  3. Increment 61: provider identity一般化（`providerId`+`protocol`+`authProfile`、Responses先行）。宣言で
     built-inとは別の新provider idを追加可能。実provider probe済み。
  4. Increment 62: Responses replay stateを生成元provider/modelへscope。
  5. Increment 63: 既定selectionのHost config外部化と、`openrouter`/`openai`のcatalog/defaults override。
  6. Increment 64: curated catalogをコードから外し、同梱default declarationsへ移行（実装済み）。
  7. Increment 65（実装済み）: activation-level slot bindingを追加し、delegated planner Definitionを
     slotで差し替え可能にした。planner defaultは同梱defaultのslot別`roleDefaults`へdata化した。
     （これは当時の既定である。同期slotはIncrement 106、同梱plannerは127で廃止した。現在のasync childは
     Increment 131の起動時model指定を使い、省略時は親Sessionの現在selectionを使う。）
  8. Increment 66〜68（実装済み）: provider pickerとResponses `auto` effortの通常利用不具合を修正し、built-in
     provider IDを`openrouter-chat`／`openrouter-responses`／`openai-chat`／`openai-responses`へ整列した。
  9. Increment 69（実装済み）: managed resource kind `tool-definition`を新設し、binary内の固定
     `tool:web_search`(Sonar)をbundled tool Definitionへ移設する。`$XDG_CONFIG_HOME/henji-harness/tools.json`
     のactivation bindingでexternal tool Definitionへ差し替え可能にし、固定catalog特別扱いを削除する。
  10. Increment 70（実装済み）: tool宣言のownerを各Agent Definitionへ統一し、Henji helperがDefinition由来の追加tool
     宣言＋Host解決済みcomponentを合成できるよう一般化した。`tools.json`はbindingのみを持ち、宣言は持たない。
     最初の追加identity`web_fetch`（url→本文＋メタ、素のHTTP GET、最小HTML→text抽出）をbundled defaultが宣言する。
     旧「tool same-identity override」の内容はIncrement 69へ包含した。
  11. Increment 71（実装済み）: `bash`／`bash_output`／`edit`／`read`／`write`をbundled tool Definitionへ移し、
     固定`ToolComponentCatalog`／`workToolNames`と同一identity置換seamを削除した。差し替えは`tools.json`のexternal
     tool Definition bindingへ一本化し、当時のcore-owned tool（`skill`／`delegate_to_planner`／`submit_json_result`）は
     Definition化しなかった。`delegate_to_*`はIncrement 106で削除し、現在はasync child toolを使う。
     tool Definition transportは、tool Definitionを通常利用で安定させた後に別incrementで扱う（決定:
     2026-09-18）。任意kindの共通frameworkと他kind候補は`docs/experience/normal-use-inbox.md` E2で管理する。
  12. Increment 72（実装済み）: `subagent:<name>`をplanner以外へ一般化し、`tool:delegate_to_<name>`でchild laneへ
     1 turn 1回委譲する。Hostはbundled subagent（planner）＋`agents.json`の`subagent:*` bindingを解決し、bundled
     moduleが無いnameはbindingを要求する。Definitionは`additionalSubagents`で追加subagentを宣言できる。
     （Increment Aで同期subagentを廃止し、`subagent:<name>` slotと`delegate_to_*`を削除した。childはExecution間の
     親子関係としてIncrement 109／110で非同期実装済み。131でgenericと起動時model/tool指定を追加した。）
     他kind候補と共通frameworkは`docs/experience/normal-use-inbox.md` E2で管理する。
  13. Increment 101（実装済み）: `authProfile`を非secret identityとしてpattern一般化し、credentialを
     `<XDG_CONFIG_HOME>/henji-harness/<authProfile>`から解決する。新しいprovider IDの宣言はoptional `headers`
     （`{credential}`はChat経路のみ1 header、`{sessionId}`）を持ち、declared chat/Responses adapterがrequest時に
     置換する。OpenCode Go（`opencode-go-chat`／`opencode-go-responses`）はexternal宣言で追加し、chat SSEの
     `usage:null` chunkとterminal frameの`usage`を受理する。
- architectureは
  [`architecture/multi-provider-routing-and-auth.md`](architecture/multi-provider-routing-and-auth.md)と
  [`architecture/henji-host-agent-worker.md`](architecture/henji-host-agent-worker.md)へ反映済みである。

### 自己改訂を支える次の増分

人間主導でHenji自身が実装に関与する現在の運用を基盤に、Agent自身が自分を観測・振り返り、必要な構成を
選び、変更を後続実行へ反映する手段を育てる。以下は候補となる動作と必要な判断であり、固定された実装順序や
個別incrementの実装認可ではない。

| 動作 | 使える基盤と不足 | 採用incrementで決めること |
| --- | --- | --- |
| 自身の観測・振り返り（F19、F28） | semantic履歴・attribution・短いrequest fact、人間向けTUI/history、間接的なhistory参照がある | 今の作業に必要な対象Session/execution・実効状態、Agentがそれを発見し取得する入口 |
| 構成を選んだ子実行（F06） | genericとspawn時task/model/tools指定はIncrement 131で実装済み | 通常利用の結果から具体的な不足が出た場合に、その一動作だけを追加する |
| root modelの選択（F29） | 人間のidle時selectionと子実行のmodel指定がある。rootのAgent向け要求は未実装 | 要求の入口、適用するmodel step/execution境界、保存scope、結果のreadback |
| resourceからのrebuild（F27） | 新generationへのinstruction取込みはある。既存会話を保つ再構築操作は未実装 | 最初の対象resource、構築・適用境界、要求元taskの続きと状態引継ぎ、人間の採用境界 |
| 経験に基づく候補・採用・通常利用（F20〜F24） | repositoryのsource/diff、通常利用メモ、increment、人間の指示と採用を使う運用がある | その変更に必要な経験・由来・候補の区別と採用/適用操作。全resource共通schemaや専用storeを先に要求しない |

最初の対象をDefinitionに限定しない。instruction、skill、tool、modelの選択と使い方、loop、runtime、Host/Worker連携、
Surface等から実際の目的に必要な対象を選び、観測・構成操作・改訂反映の仕組み自体も改訂する。
managed revision、native input/state、binary platform authorityのどれを変更するかに応じ、既存の保存・採用・
適用経路を利用する。Henji executableはversion/build/source commit、個別resourceはexact revisionや観測した内容、
modelはselectionとして追い、全体を一つの統一revisionにしない。

native `AGENTS.md`/Skill discovery、user `instruction.md`の直接読込みを維持する。binary変更は新buildとして扱い、
resourceからのrebuildと同一operationとは決めない。改訂前後の統制実験・定量測定を完了条件にせず、改訂後の
通常利用で観測した変化を次の経験へ戻す。経験解釈・候補生成・適用にHenjiが担った範囲は個別incrementへ記録する。

durable Instanceは、複数Sessionを同じidentity・active binding・writerで束ねる具体的な必要が生じた場合にF16/F17として
採用する。新しいexperience store、専用candidate管理、mailbox等も、それぞれ必要な動作から採否を判断する。
旧Definition＋durable Instance方式のPhase 1〜5は
[`過去の計画案`](history/self-revision-cycle-1-definition-instance-plan.md)へ保存した。

## 構想・architectureの未決事項と判断する契機

| 未決事項 | 判断する契機 | 現在の扱い |
| --- | --- | --- |
| Agent自身が観測する対象とreadback | F28の最初のincrement | 現在のSession/executionと実効構成から、今の作業に必要な情報を選ぶ。人間向けhistoryの存在だけで成立済みにしない |
| 経験の具体的な残し方と読み方 | F19/F20で具体的な不足を扱うとき | 既存semantic履歴とrepositoryの記録を利用し、Sessionをまたぐ参照もdurable Instanceを前提にしない |
| 新しいexperience datumの生成・durable保存の粒度 | 新しい経験recordが必要になったとき | 通常semantic append/canonical adoptionはIncrement 41/94、短いrequest factは121で実装済み。必要な追加粒度・相関だけ決める |
| Agentのroot model選択の適用時点と保存scope | F29の最初のincrement | 現行は人間がidle時に変更しturn内で固定。Agentの要求をどの後続step/executionへ適用するか具体化する |
| `/rebuild`対象resourceとtransition semantics | F27の最初のincrement | 要求元taskの継続と状態引継ぎ、構築・適用境界を決める。managed候補採用やbinary配置を自動的に統合しない |
| `AgentContextGeneration`のidentityと基底設定の範囲 | F27で必要になったとき | canonical conversation、projection、execution中の動的inputまで一つのgenerationへ固定しない |
| 候補生成・内容確認の入口 | F20/F21の具体的な増分 | 人間の指示、Agentの観測材料、対象のsource/diff/dataと由来を結ぶ最小経路を決める |
| 人間の採用境界と適用操作 | F22/F27/F29の採用動作ごと | 人間が定めた範囲内でAgentが操作できることと、その境界を変える判断を分ける。操作ごとの承認は一律に追加しない |
| process以外の物理I/O placementの変更 | 採用する機能が変更を必要とするとき | processはHost共通executor、provider HTTPはWorker。対象の責務・lifetimeから判断する |
| Worker protocolのmessage、handshake、versioning | 新しいHost操作を公開するとき | 人間のSurfaceとAgentのtoolでHost operationを共有する方向とし、その動作に必要なmessageだけ決める |
| Compositionの再構築単位 | F27/F29等で構成変更を扱うとき | 現行generation単位の構築を基盤に、後続step/executionへの適用が必要な範囲を決める |
| Definitionのdependency lineage、load、promotion | 対象Definitionの改訂で必要になったとき | Increment 32〜34のlocal closure・exact ref・transportを再利用し、他対象の共通必須方式にしない |
| durable Instanceのidentity・所属・writer・binding | F16/F17を採用するとき | 複数Sessionを束ねる具体的な利用目的を先に定める。Session継続と自己改訂の開始条件にはしない |
| cross-session memory / Instance-wide state | 観測・経験参照に具体的な不足が出たとき | 必要な状態とownerを定め、履歴の自動共有や全ての会話の混合を推測で追加しない |
| mailbox、routing、schedule、常時到達性 | 個別機能を採用するとき | durable Instanceや自己改訂だけから実装を要求しない |
| effectのrecovery、deployment、migration | 対象effectや実行環境を変更するとき | 実際の契約・移行対象に必要なsemanticsだけ決める。新しい権限・旧data削除を構想変更から導かない |
| 次の改訂対象 | 各incrementの通常利用後 | 観測された必要に応じて選び、Definition-onlyの一巡完了を待たない |
