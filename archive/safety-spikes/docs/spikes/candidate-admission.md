# Henji Harness: Definition / Revision / Admission Cycleスパイク

## 位置づけ

これはv1計画、正式なplanner input、production実装計画ではない。Henji
Harnessの自己改訂cycleを、小さな観測へ分解する捨ててもよいconcept spike briefである。

2026-08-19のconcept reviewで「Deno permission flagだけでuntrusted pluginのfilesystem readをplugin
directory内へ隔離できる」というH-007はrefutedとなった。従来のsource直接実行方式と2 plugin provider
smokeはNO-GOのまま停止する。本スパイクはH-008〜H-013を対象にし、各gateの証拠から継続、縮小、方向転換、保留、終了を判断する。

### 仮説とSpikeの対応

| ID    | 仮説                                                                                                                                                         | 対応するSpike                                                                                  |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| H-008 | 狭いaccepted subsetとtrusted Admission Builderにより、未信頼TypeScript sourceから「外部module closure空、runtime authorityなし」のimmutable artifactを作れる | Spike 2のAdmission、Spike 3のsame-object比較とbounded run                                      |
| H-009 | canonical DefinitionContentをRevision View経由で往復しても正本性を保てる                                                                                     | Spike 0のDefinitionContent roundtrip。DefinitionRevision lifecycleはSpike 1以降                |
| H-010 | exact-base ticketとimmutable Proposalにより、AIをcurrentから切り離し、scope、budget、provenance、conflictを強制できる                                        | Spike 1のProposal、Spike 4のstale/conflict                                                     |
| H-011 | opaque ApprovalRecordとDeploymentState CASにより、staleまたは差し替えられたcandidateの昇格を防ぎrollbackできる                                               | Spike 4のbase固定、Spike 5のpromotion/rollback                                                 |
| H-012 | data planeからcontrol planeを呼べず、全candidate originを同じintakeへ強制できる                                                                              | Spike 1のorigin、Spike 2のintake迂回拒否、Spike 3のmethod/authority分離、Spike 5のaction別承認 |
| H-013 | private holdoutと同条件比較により、candidate所有testだけより意味のある改善判断ができる                                                                       | Spike 5のspawn-per-run evaluation                                                              |

## 中核cycleと対象

```text
Plugin v1
  → Revision Interface
  → canonical Plugin Definition / Revision View
  → AI
  → Definition Proposal v2
  → Revision Interface
  → Admission Builder
  → immutable candidate artifact
  → test / shadow / evaluation
  → human approval
  → Supervisor atomic promotion
  → Plugin v2
```

新規pluginはhost-issued templateとbase
`null`から同じcycleへ入る。人間作成、AI生成、第三者提供、legacy sourceを共通Candidate
Intakeでnormalizeし、作者をtrust根拠にしない。hostがplugin IDとnamespaceを割り当て、origin、original
content hash、normalizer digestを保持する。

最初のkindは、text inputをtext outputへ変える`text-transform`とする。single UTF-8 TypeScript
file、import・external
dependency・追加assetなし、tool・model・filesystem・network・environment・subprocess・FFI・write・persistenceなし、人間promotionだけに限定する。停止中のprovider
smokeを混ぜない。

## Canonical object model

| Object                                 | 内容                                                                                                                                                                        | 境界                                                                          |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `DefinitionContent`                    | source、manifest、public contract、plugin-owned tests、config、requested capabilities                                                                                       | deterministic canonical encoding全体をcontent hash化するimmutableな意味の正本 |
| `DefinitionRevision`                   | content hash、base revision、provenance、created metadata                                                                                                                   | artifactを含まない履歴identity                                                |
| `DefinitionProposal`                   | `RevisionTicket`とmutation                                                                                                                                                  | exact baseへの未解決な変更要求                                                |
| `Resolved Candidate DefinitionContent` | Revision Serviceがexact baseへmergeしnormalizeした完全なcontent                                                                                                             | sealed Proposal IDからだけAdmissionへ渡る                                     |
| `AdmissionRecord`                      | DefinitionRevision ID/digestとcontent hash、Builder content/dependency digest、admission profile/policy digest、parser/compiler/runtime digest、closure hash、artifact hash | trusted channelでSupervisor-owned registryへ登録するopaque proof              |
| `EvaluationRecord`                     | admission、rubric/evaluator/dataset/environment digest、attempt/feedback、結果                                                                                              | promotion authorityを持たない評価証拠                                         |
| `ApprovalRecord`                       | DefinitionRevision ID/digestとcontent hash、exact admission/evaluation/promotion manifest/base deploymentへの結合                                                           | trusted UI/CLIがApprovalChallengeに対して発行するopaqueな人間承認             |
| `DeploymentState`                      | current definition revision、artifact、effective config hash、policy/endpoint registry/interpreter digest、generation                                                       | 実行中stateのauthoritative snapshot                                           |
| Artifact                               | Admission済みcontentから生成した実行物                                                                                                                                      | create-only content-addressed immutable object                                |

