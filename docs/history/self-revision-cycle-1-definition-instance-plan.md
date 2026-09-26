# 旧Self-revision Cycle 1 — Definitionとdurable Instanceを前提とした計画案

保存日: 2026-09-26

この記録は、同日の利用者との構想議論を反映する前の`docs/roadmap.md`にあった計画案を保存したものである。
実装・完了記録ではなく、現在の必須要件・実装順序・実装認可ではない。旧案のDefinition-only、durable Instance、
Phase 1〜5の固定dependency orderは、自己改訂一般の前提から外した。現在の方向と状態は
[`roadmap`](../roadmap.md)、目的と人間による採用境界は
[`構想`](../concepts/experience-driven-self-revision.md)を参照する。
以下は移動時の案をそのまま保持する。

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
- SessionからInstanceへの所属を保存するschemaと、現行durable Sessionの扱い。history v7／SQLite schema v10を
  現在の基盤とし、旧Sessionのmigration採用は推測で追加しない。
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
- 通常履歴の最小説明閉包と短いrequest factを使い、experience側はstableなsemantic
  authorityを参照する。
- 実際の候補生成または人間判断で使った情報、必要だが無かった情報、読んだが使わなかった情報をどう記録し、後続の
  次の改善候補へ結び付けるか。
- 新しいexperience datumを採用する場合、その生成・durable保存の時点と粒度、既存semantic履歴との相関を決める。
  通常executionのsemantic append、canonical adoption、短いrequest factは既存経路を再利用する。
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

Phase 5で得た経験を基に、人間が次のself-revision loopを開始すると決めた場合に扱う。instruction、任意の
managed Skill、context、tool、delegation、model profile、agent loop、runtime、Host / Worker連携、Surface data/code、
integration declaration等から、そのloopで必要な対象を一つ選ぶ。対象はこの一覧に限定しない。

選択時には、managed revision候補、すでに外部にあるinput/state、binaryに残すplatform authority、追加architecture
判断が必要な対象のどれかを先に分類する。そのうえでcontent、contract、exact dependency、activation authority、
scope、execution placement、lifecycle、durability、Session/evidence attributionを決める。共通envelopeへ格納できる
ことだけを外部化理由にしない。

native `AGENTS.md`/Skillはzero-install discoveryを維持し、managed Skillを追加しても置換しない。base instructionは
user `instruction.md`の直接読み込みを維持する。
MCPもnative protocol connection、credential、server、runtime capability、実行recordを分け、Henji managed installを
接続の前提にしない。MCP connection/server artifactのexact pinやtransportが必要になった場合だけ、Integration
resourceとして別incrementを採用する。

目的を変える必要があれば構想、責務・状態・lifetime・commit境界を変える必要があればarchitectureを先に
改訂し、その結果から対象機能と実装順序をroadmapへ追加する。Cycle 1の完了だけを理由に対象を自動的に
拡張しない。
