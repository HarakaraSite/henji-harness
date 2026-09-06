# Henji 機能インベントリと反復型実装ロードマップ 第三者review結果

ステータス: **GO — 初回Blocker 0、P1 1、P2 4を修正し、re-reviewで5件closed**

確認日: 2026-09-06

対象: [`roadmap.md`](roadmap.md)

## review範囲

第三者reviewerがread-onlyで、roadmapと次の正本・active sourceを照合した。

- [`concepts/experience-driven-self-revision.md`](concepts/experience-driven-self-revision.md)
- [`architecture/henji-host-agent-worker.md`](architecture/henji-host-agent-worker.md)
- [`../v0/`](../v0/)
- [`../README.md`](../README.md)
- [`plans/agent-worker-real-provider-human-acceptance-results.md`](plans/agent-worker-real-provider-human-acceptance-results.md)

評価対象は、構想・architectureから導く機能一覧、現コードの実装状況、機能とarchitectureの対比、
未実装機能のroadmap、各phaseの判断事項、開発loopの整合性である。一般的なsecurity/hardening review、
provider/production/credential操作、full gate、file変更はreview範囲外とした。

## findings

### P1 — durable AgentInstanceとresident Hostの依存が不整合

承認済みarchitectureは、永続agentを採用する場合にresident Hostが必要であり、durable
`AgentInstance`はWorker generationより長く存続すると定める。一方、roadmapのPhase 1はdurable
Instanceを採用しながらprocess-per-use Hostで成立させる選択肢を残し、resident service/supervisionを
条件付き機能C04まで延期している。

このままでは、architectureが要求するdurable lifecycle ownerなしにPhase 1を完了し、後続の経験保存と
revision bindingを積む可能性がある。Phase 1で必要なresident Hostと、常にaddress可能なagent serviceを
区別して依存関係を直す必要がある。process-per-useを採る場合は、実装前にarchitectureへ戻る。

根拠:

- `docs/architecture/henji-host-agent-worker.md:33-40`
- `docs/roadmap.md:150-179`
- `docs/roadmap.md:133-137,317`
- `v0/agent/worker_host.ts:366-372,1240-1259`

### P2 — F06が未実装のcomposition要素まで実装済みと読める

architectureはDefinitionが`provider/model/effort/loop/tools/subagents/context`をAgentCompositionへ合成すると
定める。roadmapのF06は`effort`を列挙せず、機能全体を実装済み・受入済みとしている。現行
`WorkerAgentComposition`はmodel、registry、maxSteps、systemInstruction等を持つが、effortを持たず、
loopとcontext/compactionは`WorkerGeneration`内の固定実装である。

利用者がDefinition基盤をarchitectureどおり完成済みと判断しないよう、F06を部分実装として、現在合成
できる項目と未実装のeffort、loop、context等を区別する必要がある。

根拠:

- `docs/architecture/henji-host-agent-worker.md:28-30,47,90-94`
- `docs/roadmap.md:77`
- `v0/agent/worker_agent_api.ts:37-61,139-176`
- `v0/agent/worker_runtime.ts:276-301,351-502`

### P2 — 部分実装F10にroadmap上の実装または再判断点がない

architectureはSurfaceのload・置換をHost責務としている。roadmapも一般的なSurface選択、load、置換の
product interfaceがないためF10を部分実装としているが、Phase 1–5の対象機能にはF10がなく、必要になった
loopへ送るだけである。

直近実装へ格上げする必要はないが、未実装機能のroadmapとして、どの通常利用の観測を契機にどのloopで
再判断するかを明示する必要がある。

根拠:

- `docs/architecture/henji-host-agent-worker.md:31-32,76-82`
- `docs/roadmap.md:81,115-125`

### P2 — Phase 1の完了証拠にInstance単位のinput semanticsが不足

architectureとF17は、同一Instanceのwriter generationを一つにし、Hostがadmitしたinputをserializeすると
定める。現コードのbusy制御は各`WorkerHostSession`内だけであり、複数SessionをまたぐInstance単位の
admissionはない。Phase 1の完了証拠はbinding、restart、古いgenerationのcommit拒否を扱うが、複数inputの
動作を確認しない。

修正時は、二つの入力を必ずqueueすると先に決めず、拒否、待機、順次実行のどれをproduct動作として採るか
をPhase 1で決め、その動作がInstance単位で守られることを完了証拠へ加える必要がある。

