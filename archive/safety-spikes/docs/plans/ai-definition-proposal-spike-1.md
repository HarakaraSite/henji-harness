# AI Definition Proposal Spike 1 実装計画

## 位置づけとHuman Gate

この計画は、[candidate admission brief](../spikes/candidate-admission.md)のSpike 1と、H-010/H-012の
うちSpike 1で観測可能な範囲だけを実装可能なincrementへ分解する。Spike 0のacceptance packageは
独立review済みGOであり、今回の計画作成依頼をその受入れとSpike 1 planning許可として扱う。

計画作成後はHuman Gateで停止する。Gate承認前には、Spike 1実装、dependency導入、test、credential
参照、AI/model/provider callを行わない。現在Spike 0だけをscopeとする`AGENTS.md`とhandoffは、実装
承認時にSpike 1へ更新しなければならない。

旧two-plugin資産`deno.json`、`deno.lock`、`src/`、`plugins/`、`tests/`は停止済み証拠として保持し、
変更、import、実行、削除しない。Spike 1は新規`spike1/` treeと`deno.spike1.json`へ隔離する。

### Human Gate決定（2026-08-19）

ユーザーの「では進みましょう」を実装許可として受領した。Human Gate表の推奨案、具体limit、digest/
identity、retry/ledger semantics、`ProposalSubmissionV1`とhost-built
Proposalのplan-deltaを承認済みとする。 実AIは選択せず、deterministic
coreだけを実装する。したがってprovider/model/endpoint/credential/network
callはなく、最終判定は`core GO/NO-GO`と`AI end-to-end unobserved`を分ける。

## 目的

host-issued exact-base `RevisionTicket`とuntrusted
originからの`DefinitionProposal`を分離し、Revision
Serviceがscope、budget、provenance、stale/conflictをfail closedで検査したうえで、hidden fieldを
baseから保持したResolved Candidate DefinitionContentとcandidate DefinitionRevision valueをsealできる
かを観測する。

```text
host-owned Ticket Store snapshot + trusted live context
                         │
bounded raw JSON → common Candidate Intake → immutable Proposal
                         │
                         ▼
                 Revision Service
                         │
             exact-base / scope / budget
                         │
                         ▼
       sealed candidate value + in-memory evidence
```

成功・拒否はいずれもimmutableな値として返すだけでpersistしない。accepted
revisionもregistryへ登録せず、 currentまたはDeploymentStateにしない。

## 実証対象

1. Proposalはticket IDだけを参照し、target、exact base、allowed path、budget、evidence
   scope、admission profile、policy versionを再宣言または変更できない。
2. AI、人間、third-party、legacyの全originが同じbounded Candidate Intakeを通る。
3. mutationはticketが許可したlogical pathのfull replacementだけで、patch、fuzzy apply、自動rebase、
   create/rename/deleteを行わない。
4. stale base、unknown field、scope/budget/evidence/provenance違反をmerge前に拒否する。
5. Spike 0のresolverによりhidden fieldをexact baseから保持する。
6. resolved contentのnormalization、canonical content hash、ticket/proposal/provenance
   digestを確定する。
7. seal成功時だけcandidate DefinitionRevision ID/digestを発行する。
8. 同じcontent hashでもbase、provenance、revision IDが異なるrevisionを区別する。
9. rejected proposalはrejection history valueだけを返し、candidate revisionを発行しない。
10. current filesystem、definition/deployment registry、artifact、Admission、plugin
    processへの到達とwriteが 0である。
11. AIを含める場合も、AIはhidden field、Ticket
    authority、credential、current、registryへ到達しない。

## 非対象

- candidate/legacy plugin execution、TypeScript accepted-subset、parser/compiler/runtime
- artifact、Admission Builder/Record、evaluation、approval、promotion、rollback
- registry persistence、current、DeploymentStateのread/write
- fuzzy patch、自動rebase、general plugin framework、Spike 2以降
- AIによるticket作成、scope/budget変更、tool/function call
- 旧two-plugin broker、runner、CLI、Envelope、plugin、test、config、lockfileの再利用

## Spike 0資産のretain

Human Gateで承認後、次を変更せずimportする。

- `DefinitionContentV1`と`normalizeDefinitionContent`
- `RevisionViewV1`、projection、exact-base resolver
- field ownership table
- RFC 8785 JCS、SHA-256 content hash
- golden vectorとroundtrip testの契約

Spike 1からSpike 0 sourceは変更しない。変更が必要ならH-009の証拠へ影響するplan-deltaとして停止する。
canonical schema/hashをSpike 1へcopyせず、正本を二重化しない。

## 入力安全境界

untrusted Proposal APIはtrusted transportが作るbounded frameだけを受ける。JavaScript
object、Proxy、getter、custom prototypeを直接受けない。

```text
bounded UTF-8 bytes
  → duplicate-keyを検出するbounded JSON decode
  → inert plain data
  → strict schema/default-free normalization
  → deep clone + deep freezeしたProposal
```

