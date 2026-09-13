# Increment 51 — managed Henji base instruction

ステータス: **完了**

基準commit: `d632367e`

計画日: 2026-09-13

対象候補: E1の最初のresource kind、R4の前段基盤

## 利用者が必要とする動作

- Henjiの基本的なinstructionは`instruction:henji-base`という一つのsemantic
  slotとして扱う。
- coreは、外部resourceが選択されていない状態でもHenjiを起動できるbuilt-inのbase
  instructionを持つ。
- 人間は外部のHenji Instruction packageをmanaged storeへinstallし、そのexact
  revisionを明示的にactivateすることで、 built-in base
  instructionだけを置き換えられる。
- 外部revisionをdeactivateすると、次のWorker generationからbuilt-in base
  instructionへ戻る。
- base instructionを置き換えても、default/planner role、active tool
  guideline、workspace `AGENTS.md`、Skill manifest、 runtime
  factsは失われず、Henjiが従来の順序で最終system instructionへ合成する。
- 実際に使用したbuilt-inまたはexternalのexact base instruction
  revisionとcontentを、executionのcontext attribution、 history detail、provider
  requestとの関係からreadbackできる。

このIncrementでいうbase instructionは、default Agent Definitionのrole
instructionではない。Worker generation開始時に解決され、 そのgenerationの各model
requestに使うsystem instructionの先頭へ合成されるHenji共通componentである。

## 利用者が承認した方針

- 外部化の最初の対象をHenji base instructionとする。
- folderまたはresourceの意味を`default-role`とは呼ばない。
- coreにはbuilt-in fallbackを残し、external exact revisionで同じsemantic
  slotを置き換えられるようにする。
- import/installによるlocal
  custodyと、実行に使うrevisionのactivationは別の状態として扱う。
- Henji独自resourceであるため、format固有のmetadataを持てる。JSON、YAML、TOMLのいずれかに固定すること自体は
  利用者要件ではない。
- Agent Definition、planner、非同期subagent、tool
  component、`web_search`の外部化は別途検討する。

## 計画で採用する具体化

### 1. semantic identityとbuilt-in fallback

- semantic
  slotは`instruction:henji-base`とする。`instruction:role:default`、`default-role`、`startup-prompt`とは呼ばない。
  startup時だけ消費されるpromptではなく、Worker generation全体のmodel
  requestに使われるためである。
- managed resource kindは`henji-instruction`とし、native
  `AGENTS.md`、native/managed Skill、Agent Definitionとは 別kindにする。
- built-in fallbackにもcontentとinstruction API contractから計算したexact
  revision identityを与える。built-in contentを managed
  storeへ複製せず、現binaryが所有するcontentとして解決する。
- external revisionは利用者が付ける`resourceId`とSHA-256 revisionからなるexact
  `ManagedResourceRef`で識別する。 active bindingとexecution attributionへsource
  pathやXDG physical pathを含めない。

### 2. authoring package v1

初期authoring
contractはdirectoryとし、例示folder名を`henji-base/`とする。folder名自体はidentity
authorityにしない。

```text
henji-base/
├── henji-resource.json
└── instruction.md
```

`henji-resource.json`はDenoが追加parserなしで厳密に読め、prompt本文をJSON
escapeへ埋め込まずに済むため、初期formatを
JSONに固定する。YAML/TOMLの同時対応やformat自動判定は追加しない。将来別formatを採用しても、managed
manifestと exact revision identityは同じ意味を維持する。

概念schemaは次とする。property名とvalidationの最終形は実装前のarchitecture承認後に、このIncrement内で固定する。

```json
{
  "schemaVersion": 1,
  "resourceKind": "henji-instruction",
  "resourceId": "example/henji-base",
  "slot": "instruction:henji-base",
  "apiContract": "henji-instruction-v1",
  "format": "text/markdown",
  "entry": "instruction.md",
  "metadata": {
    "title": "Example Henji base instruction",
    "description": "Base working policy for this Henji installation"
  }
}
```

- v1は一つのUTF-8
  `instruction.md`だけをcontentとし、import、include、template、variable展開、実行可能codeを持たない。
- `resourceKind`、`slot`、`apiContract`、`format`、entry
  path、metadata、instruction exact bytesをcanonical revision digestへ
  含める。表示metadataだけを変更した場合も別exact revisionになる。
