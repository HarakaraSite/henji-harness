# Henjiの経験駆動による自己改訂

ステータス: 採用済みの構想。人間主導の改訂運用は一部開始済み。個別incrementの実装認可ではない

確認日: 2026-09-05

位置付け修正日: 2026-09-06

履歴と改訂適用の構想更新日: 2026-09-12

Agent自身の観測・構成操作と自己改訂の位置付け更新日: 2026-09-26

## 構想

Henjiは、使う中で得た経験から、指示、skill、実行方法を含むHenji自身の機能を継続的に改訂できる
agent harnessを目指す。

Henjiは同時に、正常に成立した会話だけを正本へ原子的に採用しながら、cancel、failure、途中のtool
result等も後から振り返れる材料として失わないagent harnessを目指す。このアトミックな履歴は、
自己改訂の根拠となる経験を保つ基盤であるとともに、通常利用の信頼性、診断、履歴参照において
独立したproduct価値を持つ。

この発想の具体例は、外部CodexがVMのhandoff skillを見直し、その新しい形式へrepositoryのhandoffを
移行した経験である。ここで重要なのは、その作業自体をHenjiの自己改訂とみなすことではない。実際の
利用で得た知見を、次のHenjiの機能へ反映し続けられる性質として捉えた点にある。

目指す関係は、履歴の正本を壊さずに、自分を改訂できるagentである。

## アトミックな履歴

Henjiが保持する履歴全体は、会話として採用されたturnだけではない。Hostが観測できた成功、cancel、failure、
途中のassistant出力、tool call/result、終了状態と、それらを解釈するためのAgent側の状態をdurable historyとして
残す。そのうち、Hostが正常完了と会話への採用を確定したturnだけをcanonical conversationとして以後の通常会話へ
引き継ぐ。ここでいう正常完了は、回答内容の正しさや利用者の満足を意味しない。

人間はcanonicalとnon-canonicalの双方を履歴として参照できる必要がある。AIが過去executionから既定で引き継ぐ
会話履歴はcanonical conversationに限定するが、現在execution内で得たtool result等や、人間または依頼の目的に
沿ってAgentが明示的に選んだ過去の材料は、その目的に応じてmodel contextへ投影できる。Agentが観測材料として
履歴を読むことと、過去executionを通常会話へ自動継承することは区別する。

履歴は過去の実行を完全に再現するためのsnapshotではない。過去にHenjiが観測できた内容と、その判断に関与した
instruction、skill、Agent Definition、tool contract、供給・観測した環境情報等を振り返り、次の改訂を考えるための
材料である。過去Worker、model内部状態、OS、filesystem、外部service、toolの副作用を再現することはこの構想の
目的に含めない。

## 履歴の三目的

Henjiの履歴は、相互に関係するが同一ではない三つの目的を持つ。

1. 通常利用の履歴は、人間が見た会話、tool利用、結果と、その意味を後から理解するための背景を保持する。
2. 障害診断は、transport、parser、Worker、storage等の実装障害を特定するための詳細を保持する。
3. 自己改訂の経験は、何が良かったか、悪かったか、何を変えたいかを考えるために過去の観測を利用する。

通常履歴の背景は、表示された出来事から、人間の入力・判断、Agentへ実際に渡したcontentまたはimmutable
revision、tool／providerから得たsemantic result、Hostのadmission／outcome／canonical decision、
明示的な未観測境界へ至るまでの最小説明閉包とする。exact transport、chunk、parser内部遷移、Worker stage、
physical storage位置は、それが無くてもsemanticな出来事と直接原因を説明できる限り、通常履歴ではなく
診断detailである。

診断detailの欠落や不一致だけを理由に、semanticなexecutionまたはcanonical adoptionを失敗させない。
一方、通常履歴のsemantic authority自体をdurableにできない場合は、成立していない会話をcanonicalとして
採用しない。通常履歴にはtool event、runtime outcome、provider／modelと物理requestの順番、HTTP／error、
解析失敗の項目と値の形を短いfactとして保存し、人間とAgentが次の調査を決める材料にする。通常実行でraw
request／responseやSSE断片を常設収集せず、必要な場合は別probeで取得する。

