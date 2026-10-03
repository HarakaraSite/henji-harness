# Increment 33 — local managed Agent Definition revision

ステータス: **利用者確認済み・完了（2026-09-12）**

基準commit: `988022ba`

対象機能: F06、F07、F09

## 利用者が必要とする動作

- 任意pathのTypeScript Agent DefinitionをHenjiのmanaged dataへinstallし、そのexact revisionを選んで
  新しいSessionまたは非対話turnを開始できる。
- module ID、parent/planner role、entry、local source closure、API contract、exact revision、origin lineage、
  local custodyを混同せずlist/inspectできる。
- install後に元sourceとrelative dependencyを変更または削除しても、managed store内の同じexact revisionから
  process再起動後に実行できる。
- external Definitionもbuilt-inと同じWorker bootstrap、protocol、AgentComposition、atomic commit経路を使い、
  通常taskを完了できる。
- 選択したrevisionが欠損、破損、または現在binaryとAPI非互換なら、別revisionやbuilt-inへ黙ってfallbackせず、
  exact refと失敗理由を確認できる。

## 根拠と確認済みの現在地

- architecture正本は、Agent Definitionを最初のmanaged resource kindとし、source取込、self-containedなlocal
  module closure、immutable revision、logical refとphysical descriptorの分離、installとactivationの分離を
  要求する。
- roadmap正本はIncrement 33をF06、F07、F09へ割り当て、static relative `.ts` import/exportとembedded
  `@henji/agent`、parent/planner root、local install/list/inspect、exact revisionからの新規実行を範囲とする。
- Increment 32でstandalone binary、XDG data root、`ManagedResourceRefV1`、built-in
  `DefinitionRevisionRef`、build/Definition attribution、unified CLIが実装済みである。現在の
  `DefinitionRevisionRef` validatorとWorker session factoryはbuilt-inだけを受け入れ、data rootにはmanaged
  storeをまだ作らない。
- 現行HostはWorker起動前にbuilt-in entry一fileのbytesとSHA-256を読み、Workerは同じfileをimport直前に
  再照合する。Session v6、execution artifact v2、provider evidence v2へ永続化するのはlogical Definition refで、
  physical module URLは永続化しない。
- 導入済みDeno 2.9.4のlocal probeで、compiled binary内のDeno Workerがruntime filesystem上の外部`.ts`と
  relative `.ts` dependencyをcomputed file URLからimportし、compile時に埋め込んだbare API specifierも同じ
  module graphから解決できることを確認した。repository checkoutやDeno subprocessをruntimeに必要としない。