transportはstreamから最大`maxRawBytes + 1`だけをmaterializeする。上限内ならexact bytesを
`BoundedSubmissionFrameV1`としてIntakeへ渡す。1 byte超過を検出した時点でstreamを打ち切り、full raw
hashを計算せず、Proposal lifecycle外の`oversize_input` service refusalを返す。Revision
Serviceへ任意長の `Uint8Array`を直接渡すAPIは作らない。

標準`JSON.parse`のlast-key-winsは使わない。dependency-free streaming decoderをSpike 1
TCBとして実装し、 UTF-8、duplicate
key、depth/countをvalue構築前または構築と同時に検査する。decoderがこの契約を満たせ
なければ停止し、pinned parser dependencyをplan-deltaとして再検討する。

### IntakeLimitProfile v1と計数規則

Human Gateへ次の推奨profileを提示する。全上限はinclusive、byteはUTF-8
octet、countはProposal文書全体の 合計である。

```ts
type IntakeLimitProfileV1 = {
  schemaVersion: 'intake-limits/v1';
  maxRawBytes: 65_536;
  maxDepth: 16;
  maxObjectProperties: 256;
  maxArrayItems: 128;
  maxDecodedStringBytesEach: 32_768;
  maxDecodedStringBytesTotal: 65_536;
  maxTicketCanonicalBytes: 16_384;
  maxTicketEvidenceScopeEntries: 32;
  maxTicketEvidenceScopeBytesTotal: 4_096;
  maxBaseCanonicalBytes: 131_072;
  maxBaseDepth: 16;
  maxBaseEntries: 512;
  maxLedgerEntries: 16;
  maxOutcomeCanonicalBytes: 196_608;
  maxLedgerOutcomeBytes: 3_145_728;
  maxLedgerCanonicalBytes: 3_145_802;
  maxTrustedIdBytesEach: 256;
  maxTrustedMetadataBytesEach: 1_024;
  maxOriginEvidenceCanonicalBytes: 4_096;
};

type RevisionBudgetV1 = {
  schemaVersion: 'revision-budget/v1';
  maxReplacementCanonicalBytes: number;
  maxResolvedCanonicalBytes: number;
  maxEvidenceRefs: number;
  maxEvidenceRefBytesEach: number;
  maxEvidenceRefBytesTotal: number;
  maxReasonBytes: number;
  maxExpectedEffectBytes: number;
  maxKnownRisks: number;
  maxKnownRiskBytesEach: number;
  maxKnownRiskBytesTotal: number;
  maxPluginOwnedTests: number;
  maxConfigDepth: number;
  maxConfigEntries: number;
};
```

推奨Ticket
budget値はfield順に`32_768, 131_072, 16, 256, 2_048, 2_048, 2_048, 16, 512,
4_096, 64, 8, 128`とする。各fieldはnon-negative
safe integerで、Ticketはこの推奨値以下へ個別に縮小 できるが拡大できない。

- root scalarのdepthは0、root object/arrayは1、object/array内のobject/arrayごとに1加算する。
- object propertiesは全objectのmember occurrence合計、array itemsは全arrayのelement合計。duplicate
  keyも occurrenceとして数えたうえでduplicateとして拒否する。
- stringはJSON escape decode後のUnicode scalar sequenceをUTF-8 encodeしたbyte数で数える。raw bytesは
  escapeを含む受信payload全体で数える。
- replacementはstrict decode後の`mutation.value`をSpike 0 JCSでencodeしたbyte数、resolvedはmerge・
  normalize後のDefinitionContent canonical byte数で数える。
- evidence ref/riskは各値と合計の両方を満たす。evidence refはticketの`evidenceScope`
  entryとのbyte-for- byte exact matchとし、duplicateを拒否する。prefix、glob、case
  folding、Unicode再正規化を行わない。
- config depthはconfig root objectを1、entry countは全nested object memberとarray
  elementの合計とする。 plugin-owned test countとは独立に検査し、合算しない。
- Ticketのbudget値は上記profile以下でなければticket自体を拒否する。共通Intake
  limitは全ticketに先行する hard ceiling、Ticket budgetはその内側のrequest-specific ceilingである。
- ticketはcanonical 16,384 bytes、`allowedPaths`はexactly 1、evidence scopeは32 entriesかつ合計4,096
  decoded UTF-8 bytes以下とする。baseはnormalize/hash前のbounded descriptor traversalでdepth
  16、全object member+array element 512以下を確認し、trusted issuerが記録したcanonical byte
  count/profile digestを 検証する。実測canonical bytesも131,072以下でなければ拒否する。
- ledger snapshotは16 entries、各outcome canonical 196,608 bytes、outcome byte合計3,145,728
  bytes、完全な ledger canonical bytes 3,145,802以下とする。各ID/hashは256
  bytes、policy/profile等のtrusted scalar metadataは1,024 bytes、origin evidence canonical
  bytesは4,096以下とする。
