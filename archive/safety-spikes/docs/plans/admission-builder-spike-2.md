# Admission Builder Spike 2 実装計画

## 位置づけとHuman Gate

正本は`docs/spikes/candidate-admission.md`である。本計画は、受入れ済みSpike 0/1を変更せず、
H-008/H-012のうちSpike 2「Admission — no candidate execution」だけを観測可能なincrementへ
分解する。v1、汎用plugin framework、runtime sandbox、evaluation、promotionを設計しない。

この文書作成は実装許可ではない。計画review後のHuman Gateで値とplan-deltaを承認するまで、
dependency追加、candidate解析、Builder process、temp/build/artifact
write、Admission登録、testを開始しない。

### Human Gate決定（2026-08-19）

ユーザーの「次へ進もう」を推奨値によるSpike 2実装許可として受領した。dependencyがcacheになかったため
停止条件で再確認し、続く「そうしよう」により、global/sibling toolを使わずrepository-localにDeno
2.9.4 とTypeScript 6.0.3 cacheを導入するplan-deltaも承認された。実AI、candidate artifact実行、Spike
3、 current/DeploymentState変更は引き続き未承認である。

## 結論を先に

Spike 2は、Spike 1が発行した`sealedProposalId`だけを公開入口として受ける。trusted host-owned
storeから exact candidateとAdmission Grantを引き、Supervisor内のsyntax-aware
preflightで拒否対象を落とす。 preflight合格時だけ固定されたtrusted Builder
subprocessを1回起動し、candidate sourceをstdinで渡して in-memory compileする。生成JS
bytesはhost側のcontent-addressed create-only storeへatomic publishし、 opaque registry
writerだけがAdmissionRecordを登録する。artifactを実行しない。

```text
AdmissionRequest { sealedProposalId }
       |
       v
trusted Candidate Store + Admission Grant
       |
       v
exact identity / expiry / policy / profile / content checks
       |
       v
syntax-aware narrow-subset preflight  --reject--> no process / no publish / no registry write
       |
       v
fixed trusted Builder process (stdin source, in-memory compiler, no candidate execution)
       |
       v
bounded deterministic JS artifact bytes
       |
       v
host hash -> create-only atomic publish -> opaque AdmissionRecord registry write
```

## 既存資産と隔離

- `spike0/src/`のDefinitionContent/JCS/content hashと`spike1/src/`のsealed
  candidate、revision、digest 契約を変更せずimportする。
- Spike 1 accepted outcomeを直接raw objectとして公開APIへ渡さない。trusted store snapshotが
  `sealedProposalId`から取得する。
- 旧`src/`、`plugins/`、`tests/`、`deno.json`、`deno.lock`、旧two-plugin spikeは停止証拠であり、
  import、実行、変更、削除しない。
- 新規`deno.spike2.json`、`spike2/`、`docs/spikes/admission-builder-spike-2-results.md`へ隔離する。
- repository外のsibling、global tool、global Deno/Codex設定を変更しない。

## 明示的な対象外

- candidate artifactの実行、dynamic smoke、behavior test、plugin-owned test実行
- Spike 3のsame-object primitive、runtime process、resource broker、Envelope method分離
- Definition/current/DeploymentState更新、evaluation、approval、promotion、rollback
- multi-file、JS/JSX/TSX、npm/JSR/remote dependency、asset、Wasm/native addon/build plugin
- general TypeScript compiler service、package manager、dependency resolver
- legacy direct load/install、raw source/pathからのAdmission
- 実AI/provider/model/credential/network call

## Human Gateへ提示する推奨値

### Parser/compiler/runtime

| 項目                   | 推奨値                                        | 理由                                                               |
| ---------------------- | --------------------------------------------- | ------------------------------------------------------------------ |
| host runtime           | repository-local Deno `2.9.4`                 | binary checksum、V8/TypeScript versionもrecordへ固定する           |
| syntax parser/compiler | `npm:typescript@6.0.3` exact pin              | `createSourceFile`と`transpileModule`を同一pinned dependencyで使う |
| dependency policy      | repo-local lock、cached-only、network deny    | 実装/test中の暗黙downloadを許さない                                |
| compiler host          | source/emitともin-memory、`noResolve`/`noLib` | candidate由来pathをfilesystem解決しない                            |
| module target          | ES2022 ESM、single output                     | runtime前のdeterministic artifact観測に限定する                    |
| source map/declaration | disabled                                      | 追加file/directive/path leakageを作らない                          |

TypeScript公式Compiler APIは`createSourceFile`、in-memory
emit、`transpileModule`を提供する一方、APIは version間で変化し得る。通常の`createProgram`/default
CompilerHostはfilesystemとmodule resolutionへ 到達するため採用しない。Deno CLIの内蔵TypeScript
version表示だけをdependency identityの代用にしない。

`transpileModule`へ渡すoptionsはexact
`{target:ES2022,module:ES2022,isolatedModules:true,noResolve:true,noLib:true,alwaysStrict:true,
sourceMap:false,inlineSourceMap:false,inlineSources:false,declaration:false,declarationMap:false,
removeComments:false,newLine:LineFeed}`、`fileName:'candidate.ts'`、`reportDiagnostics:true`とする。
未記載optionは渡さず、返るdiagnosticが1件でもあればemitを破棄する。optionsのenumは数値ではなく
TypeScript 6.0.3のsymbolic nameをcanonical manifestへ記録する。

Gateでは、上記dependencyをrepoへexact pinして取得すること、lockfileをSpike 2専用にすること、
dependency closure/source
digestをAdmissionRecordへ含めることを承認する。未cacheでnetwork取得が必要なら
実装を停止し、取得方法と変更対象を再提示する。

### Repository-local toolchain plan-delta

- Deno executableは`<repo>/.tools/deno/2.9.4/deno`、dependency cacheは
  `<repo>/.tools/deno-cache/spike2/`へ置き、`.tools/`全体を`.gitignore`する。binary/cacheをcommitしない。