根拠:

- `docs/architecture/henji-host-agent-worker.md:134-139`
- `docs/roadmap.md:88,160-191`
- `v0/agent/worker_host.ts:386,821-826`

### P2 — READMEとWorker real-provider受入状態が矛盾

roadmapと受入resultsはWorker real-provider gateをacceptedとしている。一方READMEには、gateが未実行で別の
Human Gateを待つという受入前の記述が残っている。同じ正本集合から現在地について反対の結論を読めるため、
roadmapの承認前に矛盾を解消する必要がある。

根拠:

- `docs/roadmap.md:17-18,67-68,143-144`
- `docs/plans/agent-worker-real-provider-human-acceptance-results.md:3-16,70-72`
- `README.md:199-202`

原因は、2026-09-05のWorker real-provider human acceptance完了後に、READMEの受入前説明が更新されなかった
ことである。正しい現在地は受入resultsの`accepted`である。初回review時点ではREADMEを変更していなかった。

## 未確認のproduct動作

次はfindingではなく、現在も未確認であるproduct動作である。

- integrated TUIの最終daily-use adoption。
- natural 64K production経路でのautomatic compaction。
- 現在のWeb Worker production経路でのreal-provider planner delegation。plannerを実行したGate 1はWorker
  導入前で、2026-09-05のWorker acceptanceではplanner callは0だった。
- 現Worker経路でのschema-v2 reopenとcheckpoint reopen。provider-free証拠はあるが、指定されたWorker
  Human Gateでは再起動後の利用を行っていない。

## 保持されている要求

次はroadmapで正しく保持されており、findingはない。

- 改訂候補は人間のアクションまたは指示でだけAIが生成する。
- 候補は人間の採用アクションまたは明示的承認でだけ採用する。
- 将来のself-revision dependency orderを直近の実装incrementとみなさない。
- 行き詰まった内容に応じ、実装、roadmap、architecture、構想へ戻る。
- 一度のloopで完全なproductを作ることを前提にしない。

## owner dispositionと次

coordinating ownerは5 findingsを採用した。input serialization findingは、reviewerが例示したqueueを
必須仕様とはせず、Phase 1で拒否、待機、順次実行のproduct semanticsを決める問題として扱う。

ユーザーの修正指示を受け、`docs/roadmap.md`と`README.md`を修正した。同じ第三者reviewerが変更箇所と
既存5 findingsだけを15分以内で一回re-reviewし、次のclosureを確認した。

| Finding | closure |
| --- | --- |
| durable AgentInstanceとresident Hostの依存 | **closed**。resident HostをPhase 1の必須前提にし、常時address可能なC04と分離した |
| F06 compositionの実装状況 | **closed**。部分実装へ訂正し、effort欠落と固定loop/context、および将来のrequired loopを明記した |
| F10 Surfaceの再判断点 | **closed**。第二Surface、Surface置換、self-revision UI追加を開始契機とするrequired loopを追加した |
| Phase 1のInstance単位input semantics | **closed**。拒否、待機、順次実行を決める地点、admit後の順序、重なるinputのproduct証拠を追加した |
| READMEとWorker受入状態 | **closed**。受入前の記述を除き、初回修正ではaccepted resultsへ同期した。その後READMEを構想要約5行だけにして、現在地を置かない方針へ変更した |

re-review結果はGOで、新規Blocker/P1は0件、保持要求の後退はない。roadmapの各phase実装、
provider/production実行、commit、push、tag、publish、releaseは、このreview結果から認可されない。

re-review後、ユーザーはREADMEを変動する現在地の正本にしないと決定した。READMEは見出しと構想要約5行
だけへ置き換え、roadmapもREADMEをproduction利用方法の正本として参照しないようにした。これにより同じ
README findingは、acceptedへの同期ではなく競合する現在地をREADMEから除く形で引き続きclosedである。
この変更に対する追加reviewは実施していない。

その後ユーザーはroadmapを採用し、TUIの目的・境界・開発順序も構想、architecture、roadmapを正本とする
よう指示した。旧FR5文書から現行TUIの動作、設計判断、未決事項を3文書へ反映し、旧FR5文書を履歴へ
archiveした。この正本整理はre-review後の変更であり、このreview結果の評価対象には含まれない。