- 既存submissionのretry/conflict照合後、新規submissionだけ`entries + 1`と
  `sum(current outcome canonical bytes) + maxOutcomeCanonicalBytes`でworst-case
  reservationする。ledger JCS
  sizeは`59 + sum(outcomeBytes) + max(0, entryCount - 1)`である。59は空ledger
  `{"entries":[],"schemaVersion":"revision-outcome-ledger/v1"}`の固定UTF-8
  byte数で、comma数を別に加える。
  16件最大時は`59 + 3,145,728 + 15 = 3,145,802`となる。entries、outcome合計、prospective完全ledgerの
  いずれかが超える場合はID/clock消費前にterminal `ledger_capacity`を返す。生成outcomeはappend前に
  196,608 bytes以下、生成ledgerは3,145,802
  bytes以下をinvariantとして再検査する。paging、persistence、 compactionはSpike 1外である。
- failure
  precedenceは`raw-bytes → UTF-8 → JSON syntax → duplicate key → depth → property count → array
  items → string bytes → Proposal schema → ticket → stale → scope/evidence → Ticket budget → merge → resolved
  budget → seal`と固定する。同stageではdecoderが入力offset順、schemaは定義済みfield順で最初の一件を返す。

testは各limitの直下、一致、1超過、複数同時超過時のprecedenceを直接検証する。推奨値の変更はschema
version/normalizer digestを変える。

## Object model

### RevisionTicket v1

```ts
type RevisionTicketV1 = {
  schemaVersion: 'revision-ticket/v1';
  ticketId: string;
  target: {
    pluginId: string;
    namespace: string;
    kind: 'text-transform';
  };
  exactBase: {
    revisionId: string;
    contentHash: string;
    deploymentStateDigest: string | null;
  };
  allowedPaths: readonly RevisionPath[];
  mutationKind: 'full-replacement';
  budget: RevisionBudgetV1;
  evidenceScope: readonly string[];
  admissionProfile: string;
  policyVersion: string;
};
```

全fieldはhost-ownedである。Intakeはticket本体を受けず、ticket IDでtrusted immutable Ticket Store
snapshotから取得する。new-plugin `base = null`はこのSpike 1から除外し、既存exact baseだけを扱う。

### Proposal submissionとDefinitionProposal v1

```ts
type ProposalSubmissionV1 = {
  schemaVersion: 'proposal-submission/v1';
  replacement: JsonValue;
  reason: string;
  evidenceRefs: readonly string[];
  expectedEffect: string;
  knownRisks: readonly string[];
};

type DefinitionProposalV1 = {
  schemaVersion: 'definition-proposal/v1';
  proposalId: string;
  submissionId: string;
  ticketId: string;
  mutation: {
    kind: 'full-replacement';
    path: RevisionPath;
    value: JsonValue;
  };
  reason: string;
  evidenceRefs: readonly string[];
  expectedEffect: string;
  knownRisks: readonly string[];
};
```

全originのuntrusted raw JSONは`ProposalSubmissionV1`だけである。trusted
callerは別引数としてhost-issued
`submissionId`、`ticketId`、ticketから選んだ単一`authorizedPath`、origin
evidenceを渡す。Intakeはこれらを 結合してDefinitionProposalを作る。raw
payload中のID、path、target、base、budget、policy、origin、host identity、hidden fieldはunknown
fieldとして拒否する。これによりAIを含むauthorはauthority値を返さない。

`proposalId`はDigest domain表どおり、完全なSubmission binding digestとnormalized
Submissionをpreimageに 決定論的に導出し、同じtrusted submissionとraw bytesのretryで同じ値になる。

最小incrementでは一ticket・一visible logical pathのfull replacementを推奨する。path候補は`source`、
`manifest`、`pluginOwnedTests`、`config`であり、leaf
path、parent/child、escape表現を許さない。briefの
「single-file」を`source.text`だけと解釈する案との選択はHuman Gateで固定する。

### Provenanceとlive context

```ts
type CandidateOrigin = 'ai' | 'human' | 'third-party' | 'legacy';

type IntakeProvenanceV1 = {
  origin: CandidateOrigin;
  originalContentHash: string;
  normalizerDigest: string;
  hostPluginId: string;
  hostNamespace: string;
  originEvidenceDigest: string;
};

type LiveRevisionContextV1 = {
  baseRevisionId: string;
  baseContentHash: string;
  deploymentStateDigest: string | null;
  policyVersion: string;
};

type BaseDefinitionSnapshotV1 = {
  schemaVersion: 'base-definition-snapshot/v1';
  revisionId: string;
  contentHash: string;
  target: RevisionTicketV1['target'];
  resourceProfileDigest: string;
  canonicalByteCount: number;
  structuralDepth: number;
  structuralEntryCount: number;
  content: DefinitionContentV1;
};
```

