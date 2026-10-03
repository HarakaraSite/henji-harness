# Increment 34 — Definition revision transport

ステータス: **完了 — 利用者確認済み（2026-09-12）**

基準commit: `d570ace0`

対象機能: F07、F25

## 利用者が必要とする動作

- managed storeにある一つのexact Agent Definition revisionを、store directory layoutと独立した一つの
  transport artifactへexportできる。
- artifactを別PCまたは別XDG data rootへimportし、元installationと同じlogical ref、role、entry、closure、
  API contract、origin lineageとしてlist/inspectできる。
- target binaryがAPI contractをsupportする場合は、元sourceなしでimport済みexact revisionから通常taskを実行できる。
- target binaryがAPI contractをsupportしない場合もcustody目的のimportとinspectはでき、実行時にはexact refを保った
  compatibility failureになる。
- artifactにcredential、Session、workspace state、Henji binary、built-in Definition、active bindingを含めない。

## 根拠と確認済みの現在地

- architecture正本は、local custodyとtransportを別contractとし、packageへexact manifestとcontent closureを含め、
  import先がlogical identity、contract、content digestを検証して自身のmanaged storeへatomic publishすることを定める。
- roadmap正本はIncrement 34をF07、F25へ割り当て、Agent Definitionだけのexport/import、origin lineageとimport先
  local custodyの分離、非互換contractのcustody import、異なるXDG data rootでの実行を範囲とする。
- Increment 33でportable identity manifest、source origin lineage、local custody、closure全file、canonical revision
  digest、XDG managed store、atomic publish、exact resolver、module CLIが実装済みである。
- 現行storeのread経路はcurrent API contractとの互換性をinspect/list時にも要求する。Increment 34ではportable artifactの
  構造・identity検証と、現在buildでの実行互換性検証を分離する必要がある。
- 導入済みDeno 2.9.4で`Uint8Array.toBase64()`と`Uint8Array.fromBase64()`が利用でき、任意bytesを追加dependencyなしで
  JSON transportへround-tripできることを実行確認した。

## Product contract

### 1. CLI

unified CLIの`module` commandへ次を追加する。

```text
henji module export <module-id>@sha256:<full-digest> --output <artifact>
henji module import <artifact>
```

- export selectorはIncrement 33と同じfull exact external Definition refだけを受け入れる。module IDだけ、short digest、
  latest相当、built-in refは受け入れない。
- exportはmanaged storeのexact revisionだけをsourceにし、origin source pathを再読込しない。指定outputがすでに存在する
  場合は上書きせずtyped errorを返す。
- importはartifact内のlogical refをauthorityとし、CLIからmodule ID、role、revisionを二重指定しない。
- export/importはDefinitionをactivateせず、provider、credential、Session、workspace state、Workerを起動しない。
- 成功時はstdoutへ一つのJSON、失敗時はstderrへ`ok: false`、typed code、messageを持つ一つのJSONを返す。

### 2. Transport package v1

artifactはUTF-8 JSON一fileとし、概念上次のenvelopeを持つ。

```text
schemaVersion: 1
packageKind: henji-managed-resource-transport
resourceKind: agent-definition
manifest: <ManagedDefinitionManifestV1>
originLineage: <original source lineage>
files:
  - path: <canonical relative .ts path>
    bytesBase64: <exact source bytes>
```

- envelopeはresource kindを明示するが、v1のpayloadはAgent Definitionだけを扱う。汎用resource loaderや他kindの
  import contractは実装しない。
- `manifest`はlogical ref、role、API contract、entry、dependency lineage、closure descriptorsを含むportable identity
  authorityである。store pathとlocal custodyは含めない。
- `originLineage`は最初のsource installで得た情報をinformational metadataとして運ぶ。export元のlocal custody、
  export日時、XDG root、artifact output pathはpackageへ含めない。
- filesはmanifestと同じUTF-8 path順とし、exact bytesをbase64で保持する。transport package独自の第二のrevision
  digestは設けず、manifestのcanonical Definition revision digestをidentity authorityにする。

### 3. Export

- storeからmanifest、origin lineage、closure全fileを読み、各fileのbyte length、SHA-256、canonical revision digestを
  再検証してからartifactを構成する。
- current buildがmanifestのAPI contractをsupportしない場合でも、portableな構造とidentityを検証できるrevisionは
  re-exportできる。
- artifactはtargetと同じfilesystem上のtemporary fileへ完全に書き、readback後に指定pathへatomic publishする。
  不完全artifactを成功として残さない。

### 4. Importとlocal custody

- importはJSON envelope、resource kind、manifest schema、logical ref、role、entry、closure path、base64、file countと
  path orderを検証する。
- 各fileのexact bytesからbyte lengthとSHA-256を照合し、static source dependency projectionを再構築してmanifestの
  dependency lineageと一致することを確認する。全bytesからcanonical Definition revision digestを再計算し、packageの
  exact refと一致させる。
- portable構造とidentityが正しい限り、current buildがsupportしないAPI contractでもmanaged storeへimportできる。
  compatibilityは実行resolverが判定する。