- script自身のparentからphysical repository rootを解決し、rootがsymlinkでなくcurrent
  uid所有のdirectoryで あることを最初に検査する。repository rootの既存group modeはtrust
  boundary外だが、`.tools`以下は `umask 077`、current uid所有、mode
  0700のdirectory（fileは0600、executableだけ0700）に限定する。
- network/read/write前に`.tools`からfinal/cacheまでの既存各path
  componentを`lstat`し、symlink/non-directory/ owner mismatchを拒否する。missing
  componentは`mkdir -p`を使わずroot側から一段ずつcreateし、各create後に
  `lstat`、mode、owner、`realpath`が`physicalRepoRoot + '/.tools/'`配下であることを再検証する。final
  fileも `lstat`でregular/no-symlinkを要求する。同じvalidatorをbootstrapとdependency
  acquisitionで共有する。
- `.tools`/ancestor symlink、途中component symlink、repository外realpath、wrong
  owner/mode、create直後差替えを
  fixtureで拒否し、repository外sentinelの変更0をtestする。同一uidによる検査後の能動的path交換を防ぐ
  dirfd/openat2 boundaryはSpike 2 tool bootstrapのthreat model外としてremaining riskへ記録する。
- `scripts/bootstrap-deno-spike2.sh`だけをcommitする。current VMのtargetは
  `aarch64-unknown-linux-gnu`に限定し、他OS/archはunsupportedとしてdownload前に停止する。
- scriptは公式GitHub releaseのexact
  `https://github.com/denoland/deno/releases/download/v2.9.4/deno-aarch64-unknown-linux-gnu.zip`
  だけを取得する。redirect後のhostも`github.com`/`release-assets.githubusercontent.com`以外を拒否する。
- `DENO_ARCHIVE_SHA256`は公式release checksumを人間可読に確認してscript
  constantへ固定する。初回準備時に そのverified archiveから展開したexact executable
  bytesのSHA-256を別の
  `DENO_EXECUTABLE_SHA256`へ固定する。archiveとbinaryのhashを混用しない。mutable install scriptや
  `curl | sh`を使わない。
- downloadはbounded temp directoryへ行い、zip memberがexactly one regular
  `deno`、absolute/`..`/symlinkなし、compressed download 100 MiB以下、uncompressed size 200
  MiB以下で あることを検査してから展開する。download clientのmax-file-sizeとpost-download
  statの両方を使う。
- temp executableのbinary hash/versionを検証後、finalと同じdirectoryへ置き、hard-link
  no-replaceだけで atomic createする。`AlreadyExists`なら既存finalのexecutable
  hash/versionを比較し、同一ならidempotent
  success、異なれば上書きせずfailureとする。rename、truncate、remove-and-replaceは禁止する。
  same/different binaryのconcurrent bootstrapを直接testする。
- archive、download temp、extract directory、same-directory temp executableは個別absolute
  pathを変数で保持し、 `EXIT`/`INT`/`TERM` trapで上記containment
  validatorを再確認してから、対象fileとempty temp directoryだけを cleanupする。recursive
  remove、glob、未解決変数を使わない。link success、AlreadyExists、checksum/version
  mismatch、download/extract/link failure、signalの全pathでtemp 0をtestし、cleanup
  failureはnonzeroにする。
- global PATH、`/usr/local`、home Deno cache、sibling repositoryを変更しない。
- repository-local Denoで`DENO_DIR=<repo>/.tools/deno-cache/spike2`を指定し、networkを許可する一回の
  dependency
  acquisitionで`npm:typescript@6.0.3`だけを解決して`deno.spike2.lock`へintegrityを固定する。 npm
  lifecycle scriptsは許可しない。Deno 2.9.4で実在するCLIを正本とし、取得後の`run`/`test`は
  `--cached-only --frozen`、`check`は`--deny-import --frozen`にして暗黙downloadを拒否する。
- bootstrap/downloadとdependency
  acquisitionは別taskにし、通常のcheck/testが暗黙取得しないことをtestする。
- runtime identityはrepository-relative pathではなく、配置済みexecutable raw hashと実測
  `{deno,v8,typescript,platform}`で固定する。toolchain path変更だけではdigestを変えない。

### Accepted subset v1

初期subsetは意図的に狭くする。

- media typeは`application/typescript`、logical filenameは固定`candidate.ts`、single UTF-8
  sourceだけ。
- top-levelはexactly one `export default function`。async/generator/decorator/type
  parameter/overloadなし。
- parameterはexactly one、host固定名`input`、型annotationは`string`、return annotationも`string`。
- function bodyは0個以上の`const identifier = Expr;`と、末尾のexactly one`return Expr;`だけ。
  declaration以外のblock、`if`、loop、try、throw、class、function nesting、empty statementなし。
- bindingはASCII`[A-Za-z_][A-Za-z0-9_]{0,63}`、予約語不可、`input`との重複・shadow・再宣言なし。
  destructuring、type annotation、definite assignment、`as`/`satisfies`は不許可。
- checkerは次の再帰grammarとtype tagだけを実装する。`Env`は`input: string`から始まり、constを
  source順にinitializerの推論tag（`string | number | boolean`）で追加する。forward referenceなし。

```text
StringExpr  ::= string literal
              | string-tag Identifier
              | Parenthesized(StringExpr)
              | StringExpr + StringExpr
              | BooleanExpr ? StringExpr : StringExpr
              | untagged template whose substitutions are Expr
              | StringMethodCall
NumberExpr  ::= finite number literal
              | number-tag Identifier
              | Parenthesized(NumberExpr)
              | unary (+|-) NumberExpr
BooleanExpr ::= true | false | boolean-tag Identifier | Parenthesized(BooleanExpr)
              | ! BooleanExpr
              | same-tag Expr (===|!==) same-tag Expr
              | BooleanExpr (&&|||) BooleanExpr
              | StringPredicateCall
Expr        ::= StringExpr | NumberExpr | BooleanExpr
```

- `StringMethodCall`はstring-tag receiverへのdot-property callだけ。signatureは
  `trim()/toUpperCase()/toLowerCase(): string`、`slice(number[,number]): string`、
  `substring(number[,number]): string`。