- [Deno modules公式文書](https://docs.deno.com/runtime/fundamentals/modules/)は、computed dynamic importが
  runtimeでlocal fileを読む場合にread permissionを使うことを示す。
  [Deno compile公式文書](https://docs.deno.com/runtime/reference/cli/compile/)は、compiled programがDeno runtimeを
  内包し、runtime permissionをcompile時に固定することを示す。
- module closure解析候補として、Deno CLIと同じgraph logicを公開する
  [`@deno/graph@0.111.0`](https://jsr.io/@deno/graph/doc)と、static/dynamic importを字句解析する
  [`es-module-lexer@3.0.2`](https://www.npmjs.com/package/es-module-lexer)を、isolated cacheからDeno 2.9.4の
  compiled binaryへ組み込んで実行できることを確認した。実装ではexact versionを`deno.lock`へ固定する。

## Product contract

### 1. CLIとselection

unified CLIへ次を追加する。

```text
henji module install <entry.ts> --id <module-id> [--role parent|planner] [--root <directory>]
henji module list
henji module inspect --id <module-id> --revision sha256:<full-digest>

henji [TUI flags] --definition-revision <module-id>@sha256:<full-digest>
henji run [--task <text>] --definition-revision <module-id>@sha256:<full-digest>
```

- `module install`の`--role`既定値は`parent`、`--root`既定値はentryの親directoryとする。entry、root、idは
  install入力であり、runtime selectorには使わない。
- external selectorはfull 64桁SHA-256だけを受け入れる。短縮digest、暗黙の`latest`、module IDだけのselectorは
  設けない。
- `--agent default|planner`はbuilt-in selectorとして維持し、`--definition-revision`とは同時指定しない。
  external root roleはrevision manifestが決め、CLIから二重指定しない。
- 新規Sessionは明示selectorのexact refへbindする。`--continue`は選択したexact refとroleに一致する直近Sessionを
  開く。`--session <id>`は保存済みSessionのexact refをauthorityとして解決し、selectorも指定された場合だけ
  一致を要求する。
- `module list`はinstallation内の全external revisionについてlogical ref、role、entry、API contract、file数、
  custody summaryをJSONで返す。`module inspect`はidentity manifest、origin lineage、local custodyを別fieldとして
  JSONで返す。physical store pathはdiagnostic情報として表示できるがlogical refへ混ぜない。
- install/list/inspectはprovider、credential、workspace Session stateへ触れない。成功はstdoutへ一つのJSON、失敗は
  stderrへ`ok: false`、typed code、messageを持つ一つのJSONを返す。

### 2. Definition identity manifest

external DefinitionでもIncrement 32の`ManagedResourceRefV1` envelopeを使う。

```text
DefinitionRevisionRef
  schemaVersion: 1
  resourceKind: agent-definition
  resourceId: <exact module ID>
  revision:
    algorithm: sha256
    digest: <full lowercase hex>
```

- external `resourceId`は利用者が指定したmodule IDのexact UTF-8値とする。case foldingやUnicode normalizationを
  行わない。空文字、ill-formed Unicode、built-inが所有する`builtin/default`と`builtin/planner`はexternal IDに
  使わない。
- structural `DefinitionRevisionRef` validatorはexternal resource IDも表現できるようにする。external refの存在、
  role、contract、contentのauthorityはmanaged storeのidentity manifestであり、structural validatorへ
  install状態を混ぜない。
- portable identity manifest v1はlogical ref、domain/closure schema、declared role、
  `henji-agent-definition-v1` contract、entry relative path、空のexact managed resource binding list、closure file
  descriptor、sourceから導出したdependency lineageを持つ。
- 各file descriptorはcanonical relative path、exact byte length、SHA-256を持つ。entryと全fileのexact bytes、role、
  contract、entry path、空binding listをcanonical revision digestへbindする。dependency lineageはsource bytesから
  導出できる説明用projectionであり、別のidentity authorityにしない。
- digest payloadは統合設計で決定済みの`henji-definition-revision-v1` domain separator、unsigned 64-bit
  big-endian byte length prefix、UTF-8/raw bytes、UTF-8 byte順のpath sortをそのまま実装する。module ID、sourceの
  absolute path、XDG root、install日時、Henji buildはrevision digestへ含めない。
- origin lineageはsource installで指定・解決したentry/root、local custodyは当該installationが最初に保持した日時と
  install方法を表す。両者はdigest外のcustody metadataへ別fieldとして保存し、identity manifestと分ける。

### 3. Source取込とmodule closure

- `@deno/graph@0.111.0`をsyntax/module graph authority、`es-module-lexer@3.0.2`をdynamic import検出の補助に使い、
  両方をexact lockする。runtimeにDeno CLIやTypeScript compiler subprocessを起動しない。
- entryとclosure memberは`.ts` fileだけとする。static `import`、static `export ... from`、type-only static edgeを
  graphへ含める。Increment 33はstatic contractなので、literal/computedを問わず`import()`はinstall時に対象外として
  報告する。
- specifierはrelative pathまたはexact `@henji/agent`だけを受け入れる。remote URL、absolute/file URL、JSR、npm、
  他のbare specifierはIncrement 33ではclosureへ入れない。
- `@henji/agent`はbinaryが提供するexternal edgeとして記録し、closureへcopyしない。要求contractはmanifestの
  `henji-agent-definition-v1`へ固定する。
- default module rootはentryの親directoryで、`--root`指定時はentryをその配下に置く。各relative edgeをURL規則で
  解決し、解決先の実fileがroot内にあることを確認して、source上のrelative layoutをclosureへ保存する。
- install時はDefinition codeを評価しない。graph/syntax、closure、identityを確定して保存し、default exportが
  callableか、評価後manifest roleがdeclared roleと一致するかは、実際のWorker起動経路で確認する。

### 4. Managed storeとatomic publish

managed storeは`resolveRuntimePaths().dataRoot`だけをauthorityにし、概念上次のlayoutを持つ。

```text
<dataRoot>/managed/agent-definition/v1/
  <sha256(resource-id-utf8)>/
    <revision-digest>/
      manifest.json
      custody.json
      files/<canonical-relative-path>
```

- hashed resource directoryはphysical layout用でありlogical identityではない。list/inspect/resolveはmanifest内の
  exact resource IDとdigestを再検証する。
- installはtargetと同じfilesystem上のstaging directoryへclosure、manifest、custodyを完全に書き、全fileと
  canonical revision digestをreadbackした後、revision directoryへatomic renameする。
- 同じlogical refがすでにある場合は既存artifact全体を検証して返し、identity manifestと最初のcustody metadataを
  書き換えない。同じmodule IDでもcontent、role、entry、contractが変われば別revision directoryへ追加する。
- install失敗時の不完全stagingはactive revisionとして列挙・解決しない。revisionは自動削除・自動GCせず、
  `remove` commandもこのIncrementでは追加しない。
- Hostのlogical ref resolverはmanifest、empty binding list、closure全file、canonical digest、current buildのAPI
  compatibilityをWorker生成前に検証し、process-local physical load descriptorを構築する。
- Worker start requestはentry一fileだけでなくclosure descriptorを受け取る。Workerはimport直前にmanaged closure
  全fileを同じdescriptorへ照合してからentryをimportする。logical refへphysical store pathを追加せず、Session、
  artifact、evidenceにも永続化しない。

### 5. Worker、role、tool replacement

- built-in/externalの選択差はHostのlogical resolutionまでに閉じる。Worker bootstrap、Definition evaluation、
  `finalizeRootAgentComposition`、provider/tool loop、proposal/commit/acknowledgementは共通経路を維持する。
- physical load descriptorはbuilt-in entryまたはmanaged closureを表せるunionにするが、Worker側の最終importと
  default export validationは同じ関数へ通す。
- revision manifestのdeclared roleをHost selectionのauthorityとし、Sessionの`agent`は`parent -> default`、
  `planner -> planner`のprojectionとして保存する。Workerが返すeffective manifest roleと一致しなければ、
  revisionを変えずstartup failureにする。
- external parent Definitionはclosure内codeから、既存`@henji/agent` APIが許すbuilt-in toolのsame-identity
  replacementを構成できる。そのreplacement moduleもclosure file/digestへ含める。新tool identityとplanner rootの
  replacement APIは追加しない。
- 初期exact managed resource binding listは空であり、resolved resource graphはroot Definition ref一件である。
  既存のSession turn attribution、execution artifact、provider evidenceに記録するDefinition refが、このgraphの
  root exact refを表す。

### 6. Session再開とfailure readback

- Session v6、execution artifact v2、provider evidence v2のschema numberとlogical field構造は維持し、
  `DefinitionRevisionRef` validationだけをexternal IDへ拡張する。新しいphysical path fieldは追加しない。
- Session allocation前にselectorをexact refへ解決する。既存Sessionはrecordのexact ref、role projection、workspaceを
  検証し、同じmanaged revisionを再解決してからWorkerを起動する。
- missing revision、manifest/content mismatch、unsupported API contract、role mismatch、Definition evaluation failureを
  区別するtyped startup errorをHostからCLIへ運ぶ。TUIはterminal mode取得前、`run`はprovider request前に、exact
  Definition refと具体的なstage/reasonをcredentialなしでstderrへ返す。
- failure時に別revision、同module IDの新しいrevision、built-inへfallbackせず、Session bindingやstore artifactを
  書き換えない。

## 実装slice

### Slice A — canonical identityとmanaged store

1. external resource IDを扱えるref/manifest/custody data contract、canonical byte encoder、Definition revision
   digestを追加する。
2. pinned graph parser/lexerとcustom local loaderでstatic `.ts` closure、relative layout、`@henji/agent` edgeを
   確定する。
3. XDG data root配下のstaging、atomic publish、duplicate verification、list、inspect、exact resolveを実装する。
4. `module install/list/inspect`をunified CLIへ追加し、provider-freeのJSON readbackを成立させる。

### Slice B — exact selectorとSession binding

1. built-in/externalを表すHost selectionとfull revision selector parserを導入し、TUI/runの`--agent`と
   `--definition-revision`を明確に分ける。
2. new/continue/exact Sessionのselection順を更新し、保存済みexternal refからprocess再起動後に同じrevisionを
   解決する。
3. typed resolution/startup failureをterminal取得・provider requestより前にCLIへ返す。

### Slice C — managed closureのWorker実行

1. Host physical descriptorとWorker start protocolをclosure全体へ拡張する。
2. Workerで全fileをimport直前に照合し、managed entryをbuilt-inと同じDefinition evaluation/composition経路へ
   importする。
3. declared role/effective manifest roleを照合し、parentとplannerの両rootを同じSession/commit pathで動かす。
4. Session、execution artifact、provider evidenceの既存build/Definition attributionがexternal exact refでも一致する
   ことを確認する。

### Slice D — product利用と文書

1. two-file以上のparent/planner fixture、same-identity tool replacement fixtureを使い、install、inspect、source削除後
   実行、revision選択、再起動、失敗readbackをfocused確認する。
2. READMEへmodule lifecycle、CLI、XDG custody、static import contract、installとactivationの違いを追記する。
3. stable candidateへ一回だけauthoritative `v0:gate`を実行し、compiled binaryの実provider run/real-TTY受入へ進む。

## 実装checkpoint

### Slice A（2026-09-12完了）

- `DefinitionRevisionRef`をexact external resource IDへ拡張し、portable manifest、origin lineage、local custody、
  canonical revision bytesとSHA-256 identityを実装した。digestはrole、contract、entry、closure file path/bytesをbindし、
  module ID、source absolute path、XDG root、install日時を含めない。
- `@deno/graph@0.111.0`と`es-module-lexer@3.0.2`をlockし、static relative `.ts` closureとembedded
  `@henji/agent` edgeを取込むlocal graph importerを実装した。dynamic import、remote/bare import、root外edgeは
  `module_import_unsupported`としてinstall時に返す。
- XDG data root配下へstaging readback後のatomic publish、duplicate verification、全revision列挙、inspect、exact ref
  resolveを行うmanaged Definition storeを実装した。同じcontentの再installは最初のcustodyを保持し、編集後は
  旧revisionを残して新revisionを追加する。
- unified CLIへ`module install/list/inspect`を追加し、providerやSessionを起動せずJSONでidentity、origin、custody、
  physical diagnostic pathをreadbackする経路を実装した。
- focused testは4件成功した。repository全体の`v0:check`、`v0:fmt`、`v0:lint`、`git diff --check`も成功した。
  Slice中の方針どおり`v0:test`とauthoritative `v0:gate`は未実行である。
- Slice B以降のselector、Session binding、Worker実行は未着手である。

### Slice B（2026-09-12完了）

- `module-id@sha256:<full-lowercase-digest>`だけを受け入れるexternal selectorと、built-in/managedを表すHost
  selectionを実装した。TUI/runの`--definition-revision`は`--agent`と排他であり、short digest、latest相当、
  built-in IDのexternal形式をside effect前にinvalid invocationとして返す。
- managed selectorをXDG data rootのexact manifestへ解決し、manifest roleを`parent -> default`、
  `planner -> planner`へprojectionする。missing、content/manifest mismatch、API非互換をtyped startup errorとして
  exact ref、stage、reasonとともに返す。
- newはexact ref解決後にSessionをallocateし、continueは選択role/refに一致する直近Sessionを開く。
  `--session`は保存済みrecordのexact refをauthorityとして再解決し、明示selectorがある場合だけ一致を要求する。
  保存roleとの不一致も`session_binding` stageで区別する。
- TUIはterminal raw mode取得前、runはstdin probe/readとWorker生成前にresolution failureをJSONで返す。built-inでは
  不要なXDG data rootを解決せず、既存の権限制限されたprovider-free経路を維持する。
- Slice Cの全closure照合を迂回しないため、解決済みmanaged selectionはSession allocate/Worker生成前に
  `definition_execution_unavailable`として一時停止する。Slice Cでphysical descriptorへ接続する。
- Increment 33 focused test 8件、Worker foundation 39件、Increment 13/14/32の関連regression 20件が成功した。
  repository全体の`v0:check`、`v0:fmt`、`v0:lint`、`git diff --check`も成功した。`v0:test`とauthoritative
  `v0:gate`は未実行である。
- Slice C以降のmanaged closure Worker実行、product fixture/README、compiled acceptanceは未着手である。

### Slice C（2026-09-12完了）

- Worker startの物理入力をbuilt-in entryまたはmanaged closureで表せるdescriptorへ拡張した。managed descriptorは
  process-localなfile URL、relative path、byte length、file SHA-256だけを持ち、logical Definition refや永続schemaへ
  physical pathを追加していない。
- Workerはmanaged closure全fileをdescriptorへ照合してからentryをimportし、built-inと同じdefault export validation、
  Definition evaluation、`finalizeRootAgentComposition`、turn proposal/commit/acknowledgement経路へ接続する。
  closure照合完了はprotocol traceの`module_closure_verified`で確認できる。
- manifestのdeclared roleをSession agentへprojectionし、Workerが返すeffective manifest roleと照合する。managed
  parentとplannerはいずれもprovider-freeの実Worker turnを完了し、同じSession v6 commit経路を通ることを確認した。
- closure mismatch、declared/effective role mismatch、Definition evaluation failureは、fallbackせずexternal exact refを
  保った`worker_start` stageのtyped errorとして区別する。
- external turnのSession turn attribution、execution artifact v2、provider evidence v2が同じSession、turn、build、
  exact Definition refで相関することを確認した。Increment 33 focused test 10件と関連built-in regression 59件が成功し、
  repository全体のtype check・format・lint・`git diff --check`も成功した。`v0:test`とauthoritative `v0:gate`は未実行である。
- Slice Dのproduct fixture、README、compiled binary確認、production受入は未着手である。

### Slice D（2026-09-12完了）

- two-fileのparent/planner Definitionとsame-identity tool replacementのproduct fixtureを追加した。CLI経由の
  install/inspect、元source path不在後の旧exact revision実行、編集後の新exact revision選択、別processからの
  exact Session再開、replacement実行を、managed storeと実Worker経路で確認した。
- READMEへmodule install/list/inspect、installとactivationの分離、full exact revision selector、XDG data custody、
  static relative `.ts` closureとembedded `@henji/agent`、missing/破損/API非互換時にfallbackしない契約を追記した。
- Increment 33 focused testは11件成功した。stable candidateに対するauthoritative `v0:gate`は計画どおり一回だけ
  実行し、format、lint、type check、全対象test計165件を含むgateが成功した。
- repository外の一時directoryへstandalone binaryをcompileし、Deno CLIを含まない`PATH`と隔離したXDG
  data/state rootでproduction受入を行った。build ID
  `f1c5ea2699464c64b8a7ed869332b89c45ed3285f7454bb51e44082897de0ee8`のbinaryから、parent旧revision、
  planner real-TTY turn、planner Sessionの別process exact再開、parent新revisionの実provider turnが成功し、各Session、
  execution artifact、provider evidenceのbuildとexact Definition refが一致した。
- managed closureのbyte mismatchとAPI contract非互換を注入し、どちらも別revisionやbuilt-inへfallbackせず、対象の
  exact ref、typed code、resolution stage、具体的reasonを返すことを確認した。受入証拠は
  `/tmp/henji-increment-33-acceptance-XbeQE3`に保持している。source削除相当の確認では元install pathを不在にしつつ
  回復可能にするため、source directoryを同じ一時root内へ移動した。
- 本Incrementのrepository差分とstable `0.1.0` release準備をcommitし、`origin/main`へpushした。
  `@henji/harness@0.1.0`はclean release worktreeからJSRへpublishし、registry metadataとexact version importを確認した。
  installed binaryの置換とGit tagは行っていない。architecture・roadmapの実装状態更新も、正本変更の別承認が必要なため
  行っていない。

## 変更予定領域

- 新規: managed Definition manifest/canonical identity、module graph importer、XDG managed store、module CLI、
  Increment 33 focused test、external Definition受入fixture。
- 更新: unified dispatcher、runtime/TUI argument parser、Host selection/session factory、Worker physical descriptor/
  protocol/bootstrap、managed ref validator、Session codec metadata validation、execution/evidence readback、build dependency
  lock/runtime digest、compile include、README、production E2E。
- 維持: provider adapter、model/effort selection、agent loop、tool execution、native `AGENTS.md`/Skill discovery、canonical
  transcript、atomic turn commit、history export、XDG config/state、credential resolverとcredential非記録。
- 削除しない: built-in default/planner Definition、旧managed revision、Session、evidence、artifact、元source。

## 検証計画

各確認は上記product動作または現行経路の具体的regressionへ対応させる。実装中に`v0:test`や`v0:gate`を繰り返さない。

### Focused確認

- canonical identity: role、entry、contract、いずれかのfile bytesが変わるとrevisionが変わる。同一closureはsource/XDG
  absolute pathが異なっても同じdigestとなり、module IDはdigestでなくlogical refだけを変える。
- graph import: static relative import/exportと`@henji/agent`からtwo-file以上のclosureを作り、dynamic import、remote、
  JSR、npm、root外edgeを対象外として具体的に報告する。
- store/readback: install、duplicate install、list、inspectがidentity/origin/custodyを区別し、source編集後の再installは
  新revisionを追加して旧revisionを残す。
- source independence: 元entry/dependency削除とprocess再生成後もmanaged parent/plannerを起動できる。
- Worker verification: managed closure全fileが一致すると同じbootstrap/commit経路でturnを完了し、検証用copyの
  一file不一致、unsupported contract、role mismatchはexact refを保ったまま起動前または起動時に報告する。
- selection/Session: built-in既存invocationを維持し、external exact selectorでnew/continue/session reopenが同じrefを
  使う。`--agent`との二重指定、short digest、latest相当をside effect前にinvalid invocationとする。
- tool replacement: external parent closure内のsame-identity built-in tool replacementが実行され、そのmodule bytesも
  digestへ含まれる。plannerへreplacementを暗黙伝播しない。
- attribution: external turnのSession v6、execution artifact v2、provider evidence v2が同じbuild ID、Definition ref、
  Session、turnで相関し、physical source/store pathをlogical fieldへ含めない。
- compiled process: source checkout外へ移したbinaryでmodule install/list/inspectと元source削除後のprovider-free
  external Worker起動が、PATH上のDenoなしに動く。

変更に対応するfocused test、`v0:check`、format、lint、`git diff --check`を各sliceで使う。stable candidateだけに
authoritative `v0:gate`を一回実行する。

### Production受入

1. disposable checkoutからcompiled binaryを作り、checkout外の別pathへ移す。
2. isolated `XDG_DATA_HOME`/`XDG_STATE_HOME`と任意workspaceで、two-file以上のexternal parent Definitionを
   `module install`し、list/inspectのidentity、role、entry、closure、contract、origin、custodyを読む。
3. 元source treeを削除し、PATHにDenoを置かない状態でexternal exact refから非対話の実provider turnを完了する。
4. external parentのsourceを変更して再installし、新旧revisionをそれぞれexact指定できることを確認する。
5. external planner Definitionをinstallし、real TTYの同じWorker/TUI経路で一turnを完了する。作成したSessionを
   exact IDでprocess再起動後に再開する。
6. Session、execution artifact、provider evidenceをreadbackし、同じHenji build、external Definition ref、Session、
   turnが相関することを確認する。
7. isolated store内の検証用copyを一file変更した場合と、unsupported contract manifestを持つ検証用copyで、選択ref、
   failure stage/reasonが表示され、built-inや別revisionが実行されないことを確認する。

既存credentialは通常のXDG config resolver経由でのみ利用し、値を表示、copy、log、commitしない。

## 完了条件

- 任意pathのstatic local TypeScript Definition closureをmanaged storeへinstallし、identity、origin、custodyを
  list/inspectできる。
- sourceを変更・削除しても、保存済みexact parent/planner revisionからprocess再起動後に新しい実行を開始できる。
- built-in/externalが同じWorker、protocol、composition、atomic commit経路を使い、外部parentのsame-identity tool
  replacementもclosure-bound codeとして動く。
- duplicate、edit、missing、corrupt、contract-incompatible、role-mismatchの各観測結果が、別identityへのfallbackや
  binding変更なしに合意した意味になる。
- Session、execution artifact、provider evidenceからHenji buildとexternal exact Definition refを相関でき、logical
  identityへmachine/path固有値を混ぜない。
- focused確認、type check、format、lint、`git diff --check`、一回のauthoritative `v0:gate`、compiled binaryの
  実provider run/real-TTY受入が完了する。

## 対象外

- AIから呼べるmodule-install tool、install時の自動activation、既存Session/AgentInstanceのrevision切替、hot reload。
- export/import、remote registry、remove、automatic GC。
- 独立tool、Henji Instruction、managed Skill、model profile、subagent、provider、loop、context、Surface、storage
  backendのresource revision。
- planner rootへsame-identity tool replacementを渡す`@henji/agent` API拡張、新tool identity。
- remote URL、JSR、npm、absolute import、dynamic importを含むexternal Definition closure。
- sandbox/permission modelの新設、trust tierの追加、release automation、tag、publish、binary self-update。
- architecture、roadmapの実装状態更新、repository外のinstalled `~/.local/bin/henji`置換。

## Human Gateと停止条件

- この文書の利用者承認がIncrement 33の実装許可である。承認前にcode、test、README、dependency lock、build taskを
  変更しない。
- 計画承認後は、focused実装・確認、一回のauthoritative `v0:gate`、compiled binaryの実provider run/real-TTY受入まで
  継続してよい。credential値は表示、copy、記録しない。
- repository外のinstalled binary置換、commit、push、tag、publishは別の利用者指示を必要とする。
- Deno 2.9.4のcompiled Workerでmanaged `.ts` closureまたはembedded `@henji/agent` resolutionがproduction
  artifactでは成立しない、canonical identityを変えなければ実行できない、またはarchitecture/roadmap、対象機能、
  外部contract、受入水準を変える必要がある実証を得た場合は、実装を止めて観測結果と代案を利用者へ返す。