- import先custodyはoriginal `originLineage`を保持し、`localCustody.kind = imported`、import日時、入力artifact pathを
  installation固有metadataとして新しく作る。これらをrevision digestへ含めない。
- targetに同じlogical refがすでに存在する場合は既存artifact全体を検証して返し、最初のlocal custodyを上書きしない。
  新規revisionはIncrement 33と同じstaging/readback/atomic rename経路へpublishする。

### 5. Store readと実行互換性

- manifestのportable構造検証は未知のAPI contract identityを保持できるようにし、current contractとの互換性判定を
  分離する。local source installが作るmanifestは引き続きcurrent contractへ固定する。
- list、inspect、exportはportable構造とidentityが正しければ非互換revisionもreadbackできる。
- Workerを起動するexact resolverだけがbuild manifestのsupported contractと照合し、非互換revisionを
  `module_api_unsupported`として拒否する。別revisionやbuilt-inへfallbackせず、store artifactとSession bindingを
  書き換えない。

### 6. Failure readback

- missing export source、既存output、artifact I/O、invalid JSON/envelope、invalid base64、closure mismatch、dependency
  lineage mismatch、revision digest mismatch、duplicate store corruptionをtyped module errorと具体的messageで区別する。
- import failureはactive revisionとして列挙できるdirectoryを残さない。artifact入力自体は変更・削除しない。
- error payloadへclosure source bytes、credential、Authorizationを含めない。exact logical refをdecodeできたfailureでは
  対象refをreadbackできるようにする。

## 実装slice

### Slice A — portable packageとstore境界

1. transport envelope codec、base64 file payload、portable manifest/custody型を追加する。
2. manifest構造検証とcurrent API compatibilityを分離し、non-compatible revisionをlist/inspect/exportできるようにする。
3. storeのstaging publishをsource installとtransport importで共有し、import local custodyとduplicate semanticsを実装する。
4. package tampering、non-compatible custody import、別XDG rootでのidentity一致をfocused確認する。

### Slice B — module CLI

1. `module export <exact-ref> --output <artifact>`と`module import <artifact>`のgrammarを追加する。
2. exportのatomic artifact writeとimportのread/validation/publishをprovider-free CLIへ接続する。
3. success JSONとtyped failure JSONからidentity、origin、local custody、artifact resultをreadbackできるようにする。
4. Increment 33のinstall/list/inspectとruntime selectorにregressionがないことをfocused確認する。

### Slice C — product利用と文書

1. two-file parent/planner fixtureをsource XDG rootからexportし、別XDG data rootへimportして、同じexact refを実行する。
2. READMEへtransport lifecycle、package内容、local custody、installとimportの違い、非互換contractの扱いを追記する。
3. stable candidateへ一回だけauthoritative `v0:gate`を実行する。
4. compiled binaryをDenoなしの`PATH`と二つのisolated XDG rootで実行し、export/import後の実provider turn、
   real-TTY planner turn、Session/execution artifact/provider evidenceのtarget build・exact Definition ref相関を確認する。

利用者の指定に従い、各sliceの実装・focused検証・checkpoint更新が完了した時点で停止する。

## Slice checkpoint

### Slice A — 完了（2026-09-12）

- UTF-8 JSONのDefinition transport v1 codecを追加し、manifest、original origin lineage、closure全fileのexact bytesを
  base64で往復可能にした。packageへlocal custodyやXDG rootを含めない。
- portable manifest構造とcurrent build compatibilityを分離した。list、inspect、exportは未知API contractを保持でき、
  exact execution resolverだけがbuild manifestのsupport一覧に対して`module_api_unsupported`を返す。
- source installとtransport importでstoreのstaging/readback/atomic publishを共有した。import custodyはartifact pathと
  importedAtをtarget固有に記録し、duplicateは最初のcustodyを保持する。
- source bytesからfile hash、dependency projection、canonical revision identityを再構築する共通validatorをstore readと
  transport import/export経路へ接続した。
- focused testはIncrement 34の3件とIncrement 33 regressionの11件が成功した。`v0:check`、`v0:fmt`、`v0:lint`、
  `git diff --check`も成功した。`v0:test`とauthoritative `v0:gate`は計画どおり未実施である。

### Slice B — 完了（2026-09-12）

- unified CLIへ`module export <exact-ref> --output <artifact>`と`module import <artifact>`を追加した。exportはfull
  exact external Definition refだけを受け、importはartifact manifestのidentityをauthorityにする。
- export artifactは指定outputと同じdirectoryのtemporary fileへ書いてreadbackし、hard linkによるatomic no-clobber
  publishを行う。既存outputは変更せず`module_artifact_exists`を返す。
- importはartifactを変更せず、検証後にSlice Aの共通store publishへ渡す。missing artifactとartifact I/Oを個別のtyped
  errorにし、decode済みまたはexport指定済みのexact refをfailure JSONからreadback可能にした。
- export/import success JSONはoperation、artifact path/byte length、manifest、origin lineage、local custody、physical
  storeを返す。CLI経路はprovider、credential、Session、Workerを起動しない。