- `StringPredicateCall`は`includes(string[,number])`、`startsWith(string[,number])`、
  `endsWith(string[,number])`だけでreturn tagはboolean。
- template substitutionはstring/number/boolean tag、conditional conditionはboolean、両branchは
  同じtag。最終returnはstring tag必須。
- `+`以外のbinary arithmetic、relational、nullish、bitwise、comma、assignment、updateは禁止。
- property accessは上記call calleeだけ。computed/optional access、optional
  call、spread、callback、generic type argumentは禁止。tagged templateは禁止。
- 未束縛global identifier、`this`、`super`、`new`、object/array literal、regex、BigInt、top-level
  side effectは不許可。
- versioned subset manifestは、上記production grammarで訪問可能なTypeScript 6.0.3のexact
  `SyntaxKind`、modifier、operator、method signatureをsorted canonical
  arraysとして持つ。ASTで観測した node/tokenがmanifest外なら`unsupported_syntax`。manifest
  digestと各grammar productionのpositive/ negative golden fixtureをAdmission profileへ固定する。

dependency経路はallowlistとは別に先行検査し、static import、`export ... from`、dynamic import、
type-only import/export、import-equals、`require`、Worker、SharedWorker、importScripts、triple-slash
path/types/lib、sourceMappingURL/sourceURL、AMD
directiveを専用codeで拒否する。comment/string/template内の lookalikeはAST/directive
metadataに現れない限り許容する。

このsubsetが狭すぎる場合はGateで具体的node/methodを追加する。実装中に便宜的に広げない。

### Resource profile

全上限はinclusive。変更はprofile versionを進め、AdmissionRecord identityを変える。

| limit                          |                                                     推奨値 |
| ------------------------------ | ---------------------------------------------------------: |
| canonical candidate snapshot   |                                              196,608 bytes |
| AdmissionRequest canonical     |                                                  512 bytes |
| AdmissionGrant canonical       |                                                4,096 bytes |
| AdmissionRecord canonical      |                                               16,384 bytes |
| trusted ID/digest each         |                                       256 UTF-8 bytes each |
| RFC 3339 timestamp             |        exactly 24 ASCII bytes (`YYYY-MM-DDTHH:mm:ss.sssZ`) |
| Candidate Store                |                    64 entries / 12,615,680 canonical bytes |
| Grant Store                    |                       64 entries / 270,336 canonical bytes |
| Admission Registry             |                     64 entries / 1,064,960 canonical bytes |
| Artifact Store index snapshot  |                        64 entries / 32,768 canonical bytes |
| source UTF-8                   |                                               65,536 bytes |
| AST node count                 |                                                      8,192 |
| AST depth                      |                                                         64 |
| identifier/string literal each |                                                4,096 bytes |
| preflight wall time            | synchronous bounded traversalのみ。source/node/depthで制限 |
| Builder request                |                                               98,304 bytes |
| Builder response               |                                              262,144 bytes |
| emitted artifact               |                                              131,072 bytes |
| stdout protocol                |                                              262,144 bytes |
| stderr diagnostics             |                        16,384 bytes、truncation marker付き |
| Builder wall timeout           |                                                   2,000 ms |
| concurrent Builder             |                                                          1 |
| artifact store index           |                      64 entries / 8,388,608 artifact bytes |
| Admission ledger entries/bytes |                     64 entries / 1,048,576 canonical bytes |

Storeは`{schemaVersion, entries}`のexact objectとし、`entries`はplain objectの
`key -> exact value`である。処理順はroot exact schema→entry count→bounded own-data-property
traversal→ 各value canonical byte→store全体canonical byte→key/inner
identity一致とする。getter、symbol、sparse/ extra array property、duplicate inner
identityを拒否する。上限計数はUTF-8 JCS bytesでwrapper、key、
separatorを含む。各境界はlimit直下、一致、1超過をtestする。

Builder timeout、protocol/emit超過、nonzero exit、invalid responseはterminal rejectionとし、artifact
publishと registry writeを0にする。CPU/memoryの強い隔離保証はSpike 3へ持ち越し、Spike
2ではsource/AST bound、 単一同時実行、wall timeout、process kill/reapを直接観測する。

### Filesystemとprocess authority

- preflight rejectionはBuilder process起動0。
- 合格candidateだけ、次のargument vectorをshellなしの`Deno.Command`へ渡す。pathは起動前にtrusted
  composition rootからabsolute化し、request/candidateから組み立てない。

```text
<pinned-deno-absolute-path> run
  --config=<repo>/deno.spike2.json
  --cached-only --frozen --lock=<repo>/deno.spike2.lock
  --node-modules-dir=none --no-remote --no-prompt --no-check
  --allow-read=<repo>/spike2/builder,<repo>/spike2/src,<repo>/.tools/deno-cache/spike2
  --deny-write --deny-net --deny-env --deny-sys --deny-run --deny-ffi --deny-import
  <repo>/spike2/builder/main.ts
```

- child environmentは`clearEnv: true`とし、CLI module resolution専用に固定absolute
  `DENO_DIR=<repo>/.tools/deno-cache/spike2`だけを設定する。TypeScript 6.0.3はmodule初期化時にenvを
  参照するため、`--allow-env`は次のexact 15名だけに限定する。ただしこれら15名をchild `env`へ
  渡さず、TypeScriptからは全て未設定に見えることをtestする。`DENO_DIR`、credential、その他の
  Supervisor envはscriptから読めないことを直接testする。

  ```text
  TSC_WATCHFILE
  TSC_NONPOLLING_WATCHER
  TSC_WATCHDIRECTORY
  NODE_INSPECTOR_IPC
  VSCODE_INSPECTOR_OPTIONS
  NODE_ENV
  TSC_WATCH_POLLINGINTERVAL_LOW
  TSC_WATCH_POLLINGINTERVAL_MEDIUM
  TSC_WATCH_POLLINGINTERVAL_HIGH
  TSC_WATCH_POLLINGCHUNKSIZE_LOW
  TSC_WATCH_POLLINGCHUNKSIZE_MEDIUM
  TSC_WATCH_POLLINGCHUNKSIZE_HIGH
  TSC_WATCH_UNCHANGEDPOLLTHRESHOLDS_LOW
  TSC_WATCH_UNCHANGEDPOLLTHRESHOLDS_MEDIUM
  TSC_WATCH_UNCHANGEDPOLLTHRESHOLDS_HIGH
  ```
  stdin/stdout/stderrはpiped、signalはnone、cwdだけがper-request empty directoryである。