詳細情報を多く持つこと自体を、追跡可能性または自己改訂可能性と同一視しない。自己改訂に適切な情報は先に
固定せず、実際の候補生成や人間の判断で使った情報、足りなかった情報、使わなかった情報を後のloopで観測し、
通常履歴、診断、experience projectionの境界も改訂対象にできる。

## 自由度の意味

この構想でいう自由度は、目的別に多数のagent variantやAgent Definitionを保有し、その都度別のagentを
生成・選択できることを主に意味しない。同じHenjiが経験に応じて、自身の構成と振る舞いを継続的に
改訂できる自由度を意味する。

改訂対象には、必要に応じて次を含む。

- instructionとskill
- sessionをまたいで残す事実、目的、判断理由と、それらを選択・圧縮するcontext
- tool、delegation、modelの選択と使い方
- 実行、待機、介入のtimingとagent loop
- executable Definition、runtime、HostとWorkerの連携
- 利用者がHenjiを継続して使うためのinterface

対象をあらかじめ文章ファイルや固定されたcomponent一覧へ限定しない。観測された利用上の必要に応じて、
Henjiの機能そのものを改訂できることが中心である。

その手段として、Agent自身が実行・実効構成・履歴を観測し、振り返れるようにする。Agentが`/model`相当の
操作を要求して次の作業に使うmodelを選ぶこと、task・model・toolsを指定して無名subagentを起動すること、
`/rebuild`相当の操作で対象resourceから実効構成を再構築することを、構成操作の手段として位置付ける。
これらの操作能力だけで経験に基づく自己改訂を実証したとはみなさず、観測・解釈・変更・通常利用の関係で
評価する。観測手段や構成操作、改訂を反映する仕組み自体も改訂対象にする。

## 人間が使うSurface

TUIを含むSurfaceは、内部機能を呼び出す付属画面ではなく、人間がHenjiを通常利用し、経験を得て、次の
改訂へ関与するためのproduct機能である。人間は外部文書やhelpを先に読まなくても、依頼を入力し、処理中か
入力待ちかを知り、依頼、作業、結果の流れを追い、保存されたSessionを選んで利用を続けられる必要がある。

現在の主な対話SurfaceはTUIである。ただしHenjiの目的をTUIそのものへ固定せず、同じHenjiと保存Sessionを
別のSurfaceからも利用できる方向を保つ。durable Instanceを採用する場合もこの方向を維持する。
改訂候補の生成を指示し、候補を確認し、採用または
承認する人間の操作も、採用時点のSurfaceを通じて行う。

Surfaceの使いやすさは、機械testやhelpの記載だけでは確定しない。人間が実際のproduct経路を通常利用して
観測した困難、有用な成功、違和感、判断を経験として扱い、必要な改善を次の開発loopへ戻す。観測により
目的が変わるなら構想、責務や境界が変わるならarchitecture、実装順序や増分が変わるならroadmapを改訂する。

## 経験と改訂の関係

通常利用で観測された困難、有用な成功、違和感、利用者の判断を経験として継続的に残す。Henjiはその経験を
読み、意味を考え、自身の変更候補を作る。採用された変更はその後の通常利用に現れ、そこで観測された変化が
また新しい経験になる。

経験を解釈するには、会話とtool activityだけでなく、そのexecutionがどのAgent側の状態と会話状態を使ったかを
相関できる必要がある。改訂後は、人間が定めた目的、改訂範囲、採用境界に従い、人間またはAgentの操作で
新しい実効状態を後続実行へ適用し、過去のturnとその来歴は書き換えない。改訂候補の生成、候補の採用、
現在resourceからの実効状態の再構築をどの操作へ分けるかは、
対象resourceのarchitectureとroadmapで決める。

これは、人間が経験から学び、考え方や行動を変え、その後の経験からまた学ぶような変化の観測モデルである。
変更前後を統制された条件で比較すること、改善を定量的に測定すること、変化の原因を一つの構成差分へ帰属
させることを前提にしない。この関係は自己改訂の性質を説明するものであり、固定された実施手順を定めない。