Definitionとartifactを循環参照させず、artifactからDefinitionを逆生成しない。AdmissionRecordがDefinitionRevision、DefinitionContent、artifactの対応を一方向に証明する。artifact
hashだけではAdmission proofにならない。

canonical encoding、default、unknown field拒否、normalization、各field ownerはversioned Definition
schemaの一部とし、Revision Serviceが一意に適用する。AIへhiddenまたは変更不能なfieldを返させず、exact
baseまたはhost templateからhostが保持する。

Revision Serviceはresolved contentをsealした時点でcandidate DefinitionRevision
ID/digestを発行する。同じcontent hashでもprovenance、base、IDが異なるrevisionを区別する。rejected
proposalはproposal/rejection historyへ残すがDefinitionRevision
registryへcandidateとして登録せず、admitted/evaluated revisionもpromotionまでcurrentにしない。Spike
0はDefinitionContent roundtripだけを扱い、このlifecycleはSpike 1以降で観察する。

## Revision、Admission、実行の境界

Revision Ticketはtarget、exact base revision/content hash/deployment state digest、visible/allowed
fieldとlogical path、mutation kind、budget、evidence scope、admission profile、policy
versionをhost側で固定する。AIはticket ID、single-file full replacement、reason、evidence
refs、expected effect、known riskだけをimmutable proposalとして返す。current
filesystemとregistryを直接編集できない。将来のexact patchもfuzzy
apply、自動rebase、scope外create/rename/deleteを行わない。

Revision Serviceがticketとmutationをexact baseへmergeし、scope、budget、provenance、unknown
field、stale/conflictを検査してResolved Candidate DefinitionContentをsealする。Admission
BuilderはRevision Serviceが発行したsealed Proposal IDだけを受け、raw source、任意path、legacy direct
load/installを拒否する。

Builderはpinned syntax-aware parser/compiler/runtimeを使い、candidate以外を含まない空build
directory、ambient configなし、import
mapなし、networkなしでclosureを確定する。artifactはcreate-onlyでatomic publishし、trusted registry
writerがAdmissionRecordを登録する。SupervisorはAdmissionRecordを要求するが、検証objectと実行objectを同一にするprimitiveはSpike
3で比較する。

plugin runtimeはdata planeだけに置く。processごとにallowed Envelope
methodsを列挙し、Revision、Admission、evaluation、approval、promotion、rollbackのcontrol-plane
methodを公開しない。authorityはaction別に、Intake=`RevisionTicket`、Admission=sealed Proposal
ID、Evaluation=`AdmissionRecord + EvaluationRequest`、Approval=`ApprovalChallenge`、Promotion=`ApprovalRecord + expected DeploymentState`、Rollback=rollback専用human
approval + expected generationとする。相互流用を許さない。

## Accepted subsetと保証範囲

初期subsetはsingle TypeScript fileで、static import、`export ... from`、dynamic import、type-only
import、npm、JSR、remote URL、`file:`、absolute/parent path、CommonJS
loader、Worker、`importScripts`、triple-slash reference、source map、外部Wasm/native addon/build
pluginなど、外部moduleまたはfile解決へ至るsyntax/inputを許可しない。未知・未対応のsyntax、directive、media
type、dependency経路はfail closedとする。

checkerは単純な文字列検索ではなくpinned syntax-aware
parserを使い、commentや文字列中の`import`等のbenign
lookalikeを有害構文と混同しない。保証は「外部module closureが空であり、CPU、wall
time、memory、stdout/stderr、message、同時実行数を制限した実行でruntime
authorityがない」ことまでで、source
logicの善性や価値は保証しない。checker、parser、compiler、runtimeの具体的製品選定や実装方式はこのbriefでは確定しない。

## 段階的gate