- Spike 2 dependency導入時だけnetworkを明示許可して専用cache/lockを作る。通常check/test/Builderは
  `--cached-only --frozen`で、lifecycle scriptを許可しない。`deno info --json`で実module closureが
  fixed Builder/Spike 0 helper/`typescript@6.0.3`だけであることをpreflightする。
- cwdはtrusted hostが作る空のper-request temp build directory。symlink、既存entry、ambient
  `deno.json`/import map/cache directoryを置かない。
- protocolは1 request/1 responseだけ。unsigned 32-bit big-endian byte length 4 octets + strict UTF-8
  JCS JSON payloadとし、length一致後にEOFを要求する。zero、limit+1、truncated、multiple/trailing
  frame、unknown/ missing field、duplicate key、invalid
  UTF-8を拒否する。stdoutも同じframingで、response完了後のbyteと process nonzero
  exitをfailureにする。stderrはprotocolに影響せずbounded drainする。
- request schemaはexact
  `{schemaVersion:'builder-request/v1',requestId,sourceHash,sourceText,compilerOptionsDigest,
  admissionProfileDigest}`。success
  responseはexact
  `{schemaVersion:'builder-response/v1',requestId,status:'compiled',sourceHash,
  compilerOptionsDigest,emittedMediaType:'application/javascript+module',artifactBytesBase64,
  artifactByteCount,diagnostics:[],closure:{schemaVersion:'module-closure/v1',modules:[]}}`。
  failure responseはartifact fieldを持たないexact
  `{schemaVersion:'builder-response/v1',requestId,status:'rejected',stage,code,detailsDigest}`。
  Base64はRFC 4648 canonical alphabet/padding、decode後length一致、再encode一致をhostが検査する。
- Builderはcandidate pathを受けず、filesystemからcandidateを読まない。
- Builder subprocessはwrite/net/env/run/ffiをdenyし、read/importは固定Builder TCBとpinned dependency
  closureだけに限定する。candidate textからmodule resolutionしない。
- hostだけがtemp build directoryとtest artifact storeへの限定writeを持つ。
- cleanup failureは記録し、成功扱いにしない。artifact publish後のcleanup failureはAdmission登録前に
  terminal failureとする。

### Artifact publish

- artifact raw digest framingは次のexact bytesとする。整数はunsigned 64-bit
  big-endian、文字列はUTF-8。

```text
"henji/spike2/artifact/v1" || 0x00 ||
u64be(metadataJcs.length) || metadataJcs ||
u64be(jsBytes.length) || jsBytes
metadata = {
  schemaVersion: "artifact-preimage/v1",
  emittedMediaType: "application/javascript+module",
  compilerOptionsDigest: <sha256>,
  builderDependencyDigest: <sha256>
}
```

- staging fileはartifact storeと同じfilesystem・同じtrusted directoryへrandom nameで`createNew`し、
  bytes write、flush、close、read-back
  hashを行う。destination作成は`Deno.link(staging,destination)`の hard-link no-replace
  operationだけを使う。destination存在時は`AlreadyExists`となり置換しない。
- link成功後はdestinationをread-back検証してstaging nameだけをremoveする。`AlreadyExists`なら既存を
  `lstat`してregular file/no symlinkを確認しbytes/hashを比較する。同一ならstagingをremoveして
  idempotent success、異なればstagingをremoveしてcollision failure。`rename`、overwrite、truncate、
  remove-and-replaceを禁止する。hard-link非対応/cross-filesystemはfallbackせず停止条件とする。
- two concurrent publishers（same bytes）と、test-only injected addressへdifferent
  bytesを同時publishする raceで、winner 1、既存destination変化0、loser
  idempotent/collisionを直接testする。
- testは専用`makeTempDir`配下だけを使い、終了時に明示pathをcleanupする。repositoryへartifactを残さない。
- atomicity/fsync durabilityをproduction保証とはしない。Spike
  2はcreate-only/no-overwriteと観測可能な publish順序だけを保証し、crash durabilityはremaining
  riskに残す。

## Authorityとobject model

公開requestはauthority token一つだけとする。

```ts
interface AdmissionRequestV1 {
  schemaVersion: 'admission-request/v1';
  sealedProposalId: string;
}

interface AdmissionGrantV1 {
  schemaVersion: 'admission-grant/v1';
  grantId: string;
  sealedProposalId: string;
  revisionId: string;
  revisionDigest: string;
  contentHash: string;
  admissionProfileDigest: string;
  policyDigest: string;
  issuedAt: string;
  expiresAt: string;
}

interface AdmissionProcessingBindingV1 {
  schemaVersion: 'admission-processing-binding/v1';
  sealedCandidateDigest: string;
  admissionGrantDigest: string;
  admissionProfileDigest: string;
  policyDigest: string;
  preflightSourceDigest: string;
  builderSourceDigest: string;
  builderDependencyDigest: string;
  parserDigest: string;
  compilerDigest: string;
  runtimeDigest: string;
  compilerOptionsDigest: string;
}
```

`AdmissionGrantV1`はSpike 1 Ticketを再利用しないhost-owned one-purpose authorityである。Spike 1には
ticket expiryがないため、正本の「偽・期限切れticket拒否」は、exact sealed candidateへ結合したこの
grantの署名ではなくtrusted snapshot照合とexpiryで観測する。PKI/署名は対象外。

