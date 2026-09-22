# Increment 112 — async child構造の単純化

ステータス: **実装・検証・commit完了（push未実施）**

計画承認日: 2026-09-23

関連: Increment 109（async child V1）、Increment 110（child run contract収束）、
Increment 111（evidence／diagnostic parity）。

## 目的

Increment 109〜111で成立したproduct要件、外部contract、durability、cancellation、parent fence、diagnostic
captureを変えず、gpt-6-astra xhighによる否定的reviewで見つかった重複と不要な構造的複雑さを整理する。

## 採用したreview finding

1. `ChildRunRegistry.closedParents`がchildの有無にかかわらずturnごとに増え続ける。
2. root／childのProviderEvidence V5 attributionとcapture durability投影が二重実装である。
3. async child用provider-free scenarioとbarrier protocolがproduction physical I/Oと同じmoduleに混在する。
4. terminal result／cleanup observationの型が`starting`／`running`を許す。
5. await可能な`cleanupParent()`のtestに、旧contract由来の後追いpollingが残る。
6. 4つのasync child toolが同じRPC、AbortSignal、error変換を複製する。

Blocker／P1 findingはなかった。次の複雑さは要件上必要なため維持する。

- durable admission、semantic terminal、durable settlement、diagnostic captureの分離。
- canonical commit前のchild cleanupと、その後のparent fence再検証。
- childごとの別Worker・別Execution・noncanonical settlement。
- direct registry mockだけでなく実Host／Worker RPCを通るprovider-free integration確認。

## 承認済み計画

1. parent execution開始時だけ明示的にscopeをopenし、cleanup開始時にspawn authorityを閉じ、release時にrunと
   cleanup stateを破棄する。永久tombstoneは持たない。
2. ProviderEvidence V5 attributionとcapture durability field投影を純粋な共通helperへ移す。root／child固有の
   identity選択とsettlementは統合しない。
3. `WorkerProbeModel`、async child scenario識別、BroadcastChannel barrierをprovider-free専用moduleへ分離する。
4. `AsyncAgentTerminalState`を定義し、terminal result、cancel response、cleanup observationへ適用する。
   cleanup observation型はregistry実装から中立なcontract moduleへ移す。
5. `cleanupParent()`後のhistory pollingを一回のreadへ置換する。
6. async tool RPCのcall ID／AbortSignal伝播、cancel再throw、通常error変換を小さいhelperへ集約する。

構想、architecture、roadmap、SQLite schema、外部provider contract、model-visible tool contractは変更しない。

## 実装結果

### Parent scope

- `ChildRunRegistry`は`openParent()`で現在のparent scopeだけを明示的に受理する。
- `cleanupParent()`開始時にscopeをactive集合から外すため、admission中を含むlate spawnは従来どおり拒否する。
- `releaseParent()`はrun、cleanup promise、active markerをまとめて除去する。完了turn UUIDの永久tombstoneは残さない。
- 同じtest identityでopen／cleanup／releaseを繰り返せることと、cleanup後・release前のspawn拒否を確認した。

### Evidence／capture projection

- `worker_history_projection.ts`へroot／child共通の`attributeProviderEvidenceV5()`を配置した。
- execution固有のSession identity、build、Definition、context basisだけをcallerが選び、stop reasonからの
  normalized outcome、complete／partial capture、request ordinal投影は共通化した。
- startup contextがあるのにWorkerがordinalを欠く場合は値を捏造せず、history validatorに拒否させる既存root契約を
  維持した。
- evidence／diagnostic durability fieldのrename投影を`historyCaptureDurability()`へ集約した。semantic settlementと
  child固有のcontext capture投影は従来のownerに残した。

### Provider-free probe

- production provider adapterだけを`worker_physical_io.ts`へ残した。
- deterministic `WorkerProbeModel`、scenario prefix表、barrier decoder／protocol、provider-free bindingを
  `worker_probe_physical_io.ts`へ移した。
- Worker bootstrapはproduction bindingとprovider-free bindingを別moduleから明示的に選ぶ。

### 型とtool RPC

- `AsyncAgentTerminalState`は`completed`／`failed`／`cancelled`／`interrupted`だけを許す。
- durable artifactとHost runtimeが共有するcleanup observationは`worker_child_contract.ts`へ移した。
- `invokeAsyncAgentRpc()`がcall ID、AbortSignal、`TurnCancelledError`再throw、通常error responseを一度だけ扱う。
  4 toolには入力検証、expected response kind、成功projectionだけを残した。

### Test整理

- `cleanupParent()`完了後の最大2秒pollingを削除し、直後のhistory rowがsettledであることをassertする形へ変更した。
- direct registry testはparent scopeを明示的にopenし、production coordinatorと同じauthority境界を使う。

## 検証結果

- Increment 109 focused test: **9 passed**。
- Increment 110 focused test: **12 passed**（parent scope解放regression 1件を含む）。
- Increment 111 focused test: **6 passed**。
- Worker foundation: **25 passed**。
- Increment 89 context revision: **1 passed**。
- Increment 91 Worker liveness: **10 passed**。
- Increment 94 history v7: **21 passed**。
- `v0:check`、`v0:fmt`、`v0:lint`、`git diff --check`: 成功。
- 安定候補に対するauthoritative `v0:gate`: **一回実行しexit 0**。

実provider call、binary build／配置、pushは実施していない。commitは本文書とhandoffを含むcurrent HEAD。