gateはv1完成条件ではなく、次段へ進むかを判断する観測条件である。

### Spike 0: Definition roundtrip — no AI / no execution

- 実証対象はDefinitionContentだけとし、DefinitionRevisionの発行・登録lifecycleを合格根拠に含めない。
- no-op mutationをexact baseへ解決したDefinitionContent hashがbaseと一致する。
- source、manifest、contract、plugin-owned tests、config、requested capabilitiesのfield
  ownerが重複なく一意である。
- hidden fieldがbaseから保持され、AI入力への往復を要求しない。
- unknown fieldを拒否し、defaultとnormalizationを適用したcanonical
  encodingが反復・別runでも同じbytes/hashになる。
- artifactからDefinitionを逆生成せず、current/DeploymentState writeが0である。

### Spike 1: AI Definition Proposal — no execution

- `RevisionTicket`のtarget、exact base、allowed field/path、full-replacement
  mutation、budget、evidence scopeをAIが変更できない。
- Revision Serviceがhidden fieldをhost側で保持し、ProposalをResolved Candidate
  DefinitionContentへmergeする。
- resolved content seal時にcandidate DefinitionRevision
  ID/digestを発行し、同contentの別revisionをbase/provenance/IDで区別する。
- rejected proposalはproposal/rejection historyだけに残り、DefinitionRevision
  registryへのcandidate登録が0である。accepted revisionもcurrent化が0である。
- AI、人間、第三者、legacyの各originでoriginal hash、normalizer digest、host-assigned plugin
  ID/namespaceが残る。
- stale base、unknown field、scope/budget超過をrejectし、fuzzy applyと自動rebaseが0である。
- current filesystem、definition/deployment registry writeが0である。

### Spike 2: Admission — no candidate execution

- Builderはsealed Proposal IDだけを受理し、raw source、任意path、偽・期限切れticket、legacy direct
  installを拒否する。
- 正常candidateはpinned parser/compiler/runtime、空build directory、config/import
  map/cache/networkなしで外部module closure空になる。
- comment/string内のbenign lookalikeは誤拒否せず、static/dynamic/type-only
  import、absolute/`../`/`file:`、npm、JSR、remote、unsupported
  directiveなどの逸脱candidateはartifact生成前に拒否する。
- rejected candidateはprocess起動0、broker call 0、artifact publish 0、admission registry write
  0である。
- AdmissionRecordがDefinitionRevision ID/digest、DefinitionContent hash、Builder
  content/dependency、profile/policy、parser/compiler/runtime、closure、artifactの各digestを固定する。
- artifact publishはcontent-addressed、create-only、atomicであり、同一addressの上書きが0である。
- trusted registry writer以外からAdmissionRecordを登録できず、artifact
  hashだけではadmittedにならない。

### Spike 3: Artifact / hash / bounded run

- SupervisorがAdmissionRecordとartifactを照合する。same-object primitiveとしてcreate-only
  store+ACL、private per-run materialization、pathless方式、限定threat
  modelを比較し、検証後の差替えやpath再解決を閉じられるか観察する。
- どの候補でも境界が成立しなければ、同じprocess方式を続けずOS
  sandbox/containerを次の判断分岐とする。
- artifactはread、net、env、run、FFI、write authorityなしで最小`text-transform`応答を返す。
- CPU、wall time、memory、stdout/stderr byte、message
  size、同時実行limitの超過をhostが停止・記録する。
- runtime processのallowed Envelope methodsはdata
  planeに限られ、Revision、Admission、evaluation、approval、promotion、rollback callが0である。
- action-specific authorityのcross-useが0である。
- source/closure/artifactとparser/compiler/runtime/environment
  digest、process/broker到達を追跡できる。

### Spike 4: Plugin v1 → v2 shadow cycle

- current v1とcandidate v2を同じruntime authority、resource
  budget、入力条件で実行し、current/DeploymentStateを変更せず並べられる。
- admission後のsource、artifact、evaluation input差替えを拒否し、同じimmutable identityを追跡する。
- base DeploymentState generation/state
  digestが変わればstale/conflictとなり、approval再利用、自動rebase、promotionが0である。

### Spike 5: Evaluation / human promotion / rollback

- public contract、plugin-owned tests、private holdoutを分離する。holdout corpus、expected
  output、他case、内部rubricはAI、Revision View、artifact、plugin
  runtimeから不可視だが、各runの単一inputはcandidateへ渡る。