Grant Storeはexact
`{schemaVersion:'admission-grant-store/v1',entries:Record<sealedProposalId,AdmissionGrantV1>}`とする。
keyはGrantの`sealedProposalId`と一致し、`grantId`はstore内uniqueなhost-issued opaque IDである。
timestampはexact UTC millisecond RFC 3339、実在日時だけを許可する。最大TTLは15分、
`issuedAt < expiresAt`を要求する。新規Admissionではtrusted clockをexactly 1回snapshotし、
`issuedAt <= now && now < expiresAt`を満たす（`now == expiresAt`はexpired）。clock rollbackとして
`now < issuedAt`も拒否する。exact registry replayは後述の`admissionKey`でclock/expiryより先に返し、
過去に成立したAdmissionRecordのreadをGrant expiryで無効化しない。

Candidate Store snapshotはaccepted Spike 1 outcomeだけを保持し、key、candidate.sealedProposalId、
revision ID/digest、content hash、proposal/ticket digestの完全一致を要求する。rejected outcome、raw
Proposal、DefinitionContent単体、artifact hash、legacy pathからのlookup APIを作らない。
schemaはexact
`{schemaVersion:'sealed-candidate-store/v1',entries:Record<sealedProposalId,AcceptedRevisionOutcomeV1>}`で、
valueはSpike 1 outcome unionの`status:'accepted'` branch全体とする。keyとinner sealed IDの一致、
Submission/Processing/Candidate/Provenance/Revisionの全nested runtime schemaを再検証する。

```ts
interface AdmissionRecordV1 {
  schemaVersion: 'admission-record/v1';
  admissionKey: string;
  admissionId: string;
  sealedProposalId: string;
  revisionId: string;
  revisionDigest: string;
  definitionContentHash: string;
  proposalDigest: string;
  ticketDigest: string;
  admissionGrantDigest: string;
  admissionProfileDigest: string;
  policyDigest: string;
  preflightSourceDigest: string;
  builderSourceDigest: string;
  builderDependencyDigest: string;
  parserDigest: string;
  compilerDigest: string;
  runtimeDigest: string;
  compilerOptionsDigest: string;
  closureDigest: string;
  artifactHash: string;
  artifactByteCount: number;
  createdAt: string;
  admissionDigest: string;
}
```

`admissionKey`はartifact生成前に上記`AdmissionProcessingBindingV1`全fieldをbindするdomain-derived
processing identityである。`sealedCandidateDigest`はaccepted outcomeのsealed
candidate全fieldをpreimageと する。`admissionId`もartifact hashを追加したdomain-derived identity
とし、ID portを使用しない。trusted clockは新規処理のGrant検査で得た同じsnapshotを`createdAt`へ使い、
追加clock callを行わない。

Admission Registry snapshotはexact
`{schemaVersion:'admission-registry/v1',entries:Record<admissionKey,AdmissionRecordV1>}`で、keyとrecordの
`admissionKey`一致、record全nested schema/digest形式、unique admissionIdを検査する。opaque
writerだけが appendできる。既存keyで全processing
bindingが一致すればartifactを触らずrecordをreplayし、不一致なら
`admission_conflict`。新規keyはBuilder前にworst-case 16,384 bytesを予約し、entry/count/canonical
byte capacity不足なら`registry_capacity`を返す。登録時は予約内のexact recordだけを1回appendする。

snapshot validation/replayではhash文字列の形式確認だけで終えない。trusted
candidate/grant/profile/policy/ TCB identityからProcessing
Bindingと`admissionKey`を再導出し、recordのcandidate/grant/全digest fieldと比較する。 fixed empty
closure objectから`closureDigest`、recordのartifactHash/byteCountから`admissionId`、それ以外の
全record fieldから`admissionDigest`を再計算して一致したrecordだけをreplayする。artifactHash形式、
byteCount上限、timestampもstrict検査する。各fieldの欠落/追加/型変更/値変更、admissionId/digestだけの変更、
reordered fieldを直接testする。artifact bytesとのsame-object照合はSpike 3であり、ここでは行わない。

Artifact Store indexはexact
`{schemaVersion:'artifact-store-index/v1',entries:Record<artifactHash,{artifactHash,byteCount}>}`とし、
store pathやbytes本体を含めない。新規AdmissionはBuilder前に1 entry/131,072 bytesをworst-case予約し、
不足なら`artifact_capacity`を返す。実hashが既存artifactなら予約を消費せずidempotent
publishできるが、
pre-build時点では未知なので新規1件として保守的に予約する。index更新はhard-link成功/read-back後だけで、
Admission registryとは別authorityである。

Admission Serviceはnew/replayを含むtransaction mutexを一つ持つ。step 6でmutexをatomic acquireし、
registry replay/conflictとregistry/artifact両capacityを同じcritical sectionで検査して、artifact
limbと registry limbを持つopaque reservation tokenを発行する。new requestはBuilder、publish、record
register 完了までmutex/tokenを保持するため、Spike 2のAdmission transaction concurrencyは1である。

hard-link/read-back成功直後、staging cleanupより前にArtifact Store indexへactual
hash/sizeを記録してartifact limbだけをcommitする。この後のcleanup/record/register
failureではartifact/indexをorphanとしてcapacityへ 残し、registry
limbだけを`finally`でreleaseする。registry append/read-back成功時だけregistry limbをactual record
sizeへcommitする。replay/rejection/timeout/throw/cancelでは各未commit limbを`finally`でreleaseして
mutexを解放する。tokenはservice/module-privateでcaller/Builderへ渡さない。different artifact
addressで 最後の1 entry/byteを競う2 request、各failure stageのlimb別release/commit、staging cleanup
failure後の orphan accounting、二重commit/release拒否をtestする。

`closureDigest`は外部module closure空を表すversioned canonical object
`{schemaVersion:'module-closure/v1', modules:[]}`のdigestとする。artifact hashだけ、あるいはcallerが
組み立てたAdmissionRecordではadmittedにならない。registry writerはmodule-private
capability/closureで 生成し、Builder、candidate、公開callerへ渡さない。

Admission Policyは次のexact schema/literalをHuman
Gateで固定する。arrayの順序もpreimageの一部である。