originとhost identityはtrusted callerが別引数で付与し、raw Proposalから受けない。original
hashは受信した raw bytes、normalizer digestはintake schema/decoder/limit profile、origin
evidenceはraw credentialや 個人情報を含まないhost-side証拠を対象とする。Revision
Serviceはfilesystem/registryを読まず、trusted callerが渡すlive context、base snapshot、ticket exact
baseの revision ID/content hash/targetを完全一致比較する。base
contentを再normalize/hashし、snapshotのcontent hashとも一致させる。全inputをclone/freezeし、caller
mutationから隔離する。stale確認前にbase storeを lookupせず、service requestがimmutable
snapshotを直接受ける。

### Sealed candidateとDefinitionRevision

```ts
type CandidateDefinitionRevisionV1 = {
  schemaVersion: 'definition-revision/v1';
  revisionId: string;
  contentHash: string;
  baseRevisionId: string;
  baseContentHash: string;
  provenanceDigest: string;
  proposalDigest: string;
  ticketDigest: string;
  createdAt: string;
  revisionDigest: string;
};

type SealedCandidateV1 = {
  proposalId: string;
  sealedProposalId: string;
  ticketDigest: string;
  proposalDigest: string;
  provenance: IntakeProvenanceV1;
  resolvedContent: DefinitionContentV1;
  contentHash: string;
  revision: CandidateDefinitionRevisionV1;
};
```

`sealedProposalId`はproposal/ticket/base/live/provenance digestとresolved content
hashから決定論的に導出し、 Admissionが将来参照するsealed identityとする。`proposalId`はIntake
identityとして併記し、両者を混同しない。

ID sourceとclockはtrusted portとして注入し、testでは固定sequenceを使う。revision digestにはrevision
ID、
content/base、ticket/proposal/provenance、createdAtを含める。artifact、Admission、current、DeploymentState
は含めない。sealed valueはdeep clone/freezeし、入力の後続mutationから隔離する。

### Outcome ledger、retry、rejection history

```ts
type ProposalRejectionV1 = {
  intakeId: string;
  proposalId: string | null;
  ticketId: string | null;
  origin: CandidateOrigin;
  originalContentHash: string;
  stage: 'intake' | 'ticket' | 'stale' | 'scope' | 'budget' | 'merge' | 'seal';
  code: RejectionCode;
  detailsDigest: string;
};

type SubmissionBindingV1 = {
  submissionId: string;
  originalContentHash: string;
  ticketId: string;
  authorizedPath: RevisionPath;
  origin: CandidateOrigin;
  originEvidenceDigest: string;
  hostPluginId: string;
  hostNamespace: string;
  normalizerDigest: string;
  intakeProfileDigest: string;
};

type ProcessingBindingV1 = {
  submissionBindingDigest: string;
  proposalDigest: string;
  ticketDigest: string;
  baseSnapshotDigest: string;
  liveContextDigest: string;
  provenanceDigest: string;
  revisionBudgetDigest: string;
};

type RevisionOutcomeV1 =
  | {
    status: 'accepted';
    submission: SubmissionBindingV1;
    processing: ProcessingBindingV1;
    processingKey: string;
    candidate: SealedCandidateV1;
  }
  | {
    status: 'rejected';
    submission: SubmissionBindingV1;
    processing: ProcessingBindingV1 | null;
    processingKey: string | null;
    rejection: ProposalRejectionV1;
  };

type RevisionOutcomeLedgerV1 = {
  schemaVersion: 'revision-outcome-ledger/v1';
  entries: readonly RevisionOutcomeV1[];
};

type RevisionServiceRefusalV1 = {
  status: 'refused';
  code: 'oversize_input' | 'ledger_capacity' | 'submission_conflict';
  submissionId: string | null;
  detailsDigest: string;
};

type RevisionServiceResultV1 =
  | { status: 'recorded'; outcome: RevisionOutcomeV1; ledger: RevisionOutcomeLedgerV1 }
  | { status: 'replayed'; outcome: RevisionOutcomeV1; ledger: RevisionOutcomeLedgerV1 }
  | { status: 'refused'; refusal: RevisionServiceRefusalV1; ledger: RevisionOutcomeLedgerV1 };
```

Revision Serviceはledger snapshotを入力し、新しいledger snapshotとoutcomeを返すpure append
operationと
する。既存entryを変更・削除せず、accepted/rejectedを同じ順序付きledgerに記録する。persistent storeは
作らない。

Submission bindingはraw hash計算後、JSON decodeやticket
lookup前に全stageで構築できる。最初にledgerを submission IDで検索し、全binding
fieldが一致すればmalformed rejectionを含む既存outcomeをそのまま返し、
ID/clockを消費せず追記しない。一fieldでも異なればservice-level `submission_conflict`を返すが、同じ
submission IDを二重記録しないためledgerへは追記しない。

ledgerに存在しないsubmissionだけdecode/ticket/base/live検査へ進む。step 7のticket lookup/digestと
Processing binding構築が完了する前のmalformed JSON、schema/unknown、unknown/invalid ticket
rejectionは `processing: null`とする。step 7完了後のstale/scope/budget/merge/seal
rejectionとsuccessだけが Processing binding/keyを持つ。失敗原因を修正したretryには新しいhost-issued
submissionIdが必要である。 同内容でも別
submission/provenance/baseなら別Proposal・seal・revisionになる。raw source、credential、hidden
field、 private pathをledgerへ複製しない。