- `instruction.md`はfatal UTF-8 decode後に同じUTF-8
  bytesへencodeでき、NULを含まず、`trim()`による検査で空でない
  ことを要求する。ただし検査後のcontent自体はtrim、改行変換、Unicode
  normalizationを行わず、exact source bytesと byte-equivalentなdecoded
  stringをmanaged revisionとmodel向けcomponentのauthorityにする。
- component間にHenjiが挿入する二つのLFはcomposition boundaryであり、base
  component contentには含めない。
  末尾改行やCRLFだけが異なるsourceは異なるrevisionかつ異なるprojected
  contentとして扱う。
- source absolute path、install日時、XDG rootはorigin lineage/local
  custodyとして分離し、portable revision digestへ 含めない。
- `metadata.title`と`metadata.description`は人間のlist/inspect用であり、modelへ自動注入しない。

### 3. install、activation、deactivation

- kind固有のprovider-free
  CLIとして、少なくともinstall、list、inspect、active、activate、deactivateを提供する。
  command名は`henji instruction ...`を第一候補とし、Agent
  Definition用の既存`module` commandへ混在させない。
- この計画では、外部source directoryからlocal
  custodyへ取り込む操作をinstallと呼ぶ。別installationからtransport
  artifactを取り込むimportは、このIncrementの対象に含めない。
- installはauthoring packageを検証し、exact revisionとcustodyをXDG data
  rootのmanaged storeへatomicにpublishするだけで、 active
  binding、実行中Worker、Sessionを変更しない。同じcontentの再installは同じrevisionを返し、最初のcustodyを保つ。
- activateはmanaged storeに存在して検証できる`instruction:henji-base`用exact
  revisionだけを、installation/user scopeの active bindingとしてXDG
  configへatomicに保存する。workspace scopeはnative
  `AGENTS.md`が担うため追加しない。
- deactivateは人間の明示commandによりexternal bindingを外し、built-in
  fallbackを選択状態にする。managed revision 自体は削除しない。
- active bindingに指定されたexternal revisionがmissingまたはinvalidなら、Worker
  generation開始前にexact ref付きの typed
  failureを返す。選択identityと実行contentが食い違うためbuilt-inへ暗黙fallbackしない。

### 4. generationへの適用

- activate/deactivateは既に動いているWorker generationとactive
  turnを変更しない。操作後に作る次のWorker generationで active
  bindingを解決する。
- 次のgenerationには、新しいSession、`/new`で作るSession、process再起動後にreopenするSessionを含む。
  これは人間が明示したinstallation-wide binding変更の結果である。
- 現Sessionのconversation、未送信draft、過去execution、過去context
  attributionを書き換えない。
- 実行中Henjiの現Sessionを保ったまま新しいbase
  instructionへ切り替える`/rebuild`、generation transition receipt、
  binding変更のprocess間通知はこのIncrementに含めない。

### 5. system instruction合成とattribution

- Hostが解決したbase ref/contentは、Agent
  Definition評価結果とは独立したdata-only Worker-core入力にする。
  `ExecutableAgentDefinition`が返したcompositionだけをeffective
  compositionとして実行せず、Worker coreの一つの必須 finalizerがselected
  baseを適用した後のcompositionだけを`WorkerRuntime`へ渡す。
- Definitionが返す`systemInstruction`と`instructionComponents`は、baseを除くDefinition-owned
  contributionとして扱う。 built-in helperはHenji
  baseを自分で合成せず、role、active tool guideline、workspace
  instruction、Skill manifest、 runtime
  factsからなるremainderを返す。Definitionのnamed componentがcore-owned
  `instruction:henji-base` slotを宣言した 場合はcomposition
  failureとし、同じslotを二重に持つeffective compositionを作らない。
- mandatory finalizerは、selected
  `instruction:henji-base`を先頭に置き、その後へDefinition-owned contributionを
  component境界の二つのLFで連結する。base textをtrimまたはnormalizeせず、final
  system instructionとbase componentの byte
  rangeを一意に対応付けられるようにする。
- root compositionだけでなく、Henjiの`subagent:planner`として実行するdelegated
  plannerも、model requestを作る前に 同じselected baseと同じmandatory
  finalizerを通す。planner handler内で別のbuilt-in
  baseを再解決または再合成しない。