```ts
interface AdmissionPolicyV1 {
  schemaVersion: 'admission-policy/v1';
  policyVersion: 'spike2-policy-1';
  acceptedKind: 'text-transform';
  acceptedMediaType: 'application/typescript';
  requestedCapabilities: 'must-be-empty';
  dependencySyntax: 'deny-all';
  unknownSyntax: 'reject';
  compilerDiagnostics: 'reject-any';
  publishPrimitive: 'same-filesystem-hard-link-no-replace';
  existingAddress: 'same-bytes-idempotent';
  collision: 'reject-without-overwrite';
  registryWriter: 'module-private-capability-only';
  maxGrantTtlMilliseconds: 900_000;
  failurePrecedence: readonly [
    'request',
    'snapshot',
    'lookup',
    'identity',
    'replay-conflict-capacity',
    'grant-time',
    'content',
    'contract',
    'syntax',
    'dependency',
    'subset',
    'builder-capacity',
    'builder',
    'artifact',
    'record',
    'registry',
  ];
  rejectionCodes: readonly [
    'request_invalid',
    'snapshot_invalid',
    'candidate_not_found',
    'grant_not_found',
    'identity_mismatch',
    'admission_conflict',
    'registry_capacity',
    'artifact_capacity',
    'grant_invalid',
    'grant_not_yet_valid',
    'grant_expired',
    'content_invalid',
    'contract_invalid',
    'syntax_invalid',
    'dependency_forbidden',
    'unsupported_syntax',
    'subset_budget',
    'builder_busy',
    'builder_timeout',
    'builder_protocol',
    'compiler_diagnostic',
    'artifact_oversize',
    'artifact_publish',
    'artifact_collision',
    'record_invalid',
    'registry_write',
  ];
}
```

実装はpolicy外codeを生成せず、stage/codeの対応をversioned constant
tableにする。detailsは常にredacted domain digestで、source text、path、compiler
diagnostic本文をAdmission ledgerへ保存しない。policy変更は
policyDigestとadmissionKeyを変えるため、新policy下のAdmission
requestは旧recordをreplayしない。旧recordは 履歴としてread-only保持するが、再利用・自動移行しない。

## Digest domain

Spike 0 JCS/hashを使い、raw artifact/source以外は`{domain,value}`をcanonical encodeする。

| identity          | domain                               | exact versioned preimage                                                                             |
| ----------------- | ------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| Admission Grant   | `henji/spike2/admission-grant/v1`    | Grant全field                                                                                         |
| sealed candidate  | `henji/spike2/sealed-candidate/v1`   | Spike 1 `SealedCandidateV1`全field                                                                   |
| profile           | `henji/spike2/admission-profile/v1`  | limits、subsetManifestDigest、compilerOptionsDigest                                                  |
| policy            | `henji/spike2/admission-policy/v1`   | exact rejection/allowlist/publish policy object                                                      |
| preflight source  | `henji/spike2/preflight-source/v1`   | multi-root behavior-defining source manifest                                                         |
| builder source    | `henji/spike2/builder-source/v1`     | `{schemaVersion,files:[{logicalPath,sourceHash}]}`                                                   |
| dependency        | `henji/spike2/builder-dependency/v1` | `{schemaVersion,packages:[{name,version,lockIntegrity,files:[{logicalPath,sourceHash}]}]}`           |
| parser            | `henji/spike2/parser/v1`             | `{product:'typescript',version:'6.0.3',dependencyDigest,subsetManifestDigest,preflightSourceDigest}` |
| compiler          | `henji/spike2/compiler/v1`           | `{product:'typescript',version:'6.0.3',dependencyDigest,compilerOptionsDigest}`                      |
| runtime           | `henji/spike2/runtime/v1`            | `{product:'deno',version,v8Version,typescriptVersion,platform,binaryHash}`                           |
| compiler options  | `henji/spike2/compiler-options/v1`   | normalized exact option object                                                                       |
| closure           | `henji/spike2/module-closure/v1`     | `{schemaVersion:'module-closure/v1',modules:[]}`                                                     |
| admission key     | `henji/spike2/admission-key/v1`      | `AdmissionProcessingBindingV1`全field                                                                |
| artifact          | raw framing defined above            | metadata JCS + raw JS bytes                                                                          |
| rejection details | `henji/spike2/rejection-details/v1`  | stage/code/redacted details                                                                          |
| admission ID      | `henji/spike2/admission-id/v1`       | admissionKey、artifactHash、closureDigest                                                            |
| AdmissionRecord   | `henji/spike2/admission-record/v1`   | admissionDigest以外の全field                                                                         |

raw hash domain literalはcandidate
source=`henji/spike2/candidate-source/v1`、preflight/Builderの各repo source
file=`henji/spike2/tcb-source-file/v1`、TypeScript package file=
`henji/spike2/dependency-file/v1`、Deno
executable=`henji/spike2/runtime-binary/v1`とする。各sourceHash/
binaryHashは`UTF8(該当domain) || 0x00 || raw bytes`である。

preflight source manifestは`admission_service.ts`、`subset_checker.ts`、`admission_profile.ts`、
`admission_policy.ts`、`runtime_schema.ts`をmulti-rootとする`deno info --json` closure、Builder
source manifestは
`builder/main.ts`をrootとするclosureから作る。両manifestはclosureに含まれる`spike0/src/`、`spike1/src/`、
`spike2/src/`、`spike2/builder/`のrepository fileをrepository-relative logical pathで昇順列挙する。
dependency manifestは両closureの和にある`typescript@6.0.3` package root以下を
`npm/typescript@6.0.3/<package-relative-path>`として全file昇順列挙し、Spike 2 lockのpackage
integrityを 結合する。directory、symlink、mtime、absolute checkout/cache pathを含めない。runtime
binaryは起動に使う absolute Deno executable
bytesをhashするがpreimageにpathを入れない。closureに未知package/file specifierがあればpreflight
failureとする。golden vector、別checkout/cache root相当、field順変更、
source/dependency/binary変更を直接testする。

## 処理順序とfailure precedence

後段へ到達したfailureが前段のfailureを上書きしない。