- holdoutはspawn-per-runでpersistent
  stateを持たせず、current/candidateを同じrubric、evaluator、dataset、model/runtime条件で比較し、attempt/feedback
  limitを強制する。
- EvaluationRecordが対象Definition/Admission、rubric/evaluator/public/plugin/private
  dataset、environment、attempt/feedbackの各digestと結果を固定する。
- evaluatorはpromotion capabilityを持たない。
- trusted UI/CLIだけがApprovalChallengeを表示・確認し、DefinitionRevision ID/digestとcontent
  hash、exact AdmissionRecord、EvaluationRecord、promotion manifest、base
  DeploymentStateへ結合したopaque ApprovalRecordを発行できる。
- policy、endpoint registry、interpreter変更もDeploymentState
  transitionとしてgenerationを進める。promotion直前にlive effective
  digestを再計算し、ApprovalRecord/base stateと一致しなければ拒否する。
- Supervisorは`ApprovalRecord + expected DeploymentState`でdeployment generation/state
  digestをCASし、mismatch、replay、trusted component/schema更新後の旧approvalを拒否する。
- rollbackはrollback専用human approvalとexpected
  generationを要求し、過去に承認されたDeploymentState全体を新generationとして復元する。現policyに不適合なら拒否する。

## TCBと観測証拠

TCBとしてSupervisor、Revision Service、Admission Builder、pinned
parser/compiler/runtime、definition/artifact/admission/deployment registry writer、approval
UI/CLI、runtime broker、trusted recorderを列挙する。これらとschemaは人間管理のharness
releaseで更新し、影響する旧Admission/Evaluation/Approvalを失効させる。schema
migrationはversion、変換証拠、rollbackを観測する。

残す証拠は、各object/action authority/recordのidentityとdigest、revision lifecycle、全candidate
originとintake結果、拒否理由、process・broker・registry到達回数、current/deployment write、resource
limit、same-object候補比較、live
policy/registry/interpreter照合、approval/CAS/rollback結果である。Supervisor単体の行数だけでなく、総TCB
source量、dependency closure、権限、更新頻度、運用複雑性を記録する。

## 旧資産

- retain: 論理Envelope、`endpointId + operationId` broker境界、human-owned policy、append-only
  traceの概念と観測証拠。
- conditional: 旧`model-adapter`と`task-planner` sourceはuntrusted pluginとしてcommon Candidate
  Intakeから再投入する。RunnerはTCB release candidateとして、人間review、dependency pin、trusted
  update手続を通す場合だけ使う。
- discard: source直接実行、permission flagだけのstatic graph隔離、artifact
  hashだけのAdmission/approval/current identity、legacy direct load/install。

legacy plugin sourceもorigin/original hash/normalizer digest付きで再intakeする。Runnerはplugin
Admissionで安全化したとは扱わず、trusted権限、provider知識、direct load経路、dependency
closureを人間がreviewする。

## 対象外

- v1の完成像と完了条件、正式planner input、production実装計画
- 汎用plugin framework、package manager、dependency resolver
- `model-adapter`/`task-planner` provider smoke再開
- npm、JSR、remote dependency、multi-module、tool、filesystem変更、persistence
- third-party marketplace、PKI、signed manifest、署名者管理の本実装
- promotion自動化、self-promotion、Deno Worker、Wasm、container実装。same-object不成立時のOS
  sandbox/container比較判断は対象に含む
- 詳細API、file構成、test case、実装順、具体checker製品の確定

## 次の判断

Spike 0から一段ずつ、次段へ進む、同段を狭める、別隔離方式へ方向転換する、trusted fixed
codeへ縮小する、保留・終了する、を比較する。Definition/Artifactが循環する、revision
lifecycleが曖昧、field ownerやcanonical hashが決まらない、hidden
fieldをAIへ返させる、currentへwriteできる、Builderへraw source ingressが残る、artifact
hashだけでAdmissionになる、action authorityを流用できる、same-object境界が成立しない、holdout
corpus/expected/他case/internal rubricが漏れる、live policy
digestを再照合できない、総TCBが監査不能なら後段へ自動的に進まない。same-objectが成立しない場合はOS
sandbox/containerを明示的に比較する。

次の問いは「v1へ進めるか」ではなく、「Definitionを正本とする自己改訂cycleを、小さく監査可能な境界として成立させられるか」である。
