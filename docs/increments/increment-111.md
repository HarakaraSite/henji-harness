# Increment 111 — async child evidence／diagnostic parity

ステータス: **実装・検証・commit完了（push未実施）**

計画承認日: 2026-09-23

関連: Increment 109（async child V1）、Increment 110（child run contract収束）、
[`henji-host-agent-worker.md`](../architecture/henji-host-agent-worker.md)。

## 目的

実provider確認で、一部childが約102秒後に`child run failed`で終了した一方、durable
historyには合成された`contract_failure`、request／step／tool各0件だけが残り、実際の Worker
outcome、provider evidence、failure diagnosticを判定できなかった。async childも rootと同じWorker
terminal情報を保持し、人間が失敗原因とprovider exchangeをreadbackできる 状態へ収束させる。

## 利用者が必要とする動作

1. collect結果は`max_steps`、`contract_failure`、`cancelled`、`interrupted`をWorkerの exact stop
   reasonで区別し、provider timeout等はstructured diagnostic codeで区別する。
2. childの実request count、steps、tool count、errorをdurable execution rowへ保存する。
3. Workerが返したprovider evidence、failure diagnostic、context manifestをchild executionへ
   帰属させて保存し、historyからevidence id、diagnostic id、capture結果をreadbackできる。
4. parentへ返すtool resultはraw evidenceを注入せず、stop reason、request count、参照id、 diagnostic
   code、capture durabilityだけを簡潔に返す。
5. evidence／diagnostic captureの失敗は観測可能にするが、semantic child settlementまたは有効な
   parent commitを失敗へ変えない。
6. cancel前にprovider evidenceが生成されていなければ、存在しないevidenceを合成しない。

## 実装方針

- `ChildRunRegistry`はterminal messageのexact `LoopOutcome`、`ProviderEvidenceV1`、
  `FailureDiagnosticV1`、`ExecutionContextManifestV2`を保持する。
- Worker outcomeがある経路では、ゼロ件の合成`contract_failure`へ置き換えない。startup failure、
  pre-start cancel、cleanup deadline等、Worker outcomeが存在しないHost-owned経路だけを合成する。
- evidenceはchild session/build/DefinitionへV5 attributionし、既存 `settleNonCanonicalExecution`
  captureへ渡す。diagnosticとcontext manifestも同じsettlementへ渡す。
- `AsyncAgentTerminalResult`へstop reason、provider request count、evidence／diagnostic参照、
  diagnostic code、capture durabilityを追加する。raw request／responseはhistory readbackに留める。
- 自動retryは追加しない。

## 対象範囲

- `worker_host_children.ts`、`async_agents.ts`、既存history row projection。
- focused testとtask登録、本文書への結果追記。
- DB schema migrationは行わない。

## 対象外

- child model routing、automatic retry、raw evidenceのparent context注入、child canonicalization。
- 新しいhistory UI、実provider call。
- 構想、architecture、roadmapの変更。実装後、production capture既定の変更が必要と判明したため、
  architectureだけは意味上の変更内容を別途提示し、利用者承認後に更新した。

## 確認

- completed childのexact outcomeとevidence保存。
- max-steps childの実count／step／tool count保存。
- provider failureのdiagnostic code／idとevidence idの保存・readback。
- capture failureがsemantic resultを変更しないこと。
- evidenceのないHost-owned cancel／interruptionで参照を合成しないこと。
- Increment 109／110 regression、type check、format、lint、`git diff --check`、安定候補で一回の
  authoritative `v0:gate`。

## 停止条件

- DB schema migrationが必要になる。
- evidence／diagnostic captureをsemantic settlementの成功条件にする必要が生じる。
- async childまたはparent commitの外部契約を本計画より広く変更する必要が生じる。

## 実装・検証状況

Worker terminal情報をchild registryから捨てていた経路は修正済みである。exact `LoopOutcome`、provider
evidence、failure diagnostic、context manifestを保持し、noncanonical
settlementへ渡す。collect結果にはstop reason、provider request count、evidence／diagnostic
id、diagnostic code、capture durabilityを返す。history rowの read
projectionには`diagnosticId`を追加した。Worker outcomeが存在しないHost-owned
cancel／interruptionだけは 従来どおり合成outcomeを使い、evidenceを合成しない。

focused確認では、completed、`max_steps`、実Worker例外、evidence capture失敗、pre-start
cancelをproductionと 同じHost/Worker境界で確認した。実Worker例外は従来の`child run failed`／全count
0ではなく、 `model contract failure: child task failed on purpose`、実step、diagnostic
`unknown_code`としてcollectとdurable rowの 双方に残った。Increment
109は9件、110は11件、111は6件成功した。

ただし、2026-09-23に前回の隔離実provider DBをread-onlyで照合すると、root／childを含む全executionが
`capture_profile='normal-v1'`で、`evidence_id`／`diagnostic_id`は全件nullだった。現行production
CLIには
`historyCaptureProfile`の選択入口がなく、既定も`normal-v1`である。このため、上記実装だけでは通常利用時にexact
outcomeとdiagnostic内容は保存できても、raw provider evidence／独立diagnostic
attachmentは保存されない。

利用者承認後、productionの未指定profileを`diagnostic-v1`へ変更し、明示的な`normal-v1` overrideと
provider-free既定は維持した。architectureにも、root／async child双方でprovider evidenceとfailure
diagnosticを保存する既定、capture failureをsemantic settlement／canonical adoptionの失敗条件にしないこと、
collectへraw attachmentを注入しない境界を反映した。DB schema migrationは不要だった。

authoritative `v0:gate`は、当初の安定候補で一回exit 0。その後、実DB照合で判明したproduction capture既定変更を
利用者が承認したため、変更後に具体的理由をもって二回目を実行し、こちらもexit 0だった。実provider call、binary
配置、pushは実施していない。

## DBサイズ観測

- 前回の隔離実provider DB（`normal-v1`、root／child計12 execution）は、現存ファイルでDB 2,240,512 bytes、
  WAL 4,157,112 bytes、合計6,397,624 bytes（約6.10 MiB）。diagnostic attachmentは0件。
- provider-freeの同一completed child 1件をcheckpoint後に比較すると、`normal-v1`と`diagnostic-v1`はいずれも
  DB 225,280 bytes、WAL 0 bytesだった。`diagnostic-v1`のattachment payloadは1,281 bytes、`normal-v1`は0
  bytes。SQLiteのpage割当内に収まり、ファイルサイズ差はこの小さいfixtureでは0 bytesだった。
- 実providerのrequest／response／SSE量を含む増分は今回未測定である。次回の承認済み実provider確認後に、DB＋WALと
  attachment payloadを同じ方法で測定する。