1. Requestのexact schema、512-byte ceiling、sealed ID形式/256-byte ceilingを検査する。
2. Candidate Store、Grant Store、Admission Registry、Artifact Store indexの各snapshotをroot
   schema→count→bounded traversal→各value→total byte順に検査する。
3. sealed IDでaccepted candidateとGrantをlookupする。raw/path fallbackは行わない。
4. store key、Grant ID/sealed ID、revision ID/digest、content/proposal/ticket digestを完全照合する。
5. profile/policy/Builder/parser/compiler/runtime/optionsのtrusted identityを検証し、Grant digestと
   domain-derived`admissionKey`を作る。
6. Admission Registryを`admissionKey`で検索し、exact bindingならclock/process/artifactなしでreplay、
   不一致ならconflictとする。新規ならtransaction mutex内でregistry recordとArtifact Store
   index/bytesの worst-case capacityを一つのopaque tokenへatomic予約する。
7. trusted clockをexactly 1回snapshotし、Grant
   timestamp/最大TTL/`issuedAt <= now < expiresAt`を検査する。
8. candidate snapshotをbounded traversalし、Spike 0 normalization/content hashを再検証する。
9. media type、single source、requested capability空、public contractを検査する。
10. syntax parse diagnostics、directive/dependency経路を検査する。
11. AST node/depth/literal budgetとversioned accepted-subset grammar/manifestを検査する。
12. empty build directoryを作成・再確認し、Builder concurrency capacityを予約する。
13. fixed Builder processを起動し、bounded one-frame protocolでin-memory compileする。
14. response identity、diagnostics、compiler/runtime/options/closure、emit byte limitを検査する。
15. hostがartifact hashを再計算し、hard-link no-replaceでcreate-only publishする。
16. published bytesをread-backしてhash/sizeを再確認する。
17. `admissionId`とAdmissionRecordをdomain derivationし、予約サイズ内であることを検査する。
18. opaque registry writerがappend-only registerし、read-back一致を確認する。

step 1〜6のrejection/replayはclock/process/publish/registerすべて0、step
1〜11の新規rejectionはprocess/ publish/register 0とする。domain-derived identityのためID
port/counterは存在しない。step 12以降のfailureも publish前ならartifact 0、register前ならregistry
0とする。artifact publish後にrecord/registerが失敗した orphan
artifactはcurrent/admittedではなく、resultへorphan hashを秘密情報なしで記録する。自動削除・
上書きしない。

## 予定ファイル

| file                                               | responsibility                                      |
| -------------------------------------------------- | --------------------------------------------------- |
| `deno.spike2.json` / Spike 2 lock                  | scoped tasks、pinned dependency、permission profile |
| `spike2/src/admission_request.ts`                  | sealed IDだけのstrict ingress                       |
| `spike2/src/admission_grant.ts`                    | one-purpose authorityとexpiry                       |
| `spike2/src/candidate_store.ts`                    | accepted sealed candidate snapshot lookup           |
| `spike2/src/admission_profile.ts`                  | limits、subset、compiler options                    |
| `spike2/src/subset_checker.ts`                     | syntax-aware dependency/directive/AST allowlist     |
| `spike2/src/builder_protocol.ts`                   | bounded stdin/stdout protocol                       |
| `spike2/src/builder_process.ts`                    | fixed spawn、timeout、drain、kill/reap              |
| `spike2/builder/main.ts`                           | trusted in-memory TypeScript compile entrypoint     |
| `spike2/src/artifact_store.ts`                     | host hash、create-only atomic publish/read-back     |
| `spike2/src/admission_record.ts`                   | record/digest/seal                                  |
| `spike2/src/admission_registry.ts`                 | opaque writerとappend-only test store               |
| `spike2/src/admission_service.ts`                  | ordering/orchestration/zero-side-effect rejection   |
| `spike2/src/observability.ts`                      | process/broker/publish/register/current counters    |
| `spike2/tools/check_module_graph.ts`               | Spike 0/1/2とpinned dependencyだけのclosure         |
| `spike2/tools/check_builder_identity.ts`           | source/dependency/runtime digest preflight          |
| `spike2/tests/*_test.ts`                           | direct tests、fixtures、single entrypoint           |
| `docs/spikes/admission-builder-spike-2-results.md` | acceptance package                                  |

## Increment 1: authority、snapshot、preflight

- isolated config、module graph preflight、profile/digest schemaを作る。
- Requestがsealed ID以外を持てないこと、raw source/path/ticket/legacy fieldをunknownとして拒否する。
- Candidate Store/Grantのstrict runtime schema、size/count、exact identity、expiryを実装する。
- dependency/directive先行検査とAST allowlistを実装する。
- benign comment/string lookalike、各forbidden import/reference/loader/global、unknown
  nodeをfixture化する。
- stage別にclock callをassertする。step 1〜6 rejection/replayは0、expiry以降の新規処理は1。
  process/broker/publish/register/current/DeploymentStateはpreflight rejectionで常に0、ID
  portは存在しない。

停止条件: sealed ID以外のingressが必要、Spike 1 candidateを変更する必要、syntax-aware
parserをpinできない、 preflight自体がcandidate path/module resolutionを必要とする。

## Increment 2: trusted Builder

- fixed entrypoint、empty cwd、bounded protocol、concurrent=1、timeout/kill/reapを実装する。
- Builderはstdin sourceだけを`createSourceFile`/`transpileModule`へ渡し、source pathを読まない。
- exact compiler optionsとdiagnosticsを固定し、external closure空をresponseへ含める。
- success、syntax/compiler diagnostic、timeout、oversize stdout/stderr、malformed response、nonzero
  exit、 final response後nonzeroを直接testする。
- candidate artifact/moduleをimport、eval、run、testしないことをspyとmodule graphで確認する。

停止条件: default CompilerHost/filesystem resolutionが必要、candidate
codeがcompile時に実行される、固定TCB read closureを作れない、process
cleanupを決定論的に観測できない。

## Increment 3: artifactとAdmissionRecord

- artifact preimage/hash、temp staging、create-only atomic publish、read-backを実装する。
- new publish、same bytes idempotency、existing different bytes、symlink/directory、hard-link
  failure、cleanup failure、concurrent same addressをtestする。