- focused testはIncrement 34の5件とIncrement 33 regressionの11件が成功した。`v0:check`、`v0:fmt`、`v0:lint`、
  `git diff --check`も成功した。`v0:test`とauthoritative `v0:gate`は計画どおり未実施である。

### Slice C — 完了（2026-09-12）

- CLI経由でtwo-file parent/plannerをsource data rootからexportし、別data rootへimportした後、元source path不在のまま
  同じexact refからprovider-free Worker turnを完了するfocused product testを追加した。Increment 34 focused testは6件に
  なり、Increment 33 regression 11件も成功した。
- READMEへtransport command、artifact内容と除外対象、origin/local custodyの分離、importとactivationの分離、未知API
  contractのcustody readbackと実行時拒否を追記した。
- stable candidateに対するauthoritative `v0:gate`を計画どおり一回だけ実行し、type check、format、lint、全171 testが
  成功した。
- repository外へstandalone binaryをcompileし、Denoを含まない`PATH`とsource/target二つのisolated XDG data/state rootで
  production transportを確認した。build IDは
  `9ee749cff396934af3186799595d5113c0534f0e374d2cf08754e427172dfa07`である。
- parent ref `acceptance/transport-parent@sha256:6acffc6b067fb32b6ab1bbbb0a441beeb27c3c6a6ad01827717611bb4274624d`
  はsource path不在のtarget storeから実provider turnで`TRANSPORT_PARENT_OK`を返した。planner ref
  `acceptance/transport-planner@sha256:fbc9068e1fe00e59ec8c81c3269b52f32011c4f4b4857f09eb611c63f79ccffe`
  はreal TTY turnで`TRANSPORT_PLANNER_OK`を返した。
- planner Session `9a214555-e0fd-4fd1-9c0a-12f10d910c5c`と、parent/planner各execution artifact・provider evidenceが、
  上記build ID、target Session correlation、各exact refで一致した。targetからの再exportは元artifactとbyte-identicalで、
  envelopeはmanifest、origin lineage、filesだけをpayloadとして持ち、local custody、credential、Sessionを含まなかった。
- production受入のbinary、artifact、source不在copy、二つのXDG root、Session/evidence/artifactは
  `/tmp/henji-increment-34-acceptance-MGN78b`に保持している。

Increment 34は全sliceの実装・検証を完了し、利用者が完了を確認した。

## Verification

- package codec/store: exact bytes、path order、manifest、dependency lineage、digest、origin/local custody、duplicate、
  incompatible contractを確認する。
- CLI: exact selector、export output、import input、success/error JSON、provider/Session/Workerを起動しないことを確認する。
- runtime regression: Increment 33のsource install、list/inspect、exact selection、parent/planner Worker実行を維持する。
- compiled process: checkout外binaryと二つのisolated XDG data rootだけでtransportし、source不在のexact revisionを
  production経路で実行する。

各確認は上記product動作または現行経路の具体的regressionへ対応させる。実装中はfocused test、必要なtype check、
format、lint、`git diff --check`を使い、`v0:test`と`v0:gate`を繰り返さない。stable candidateだけにauthoritative
`v0:gate`を一回実行する。

## 完了条件

- exact Agent Definition revisionを一つのstore-independent artifactへexportできる。
- 別XDG data rootへimportしたrevisionが同じlogical ref、manifest、closure identityを持ち、original origin lineageと
  新しいlocal import custodyを分けてreadbackできる。
- source不在でもtarget binaryがsupportするimport済みparent/planner revisionを実行できる。
- non-compatible contractはcustody import/list/inspect/exportでき、実行時だけexact ref付きで拒否される。
- credential、Session、workspace state、binary、built-in Definition、active bindingをartifactへ含めない。
- focused確認、type check、format、lint、`git diff --check`、一回のauthoritative `v0:gate`、compiled binaryの
  実provider run/real-TTY受入が完了する。

## 対象外

- remote registry、network transfer、package signing/encryption/compression、複数revisionを束ねるarchive。
- Session、workspace state、credential、Henji binary、built-in Definition、AgentInstance active bindingのtransport。
- Agent Definition以外のresource kind、独立tool/provider/instruction/Skillのmanaged import。
- import後の自動activation、既存Sessionのrevision切替、hot reload、remove/GC。
- AIから呼べるexport/import tool、一般backup/restore、release automation。
- architecture、roadmapの実装状態更新、installed binary置換、commit、push、tag、publish。

## Human Gateと停止条件

- この文書の利用者承認がIncrement 34の実装許可である。承認前にcode、test、README、build taskを変更しない。
- 計画承認後はSlice Aから開始し、各sliceの完了時に停止して結果を報告する。
- repository外のinstalled binary置換、commit、push、tag、publishは別の利用者指示を必要とする。
- store-independent artifact、同一logical identity、non-compatible custody import、atomic target publishのいずれかを
  維持できない実証、またはarchitecture・roadmap、対象機能、外部contract、受入水準を変える必要が生じた場合は、
  実装を止めて観測結果と代案を利用者へ返す。