ledgerはtrusted host orchestrationだけが完全なsnapshotを保持してRevision Serviceへ渡す。untrusted
SubmissionやAIはledgerへアクセスできない。Spike 1は悪意あるtrusted hostによるsnapshot省略・改ざんを
防ぐ永続性を保証せず、TCB前提とremaining riskへ記録する。

### Digest domain表

raw hash以外は`{ domain, value }`をSpike 0 JCSでencodeしたbytesのSHA-256とし、すべて
`sha256:<lowercase hex>`で表す。

| Digest / ID               | domain                               | `value`のfield                                                                 |
| ------------------------- | ------------------------------------ | ------------------------------------------------------------------------------ |
| original content hash     | `henji/spike1/raw/v1`                | domain UTF-8 + NUL + raw bytes（JCS外）                                        |
| intake profile digest     | `henji/spike1/intake-profile/v1`     | profile全field                                                                 |
| normalizer digest         | `henji/spike1/normalizer/v1`         | decoder source hash、Submission schema、profile digest                         |
| origin evidence digest    | `henji/spike1/origin-evidence/v1`    | trusted opaque origin evidence object                                          |
| submission binding digest | `henji/spike1/submission-binding/v1` | `SubmissionBindingV1`全field                                                   |
| proposal ID               | `henji/spike1/proposal-id/v1`        | submission binding digest、normalized Submission                               |
| proposal digest           | `henji/spike1/proposal/v1`           | normalized Proposal全field（proposal IDを含む）                                |
| ticket digest             | `henji/spike1/ticket/v1`             | normalized Ticket全field                                                       |
| base snapshot digest      | `henji/spike1/base-snapshot/v1`      | metadata全fieldとcontent hash。content本体は除く                               |
| live context digest       | `henji/spike1/live-context/v1`       | live context全field                                                            |
| provenance digest         | `henji/spike1/provenance/v1`         | provenance全field                                                              |
| revision budget digest    | `henji/spike1/revision-budget/v1`    | budget全field                                                                  |
| processing key            | `henji/spike1/processing/v1`         | `ProcessingBindingV1`全field                                                   |
| sealed Proposal ID        | `henji/spike1/sealed-proposal/v1`    | proposal/ticket/base/live/provenance digest、content hash                      |
| rejection details digest  | `henji/spike1/rejection-details/v1`  | stage、code、redacted details                                                  |
| revision digest           | `henji/spike1/revision/v1`           | revisionの`revisionDigest`以外                                                 |
| outcome digest            | `henji/spike1/outcome/v1`            | status、bindings、sealed ID/revision digest/content hashまたはrejection全field |
| ledger digest             | `henji/spike1/ledger/v1`             | ordered outcome digest配列                                                     |
| source file digest        | `henji/spike1/source-file/v1`        | individual source file raw UTF-8 bytes（JCS外）                                |
| decoder source digest     | `henji/spike1/decoder-source/v1`     | ordered `{ logicalPath, sourceHash }` manifest                                 |
| service refusal digest    | `henji/spike1/service-refusal/v1`    | refusal code、submission ID、redacted details                                  |

source file digestだけはdomain UTF-8 + NUL + raw source bytesをhashする。decoder source manifestは
`spike1/src/intake_json.ts`、`definition_proposal.ts`、`limits.ts`をentrypointとする`deno info --json`
module graph closureのうち、`spike1/src/`と`spike0/src/`にある全file moduleを対象とする。checkout
rootを 除いたrepository-relative logical
pathで昇順sortし、各fileを`{ logicalPath, sourceHash }`としてJCS
array化する。そのmanifestをdecoder-source domainでhashし、normalizer profileへ注入する。all-deny
coreは filesystemを読まない。behavior helperの変更/追加、非closure file追加、checkout
root変更、file境界変更、 field順序、domain/object種別、exact preimage fixture、各domainのgolden
vectorを直接testする。

## 処理順序

failure後は後続stageへ進まない。

1. 既存ledger snapshotのschemaとcount/byte hard ceilingだけを検査する。
2. raw byte budget、raw hash、trusted envelopeからSubmission bindingを構築する。
3. submission IDでledger retry/conflictを検査する。
4. ledgerにない新規submissionだけworst-case append capacityを予約する。
5. UTF-8、duplicate-key/depth/countを含むbounded JSON decode。
6. Proposal Submission schema、unknown field、limit検査。
7. trusted envelopeとorigin/provenanceを結合し、proposal IDを導出する。
8. ticket lookup、ticket/base snapshot metadata hard ceiling、各digest、Processing
   binding/keyの構築。