- external Definitionがbuilt-in
  helperを使うか、opaqueな`systemInstruction`だけを返すかにかかわらず、Henjiが実行する
  rootのeffective system instructionにはselected baseが一度だけcore-owned
  componentとして入る。opaque contribution内に
  利用者が同じ文章を記述することは別contentであり、Henji base
  slotの二重selectionとは扱わない。
- 現行の実効合成順は、selected base、role、active tool guideline、workspace
  instruction、Skill manifest、runtime factsとする。 external baseは最終system
  instruction全体を返さない。このIncrementではplanner
  Definition自体を外部化しない。
- resolved composition/manifestはsemantic slotだけでなくselected exact
  managed/built-in refを説明できるようにする。 Workerへ渡したexact
  bytesとbyte-equivalent text、content digest、slot、selection source、final
  system instruction内の projectionをcontext attributionへ記録する。
- providerへ送った最終system instruction、base
  component、他componentのidentity/content関係を、既存history v4の normalized
  context
  factからreadbackできるようにし、完成payloadの重複authorityを追加しない。

## architecture正本の変更案

実装前に[`../architecture/henji-host-agent-worker.md`](../architecture/henji-host-agent-worker.md)へ、次の意味変更を
反映する必要がある。利用者の明示承認を得るまでは正本を変更しない。

1. `henji-instruction`を最初のDefinition以外のmanaged resource
   kindとして採用する。
2. `instruction:henji-base`のbuilt-in/external二層、installation/user
   scopeのactive binding、Hostによるgeneration前の exact
   resolution、Workerによるfinal system instruction合成を責務として確定する。
3. Host-resolved
   baseをDefinition評価結果とは独立したWorker-core入力とし、rootとdelegated
   plannerがmodel request前に通る mandatory finalizerだけがcore-owned base
   slotをeffective compositionへ適用する。Definitionはbaseを除くinstruction
   contributionを所有する。
4. authoring exact bytes、byte-equivalent projected
   component、Henjiが挿入するcomposition separator、final system instructionの
   関係を明示し、source/revision/custody/active binding/execution
   attributionを別authorityとする。
5. installとactivateを分け、selected external revisionのresolution
   failureではbuilt-inへfallbackしない。
6. native `AGENTS.md`/Skillを置換せず、外部base
   instructionをその前段componentとして合成する。
7. activationは次のWorker generationから適用し、active generationのhot
   replacementと`/rebuild`は未実装のまま残す。

構想[`../concepts/experience-driven-self-revision.md`](../concepts/experience-driven-self-revision.md)の目的と、人間だけが
candidateを採用する境界は変更しない。このIncrementはAIによるcandidate生成・採用flowをまだ実装しない。

## roadmap正本の変更案

実装前に[`../roadmap.md`](../roadmap.md)へ、次を反映する必要がある。利用者の明示承認を得るまでは正本を変更しない。

- F03へ、native instruction discoveryとは別authorityとしてmanaged Henji base
  instructionをinstall/resolveする動作を追加する。
- F06へ、built-in/externalのselected base revisionをrole・tool
  guideline・workspace instruction・Skill manifest・runtime factsと Worker-core
  finalizerで合成し、rootとdelegated
  plannerへ必ず適用する動作を追加する。Definitionが返すinstructionは
  baseを除くcontributionであり、effective final system
  instructionのauthorityではないことも明記する。
- F08へ、selected baseのexact ref/content、byte-equivalent component、final
  system instruction内のprojection、provider requestを
  executionから相関してreadbackできる実装状態を追加する。
- managed externalizationの実装順へIncrement
  51を追加し、Definition以外の最初のkindとして位置付ける。
- F24は将来のexperience-driven
  candidate生成・採用対象拡張として残し、このIncrementの人間による直接install/activateを
  Self-revision Cycle完了と扱わない。
- F27の`/rebuild`は未実装のまま残し、Increment
  51のactivationは次generationだけを対象にする。

## 実装順序

1. 承認済みの意味変更をarchitectureとroadmapへ反映し、`instruction:henji-base`のauthority、scope、lifecycle、合成順を
   正本化する。
2. Henji Instruction v1のauthoring manifest codec、canonical revision
   identity、origin/custody、kind固有managed storeを実装する。