- AdmissionRecord全bindingとgolden vectorを実装する。
- opaque registry writer以外のregister不可、artifact hash単体不可、duplicate exact replay、same ID
  conflict、 bounded ledgerをtestする。
- rejected、Builder failure、publish failure、record failureの到達回数とorphan semanticsをtestする。
- registry/current/DeploymentStateへの既存production writeは行わない。Spike 2専用test
  storeだけを使う。

停止条件: overwrite/deleteを必要とする、artifactからDefinitionを逆生成する、AdmissionRecordなしで
admitted扱いする、current/DeploymentState writeが必要。

## Increment 4: evidence、独立review、acceptance

- requirement→implementation→direct testのtraceability表を結果文書へ作る。
- parser/compiler/runtime/source/dependency/options/profile/policy/closure/artifact
  digestを記録する。
- process/broker/publish/registry/current/DeploymentStateの全counterとnegative fixtureを記録する。
- clean temp rootで全scoped check、module graph、identity preflight、unit/integration
  testを独立に2回、lint、 fmt、diff checkを実行する。
- reviewerがbrief、承認済みplan、Spike 1 contract、実装、test、結果を付き合わせる。
- blocking findingを修正・再検証し、`GO / NO-GO / partial`とremaining riskをまとめ、acceptance Human
  Gateで停止する。

## Test matrixの最低条件

- Request: exact schema、raw/path/ticket/legacy injection、ID長/形式、unknown/missing。
- Authority: missing/fake/expired Grant、wrong sealed/revision/content/profile/policy、reordered
  fields。
- Candidate: rejected outcome、store key mismatch、malformed nested value、hash mismatch、post-call
  mutation。
- Source: empty/limit/limit+1、invalid UTF-8相当、wrong media type、capability非空、contract
  mismatch。
- Dependency:
  static/dynamic/type-only/export-from/import-equals、relative/parent/absolute/file/npm/jsr/http、
  require、Worker/importScripts、triple-slash、source map/AMD。
- Lookalike: comment、normal string、template raw text、identifier suffixで誤拒否0。
- AST: allowed minimum、各allowed method、各forbidden global/node/operator、node/depth/literal境界。
- Builder: request/response/emit/stdout/stderr境界、timeout、closed stdin、partial
  output、nonzero、reap。
- Artifact: deterministic bytes/hash、create-only、same-address concurrency、collision
  simulation、read-back。
- Record:全digest preimage/golden、writer capability、artifact-only
  rejection、全field再導出後のreplay、各field改変拒否、append/conflict/capacity。
- Reservation: registry/artifact最後のslot/byteをdifferent addressで競う2
  request、全failure/throw/cancel pathのrelease、commit後のactual
  accounting、二重commit/release拒否。
- Side effect: rejection stageごとのprocess/broker/publish/register/current/deployment/clock exact
  count。
- Isolation: repository/sibling/global/old asset changes0、network/provider/candidate execution0。

## Acceptance条件

- public Admission入口からraw source、path、Ticket、legacy direct installへ到達できない。
- accepted Spike 1 candidateとunexpired one-purpose Grantのexact bindingだけがpreflightへ進む。
- dependency/directive/unknown syntaxがartifact生成前にfail closedとなり、benign
  lookalikeを誤拒否しない。
- preflight rejectionでBuilder process、broker、artifact publish、registry/current/DeploymentState
  writeが0。
- normal candidateだけがpinned TCBでcompileされ、外部module closure空のdeterministic
  artifactになる。
- artifact publishがcontent-addressed/create-only/atomicで、overwriteが0。
- AdmissionRecordがrevision/content/grant/profile/policy/Builder/parser/compiler/runtime/options/closure/
  artifactを固定し、opaque writerだけが登録できる。
- candidate artifactを一度も実行せず、Spike 3以降のscopeへ進まない。

## Deviationとremaining riskとして先に固定する項目

- Compiler APIはpinned versionのTCBであり、source logicの善性や型安全性全般を保証しない。
- preflight parserはSupervisor process内で動くため、source/AST
  boundを超える強いCPU/memory隔離はない。
- Builder subprocessはtrusted TCBであり、Deno permissionだけをuntrusted candidate
  sandboxとは扱わない。
- artifactのcreate-only/atomic観測はtest filesystem上であり、crash durability、ACL、multi-host
  storeは未保証。
- Admission registryはSpike 2専用in-memory/test storeで、production persistence/署名/PKIは未保証。
- artifactと検証objectのsame-object runtime保証はSpike 3まで未観測。
- accepted artifactのbehavior、resource use、runtime authorityは未観測。

## Human Gateで承認が必要な選択

| gate               | 推奨案                                        | 代替・影響                                    |
| ------------------ | --------------------------------------------- | --------------------------------------------- |
| scope              | Spike 2 no-executionだけ                      | Spike 3混入は不可                             |
| parser/compiler    | exact `typescript@6.0.3`                      | 別製品ならdependency/TCB/testを再設計         |
| dependency取得     | repo-local exact pin + Spike 2 lock           | 未cacheなら取得を別途承認                     |
| subset             | 本計画の狭いAST allowlist                     | node/method追加は具体的にGateで列挙           |
| authority          | sealed ID + host-owned expiring Grant         | Ticket再利用はaction authority混同になる      |
| Builder            | preflight後だけtrusted subprocess             | in-process compileはtimeout/kill不能          |
| temp filesystem    | test専用temp build/artifact storeを許可       | 完全in-memoryではatomic publishを観測できない |
| artifact semantics | create-only atomic publish + read-back        | durability/ACLはSpike 3判断へ                 |
| registry           | opaque writer + bounded in-memory test ledger | production registryはscope外                  |
| AI/provider        | 使用しない                                    | Spike 1 AI observationは別計画                |
| final gate         | independent review後acceptanceで停止          | Spike 3は別計画・別承認                       |

Human Gateでは、推奨案を一括承認するか、変更する行を明示する。承認前は実装を開始しない。