9. ticket、base snapshot、live contextのrevision/content/target/deployment/policy完全一致。
10. full-replacement kind、allowed path、scope、evidence、budget検査。
11. bounded traversal後にexact base content hashを再計算。
12. Spike 0 visible projectionの指定値全体を置換。
13. Spike 0 resolverによるhidden-preserving mergeとfull normalization。
14. resolved canonical byte budgetとcontent hash。
15. sealed Proposal IDを決定論的に導出する。
16. 初回成功だけtrusted ID/clockを各1回呼び、candidate revision ID/digestを発行する。
17. outcome sizeを検査し、既存ledgerへ一度だけappendして新しいsnapshotとともに返す。

## Deterministic coreとAI境界

### 必須core

Ticket、Proposal、origin、budget、merge、seal、revision、rejectionはpure/in-memory処理とし、synthetic
raw JSON fixturesだけで完全にtestする。provider/model、credential、network、旧brokerをimportしない。

### 条件付きAI observation

実AIはprovider/model/endpoint/credential resolver/call budgetをHuman
Gateで明示選択した場合だけ追加する。 選択しない場合はdeterministic
coreだけを実装し、H-010を`core GO / AI end-to-end unobserved`と判定する。

AI adapterはhidden fieldを除いたRevision View、author context、変更対象の説明だけを送る。opaque
ticket IDやpathをAIへ返させず、AI responseは`ProposalSubmissionV1`だけとする。host adapterが保持する
trusted `submissionId`、ticket ID、authorized path、origin evidenceとraw response
bytesを、他originと同じ Candidate Intakeへ別引数で渡す。credentialとendpoint resolutionはhost-owned
adapterに閉じ、tool/ function callを拒否する。timeout、retry、request/response bytes、call
count、provider/model/parameter
digestを記録する。実AIを選択しない場合、このcontractは計画済み・未実装、AI
end-to-endは未観測とする。

## 予定ファイル

| File                                                    | 責務                                                 |
| ------------------------------------------------------- | ---------------------------------------------------- |
| `deno.spike1.json`                                      | Spike 1専用task、fmt/lint scope、外部dependency方針  |
| `spike1/src/limits.ts`                                  | versioned limit profileとbudget accounting           |
| `spike1/src/intake_json.ts`                             | bounded UTF-8/JSON decode、duplicate key、inert data |
| `spike1/src/revision_ticket.ts`                         | Ticket schema/digest、snapshot lookup port           |
| `spike1/src/definition_proposal.ts`                     | Proposal strict schema、immutable normalization      |
| `spike1/src/provenance.ts`                              | origin/raw hash/normalizer/origin evidence           |
| `spike1/src/revision_context.ts`                        | trusted live contextとstale比較                      |
| `spike1/src/base_definition_snapshot.ts`                | exact-base content/identity/hashのimmutable snapshot |
| `spike1/src/mutation_scope.ts`                          | full replacement、path/scope/evidence/budget検査     |
| `spike1/src/revision_service.ts`                        | exact-base mergeとseal orchestration                 |
| `spike1/src/definition_revision.ts`                     | revision ID/digest、same-content別identity           |
| `spike1/src/revision_outcome.ts`                        | immutable success/rejectionとappend-only ledger      |
| `spike1/src/observability.ts`                           | in-memory counters/events、secret/source非保持       |
| `spike1/tools/check_module_graph.ts`                    | `spike1/`と承認済み`spike0/src/`だけのclosure検査    |
| `spike1/tests/assert.ts`、`*_test.ts`                   | dependency-free direct testsと単一entrypoint         |
| `docs/spikes/ai-definition-proposal-spike-1-results.md` | acceptance package                                   |

AI observationを承認した場合だけprovider-neutral port、承認済みprovider adapter、local contract
test、明示 smoke testを追加する。旧資産からcodeを再利用しない。

## Increment 1: scope、retention、bounded intake

- 実装承認時に`AGENTS.md`とhandoffをSpike 1へ更新する。
- Spike 0 moduleを変更せずimportする。
- limit profile、bounded decoder、Submission/Proposal、deterministic ID、4-origin
  provenanceを実装する。
- malformed UTF-8/JSON、duplicate/unknown field、active object経路、各limit境界、authority
  field注入、 caller mutationを直接testする。
- 全originが同じIntakeを通り、originをpayloadから変更できないことをtestする。
- raw payloadがticket/pathを含まないことと、trusted envelopeだけが両者を付与することをtestする。
- accepted/rejected双方を起点にSubmission
  binding各fieldを一つずつ変え、完全一致retryだけが既存outcomeを
  返し、不一致は`submission_conflict`になることをtestする。
- oversize frameは`maxRawBytes + 1`で打ち切り、full hash、decoder、ledger
  append、ID/clockが0回であることを testする。

停止条件: raw bytes/depthをboundedにparseできない、duplicate
semanticsを固定できない、origin別bypassが 必要、Spike 0正本を変更する必要がある。

## Increment 2: Ticket、stale、scope enforcement

- host-owned Ticket Store snapshot、Ticket digest、base Definition snapshot、trusted live
  contextを実装する。