継続性はこの構想の重要な要素である。Henjiは、何を残し、何を読み、どう解釈するかも改訂対象にでき、
作業、目的、判断理由を次のsessionや相談へ引き継げる必要がある。既存の保存Session、semantic履歴、
repository上の記録を基盤に段階的に進められ、durable AgentInstanceや専用candidate管理の完成を
自己改訂運用の開始条件にはしない。

人間が経験を解釈してHenji自身へ改訂を指示する運用と、Agent自身が観測・振り返り・改善案の形成を担う範囲は、
個々の実行で区別して確かめる。経験の記録やcode編集ができることだけから、その全体を実証済みとはしない。

## Henji自身による自己改訂

外部Codexや人間がHenjiの指示やcodeを変更し、その変更後のHenjiが指示に従えたことは、通常の
開発・保守と機能確認である。Henji自身による自己改訂と呼ぶには、少なくともHenjiが実利用の経験を
解釈し、自身の機能に対する改訂候補の生成へ実質的に関与している必要がある。

改訂候補は、人間の明示的なアクションまたは指示を契機として、Henji内のAIが生成する。生成された候補を
採用するのも、人間が採用アクションを行うか、提示された候補を明示的に承認した場合に限る。AIが人間の
契機なしに改訂候補を自発的に生成することや、候補を自動採用することは、この構想に含めない。

経験の記録と参照をどこまで自動化するか、候補生成や採用をどのinterfaceで人間へ提示するかは、この構想
では決めない。人間が定めた目的・改訂範囲・採用境界の中でAgentが構成操作を行えるようにし、
その範囲での実行と、採用境界そのものを変える判断を区別する。操作ごとの承認を一律に要求することや、
Agentによる候補の自動採用を、この原則から導かない。

## Agent Definitionの位置付け

Executable Agent Definitionは、Henjiの改訂された構成を表現・実行する手段になり得る。Definitionの
variantを増やすこと自体は目的ではなく、Definitionを読み込めることだけでも自己改訂の証拠にはならない。

現在のDefinition APIがmodel、registry、system instruction、maxStepsを組み合わせられることも、Henjiが
経験から自身を改訂できることを示さない。DefinitionとHost / Workerの具体的な役割はarchitectureで定め、
将来どの機構を自己改訂へ使うかは、その段階の実装計画で決める。

Henji executableの改訂はversion・build・source commit、Definitionの改訂は個別resourceのexact revisionで
追う。instructionの内容やmodel selection等も各実行へ相関する。Definition revisionをHenji全体の
改訂identityとみなさず、全実効状態を一つのrevisionへ統合することを前提にしない。

## 現在との境界

利用者の通常利用の経験を基に、人間が改訂を指示し、Henji自身が一部incrementの実装を担う運用は始まっている。
これは自己改訂を育てる現在の運用であり、各incrementでAgent自身が経験解釈・候補生成まで担ったことや、
専用product flowの一巡が実証済みであることを一括して意味しない。

TUI、history、executionとAgent状態のattribution、短いrequest factにより、人間がAgentの挙動を観測する
経路は充実してきた。Agentも現在の会話・tool resultやbash/history等から間接的に情報を参照できるが、
自分の実効構成と対象executionを発見し、必要な履歴を選んで振り返る操作は今後整える。
Increment 131の無名subagentは、用途ごとのDefinition準備を要求せず、Agentが起動時にtask・model・toolsを
選ぶ手段として実装済みである。

rootの`/model`相当操作をAgentから要求する経路と、`/rebuild`相当操作は未実装である。model変更の適用時点・
保存scope、rebuildの最初の対象resourceと状態引継ぎは、採用するincrementで定める。ここでのrebuildは
resourceから実効構成を再構築する操作であり、binaryの再compile・配置・再起動と同一の操作とは決めない。

現在のroadmapは、通常利用で必要な改善と、Agent自身の観測・構成選択・変更反映に不足する動作から
狭い増分を選ぶ。最初の改訂対象をDefinitionに限定せず、改訂手段自体を次の対象にできる。
個別incrementの対象、要件、計画、実装認可は、その都度利用者の目的に沿って定める。