3. provider-freeなinstruction install/list/inspect/active/activate/deactivate
   CLIと、XDG data/config pathを接続する。
4. Hostが次のWorker generation前にbuilt-inまたはactive external exact
   revisionを解決し、data-only ref/exact bytes/textを
   Definition評価結果と独立したWorker-core入力として渡す。external selection
   failureをstartup前のtyped failureとして返す。
5. Worker coreにmandatory instruction finalizerを置き、Definition
   contributionへselected baseを一度だけprependする。 built-in root、external
   root、delegated plannerの全production pathをこのfinalizerへ接続する。
6. instruction authoring bytes、managed content、component
   textをbyte-equivalentに保ち、final compositionのseparatorだけを Henji-owned
   boundaryとして追加する。
7. resolved manifest、bootstrap/context attribution、history detailへselected
   ref、content digest、exact content、final system
   instruction内のprojectionを接続する。
8. focused verification、compiled standaloneでのproduction経路確認、stable
   candidateへのauthoritative `v0:gate`一回を行う。

## Verificationと成功条件

- built-in bindingだけの既存利用では、現在のHenji base
  instruction本文とcomponent順が変わらない。
- external packageをinstallしてもactive
  bindingと実行中generationは変わらず、list/inspectからmetadata、origin、custody、exact
  ref、 content digestを確認できる。元sourceを変更・削除してもmanaged exact
  revisionを解決できる。
- exact revisionをactivateして次generationを起動すると、そのexternal
  contentだけがbase slotへ入り、built-in base本文は入らない。 role、tool
  guideline、workspace instruction、Skill manifest、runtime
  factsは従来の順序で一度ずつ入る。
- built-in root、external root、delegated plannerのmodel
  requestがすべて同じselected exact baseを先頭componentとして持つ。 external
  Definitionがnamed componentを返さない場合もbaseは欠落せず、base
  slotを自ら返した場合は実行前に拒否される。
- authoring `instruction.md`、managed revision、context attributionのbase
  contentをencodeしたbytesが一致する。providerへ送る final system
  instructionではbase
  content自体を変更せず、その直後にHenji-ownedな二つのLFとDefinition
  contributionが続く。
- deactivate後の次generationはbuilt-in baseへ戻り、external managed
  revisionはinspect可能なまま残る。
- missing/corrupt/incompatibleなactive exact refではprovider request、Session
  mutation、Worker実行前にfailureとなり、built-inを 実行したように見せない。
- built-in/externalの各実行で、実際のselected ref、slot、content
  digest、content、最終system instructionとの関係をhistoryと provider request
  attributionから確認できる。
- compiled standalone binaryとisolated XDG
  rootsでinstall、activate、source削除後の起動、deactivateを確認する。
- external
  instructionへ識別可能だが通常taskを妨げない指示を置き、実providerを使う一つのproduction
  turnでそのinstructionが 実際に適用された回答とcanonical
  commitを確認する。実provider使用は実行前に利用者の許可を確認する。
- 変更箇所のfocused test、必要なtype
  check、format、lint、`git diff --check`を実行し、安定候補に対するauthoritative
  `v0:gate`を一回だけ実行する。

## 対象外

- default/planner Agent Definition、planner delegation、非同期subagent、tool
  component、`web_search`の外部化
- final composed system instruction全体のexternal replacement
- default/planner role instructionの外部化、複数instruction
  slot、layer/priority、workspace-scope override
- YAML/TOML authoring、複数file/include/template/variable、実行可能instruction
  code
- Henji Instruction transport export/import、remote registry、package signing
- `/rebuild`、active Worker generationのhot
  reload、process間notification、Sessionごとのinstruction binding
- AIによるcandidate生成、人間向けcandidate比較・採用、rollback
  historyを含むSelf-revision Cycle
- managed revisionの削除、既存data migration、converter、compatibility
  read、fallback
- architecture・roadmap・構想の承認外変更
- commit、push、tag、publish、release、導入済みbinaryの置換

## 規模見積り

Agent Definitionで得たmanaged
identity/storeの一部を再利用できるが、新しいdata-only authoring contract、active
binding、 Worker bootstrap、composition、history
attributionを一続きで接続する必要がある。architecture/roadmap更新、実装、focused
verification、production受入までを**4〜7開発日相当**と見積もる。transport、`/rebuild`、複数slotを分離することで、
最初の外部化resourceとして完結する範囲に保つ。