- revision/content/deployment/policy mismatchを個別にstale rejectする。
- allowed path完全一致、full replacement、budget/evidence scopeを検査する。
- prefix/leaf/parent/child/escaped/duplicate/scope外path、ticket-like field注入をrejectする。
- rejection後のlookup/merge/ID発行到達回数をspyで直接assertする。
- ticket/base/live三者の各identity/hash mismatch、base再hash、caller mutation隔離を直接testする。
- ticket/base/ledgerのsize/depth/count上限と、上限検査前にSpike 0
  normalize/hashへ到達しないことをtestする。
- malformed JSON、schema/unknown、unknown/invalid
  ticketではprocessing/keyがnull、stale以降では両方が 存在することを直接testする。
- ledger capacityとsubmission conflictはservice refusalとなり、ledger不変、ID/clock 0回をtestする。
- entry count満杯とbyte capacity満杯のそれぞれで、既存accepted/rejected
  retryはreplayでき、新規submission だけが`ledger_capacity`になることをtestする。
- empty、1、15、16 entriesでwrapper/separator式をgolden検証し、完全ledger上限一致と1 byte超過を
  ID/clock消費前に直接testする。

停止条件: Revision Serviceによるcurrent/registry read、自動rebase、ticket
authorityのProposal複製が必要。

## Increment 3: hidden-preserving resolutionとseal

- Spike 0 resolverで指定visible fieldだけを置換し、hidden fieldをbaseから保持する。
- resolved content、ticket、Proposal、provenanceをcanonicalize/hashする。
- trusted ID/clockでcandidate revisionを発行し、sealed immutable resultを返す。
- deterministic proposal/sealed IDとappend-only outcome ledgerを実装する。
- no-op/変更、exact-base
  mismatch、same-content別base/provenance/ID、入力後続mutationを直接testする。
- rejection時revision発行0、success時artifact/Admission/registry/current write 0をassertする。
- 同一Submission binding retry、同内容別submission、submission conflict、失敗後の新submission
  retryで、ledger append数、ID/clock消費数、revision identityを直接testする。
- empty ledger初回成功、same-binding retry、既存accepted/rejected retryでID/clock call
  countが順に1、0、0 であることをtestする。

停止条件: hidden fieldをProposal/AIへ渡す必要、content hashだけをrevision
identityにする必要、persistしない とsealできない、Spike 0 source変更が必要。

## Increment 4: 条件付きAI observation

Human Gateで実AIを選んだ場合だけ実施する。

- provider-neutral host portと選択済みadapterを追加する。
- local fakeでpromptのhidden/authority/credential非包含、tool拒否、timeout/oversize/malformed
  response、 共通Intake投入をtestする。
- 承認済みreal smokeではexact provider/model/parameters、call
  count、byte数、結果digestだけを記録し、 credential値は記録しない。
- candidate code、plugin、artifact、registryを実行・変更しない。

停止条件: provider/model未選択、credential resolver/endpoint/tool無効化/structured
output/limitが未確認、実 smokeなしでAI end-to-end GOを要求される。

## Increment 5: evidence、独立review、acceptance

- accepted/rejected outcome、budget使用量、各stage到達回数、zero-writeをin-memory
  evidenceで記録する。
- raw source/credential/hidden field/private pathがevent serializationへ入らないことをtestする。
- requirements-to-code/test mapping、dependency closure、deviation、remaining
  riskを結果文書へまとめる。
- reviewerが要件、計画、code、tests、resultsを独立に突合する。
- blocking findingをlocal-fixし全検証を再実行する。concept assumption failureはDiscoveryへ戻す。
- H-010/H-012のSpike 1範囲をGO/NO-GO/partial判定し、acceptance Human Gateで停止する。

## Testと検証方針

testは新規`spike1/tests/all_test.ts`だけをentrypointとし、旧testを実行しない。Spike 0
retain承認後だけ module graphに`spike0/src/`を許す。

1. Spike 1とapproved Spike 0だけのscoped type check。
2. test前に`deno info --json` closure allowlist preflight。
3. `--no-remote --no-npm --no-lock`とread/write/net/env/sys/run/FFI/import全面拒否でcore testを2回。
4. scoped lintとformat check。
5. forbidden import/API/concept searchと`git diff --check`。
6. 独立reviewerによるrequirements/code/tests/results突合。
7. AIを承認した場合だけ、unit testから分離した明示commandで最小network permissionのsmoke。

size/depth/countはlimit直下、境界一致、1超過と複合超過precedenceをtestする。deterministic
ID/clockを注入し、same-content別 revisionを再現する。stale/scope/budget
rejection後のmerge/hash/ID発行が0であることをcounterで直接 観測する。

## Acceptance package

`docs/spikes/ai-definition-proposal-spike-1-results.md`に次を記録する。