## Human Gate

実装へ進む前に、利用者は次を確認・承認する。

1. 上記architecture正本の意味変更案。
2. 上記roadmap正本の機能・実装順変更案。
3. JSON manifest + separate
   `instruction.md`、`instruction:henji-base`、installation/user scope
   bindingという具体化。
4. Host-resolved
   baseをDefinition外のWorker-core入力とし、root/planner共通finalizerで必ずprependする合成authority。
5. `instruction.md`をtrim/normalizeせずbyte-equivalentにcomponentへ投影し、二つのLFだけをcomposition
   boundaryにするcontent契約。
6. activationは次のWorker
   generationへ適用し、`/rebuild`とtransportは別Incrementにする対象範囲。
7. この計画全体と、安定候補で実provider production turnを一回行う検証水準。

2026-09-13、利用者は上記7項目、architecture・roadmap変更案、Increment
51の計画を承認した。 実provider production
turnは計画どおり実行直前に別途許可を確認する。

2026-09-14、利用者は実provider production turn一回の実行を許可した。

## 実装・検証結果

- architectureとroadmapへ承認済みのauthority、lifecycle、合成境界を反映した。
- `henji-instruction-v1` authoring package、content-addressed managed
  store、installation/user scope
  bindingと`henji instruction install/list/inspect/active/activate/deactivate`を実装した。
- Hostは各Worker generation前にbuilt-inまたはactive external exact
  revisionを解決し、Worker coreのmandatory finalizerがrootとdelegated
  plannerへbaseを一度だけprependする。Definitionはbase抜きcontributionを返し、
  core-owned slotの宣言は拒否する。
- exact contentとselected ref/content digest/sourceをstartup snapshot、execution
  artifact、SQLite context fact、 provider request内のbyte
  projectionからreadbackできる。external bindingがmissing/corruptならSession
  state作成前に exact ref付きで失敗し、built-inへfallbackしない。
- focused
  testはbuilt-in/external、source削除後のcustody、installとactivationの分離、opaque
  Definition、root/planner、
  `/new`の次generation切替、deactivate、起動前failure、exact history
  attributionをproduction Worker経路で確認した。
- authoritative `v0:gate`は2026-09-14に一回実行し、Increment 13の旧fake Worker
  fixtureが新しいready manifestの
  `baseInstruction`を返さない一件で停止した。fixtureを現protocolへ更新後、full
  format/lint、変更対象type check、 Increment
  13/39/40と停止位置以降の全taskをfocusedに実行してすべて成功した。gate自体は反復していない。
- 現sourceからcompiled standalone `henji`を作り、isolated XDG rootsでexternal
  revisionのinstall、install直後は built-inのままであること、activate、authoring
  source削除後のactive/inspect、credential解決まで進むWorker起動、
  deactivate後のbuilt-in復帰とmanaged
  revisionの存続を確認した。外部requestはcredential不在で0件だった。
- 利用者の直前許可後、同じ現sourceのcompiled standaloneをpersistent production
  TUIとして起動し、external revision
  `acceptance/real-provider-base@sha256:c27fc5b881ca275e7eccface4496e6d443292687ab1761d9e6f9fa388b91fdb7`
  （content digest
  `sha256:3dd62755406427e1942267d554d35982cdb125a7830f50c41a0efff97cfff742`）を使う一turnを
  OpenRouterへ送った。回答は指定した`I51-EXTERNAL-ACTIVE`で始まり、provider
  requestは1、tool callは0だった。
- SQLite readbackではexecution
  `a9f47439-d04f-4886-9fd9-3c7809de7069`が`settled`、`completed`、`canonical`、
  committed revision 2、context capture `complete`だった。request 1のsystem
  itemは同じexternal exact ref、content digest、
  `#bytes=0-208`を`instruction:henji-base`のprojectionとして保持し、artifactもprovider
  request count 1とcanonical commitを 記録した。
- 実provider確認後は一時bindingを除去し、isolated active
  selectionがbuilt-inへ戻ったことをreadbackした。実credential値は
  表示・copy・logせず、temporary config
  linkも除去した。commit、push、release、導入済みbinaryの置換は行っていない。