- H-010/H-012要件と実装/test/実測の対応表
- retainしたSpike 0 schema、ownership、resolver、JCS/hash
- Ticket/Proposal/origin/provenance/revision/rejection schemaとdigest domain
- exact-base、path、budget、evidence、duplicate-key、limit、ID/retryの承認値
- accepted/rejected outcomeとstage到達証拠
- append-only ledgerの順序、retry deduplication、ID/clock消費証拠
- fuzzy/rebase、artifact、Admission、plugin execution、registry/current writeが0の証拠
- AIを行った場合のprovider/model/parameter/call count。credential値は含めない
- dependency closure、review結果、deviation、remaining risk
- deterministic coreとAI end-to-endを分けたGO/NO-GO/partial
- Spike 2へ進む、狭める、方向転換、保留、終了の次判断

## 完了条件

- Ticket authorityをProposalが変更できない。
- 全originが同じbounded Intakeを通る。
- hidden fieldをProposal/AIへ返さずexact baseから保持する。
- stale、unknown、scope、budget、evidence、provenance違反をfail closedでrejectする。
- fuzzy apply、自動rebase、rejection後のmerge/ID発行が0。
- success時だけcandidate revision valueを発行し、same-content別revisionを区別する。
- Proposal rejectionをappend-only in-memory ledgerへ一度だけ残し、retryで重複発行しない。
- oversize、ledger capacity、submission conflictはservice
  refusalとしてledgerを変更せず、ID/clockが0。
- rejected/acceptedのregistry登録、current化、DeploymentState writeが0。
- artifact、Admission、candidate/plugin executionが0。
- independent reviewにblocking findingがない。
- fixture-onlyなら`core GO / AI end-to-end unobserved`を明記する。

## Human Gateで承認が必要な選択

| 項目              | 推奨案                                               | 代替・影響                                                  |
| ----------------- | ---------------------------------------------------- | ----------------------------------------------------------- |
| Spike 0           | GOを受入れ、moduleを変更せずretain/import            | 不受入れなら停止                                            |
| mutation          | 一ticket・一visible top-level pathのfull replacement | `source.text`だけなら狭い。full Viewならscope検査観測が弱い |
| Proposal split    | raw Submissionからticket/pathを除きhostがProposal化  | 正本の「AIがticket IDを含むProposal」より狭いplan-delta     |
| new plugin        | `base = null`を除外                                  | 含めるにはhost template lifecycle追加                       |
| input             | raw UTF-8 JSON bytesだけ                             | active object入力は境界を弱める                             |
| duplicate key     | dependency-free bounded decoderでreject              | 不成立ならpinned dependencyをplan-delta                     |
| limits            | 記載の`IntakeLimitProfileV1`/`RevisionBudgetV1`      | 値変更はGateで全fieldを指定                                 |
| Proposal ID       | trusted submission envelopeから決定論的に導出        | random IDならdurable lookupが必要                           |
| sealed ID         | proposal/ticket/base/live/provenance/contentから導出 | Proposal IDとの同一化はlifecycleを曖昧にする                |
| revision ID/clock | 初回sealだけtrusted injected sourceを消費            | 形式・精度は下記推奨値                                      |
| retry             | submission ID/binding一致は既存outcomeを返す         | 毎回新revisionならretryで履歴増加                           |
| history           | pure append-only in-memory ledger snapshot           | persistenceはscope拡張                                      |
| origin evidence   | host-side opaque digest                              | origin認証方式を別途固定                                    |
| AI                | まずdeterministic core、実AIは条件付き               | 実AI必須ならprovider/model等の事前確認が必要                |
| gate              | independent review後にacceptance gateで停止          | Spike 2は別承認                                             |

`Proposal split`はmaterialなplan-deltaとして明示承認を要する。正本の「AIがticket
IDを含むProposalを返す」は、 AI raw outputではなく、共通Intakeがtrusted envelopeとraw
Submissionを結合した後のimmutable `DefinitionProposalV1`がticket
IDを持つことで満たす、と解釈する。承認されなければ、opaque ticket ID/pathを AIへ渡してexact
match検査する代替案へ計画を戻す。

### 具体値が必要な項目

推奨するlogical pathは4個の列挙literal、digest/決定論的IDは`sha256:<lowercase hex>`、revision IDは
trusted portが返す`revision:<64 lowercase hex>`、`createdAt`はUTC RFC 3339（millisecond、`Z`）、
normalizer digestはdomain表のdecoder source digest、Submission schema、profile digest、origin
evidenceはhost側opaque JSONのdigestとする。revision digest対象は
CandidateDefinitionRevisionV1の`revisionDigest`以外の全field、proposal/sealed IDのdomain separatorは
`henji/spike1/<identity>/v1`とする。

実装許可前に、この推奨profile、logical path、revision/proposal/sealed ID、createdAt、digest対象、
normalizer digest、origin evidence、retry/ledger
semanticsを一括承認またはfield単位で変更する必要がある。 実AIを含める場合はさらに
provider、model、endpoint、credential参照方法、structured output、tool無効化、timeout、retry、call
count、request/response limit、費用・外部通信を承認する。

これらを実装者が推測で埋めず、Human Gate回答をこの計画へ追記してからSpike 1を開始する。
