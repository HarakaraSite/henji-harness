# Increment 88 — B6表示凍結の現象と原因（調査記録）

ステータス: **調査完了（根本修正はIncrement 89で実装・検証完了）**

基準commit: `ce69ace3`

調査日: 2026-09-19

関連: 通常利用メモB6、Increment 86（journal batching）、Increment 87（index＋再検証skip）。

根本修正と実provider検証結果: [`increment-89.md`](increment-89.md)

## 現象

- 長いturn（10数 model steps、web調査、数千のprovider観測）で、TUIの`working 00:xx`経過時間が増えず、
  spinner・再描画・`Esc`等の表示更新が止まる。一方で実行は進行し、turnは`ok=1 stop=final`で正常完了する。
- 観測: execution `1eb2a662`（02:33:47〜02:41:20）で`execution_observations` 9848件、1秒あたり最大約2,900件の
  バースト（`provider_parser_transition`／`provider_sse_event`／`provider_response_bytes`）。
  henji processは実行中CPU 68〜76%、settle後は低下。
- tmux実機でも、busy経過時間が最大で**約10分停止**した後に正常完了する事例があった（表示だけが凍結し、実行と
  記録は進む）。

## 確認できた増幅経路と測定結果

### 1. context materializationがHost main threadを長時間占有する

- `context_observation`は毎model stepでrequestの**全item**（system/message/tool_contract/provider_wire_body）を
  base64で再送する。Host validationとmaterializationには、current request itemのdecode／digest／blob処理に加え、
  source journalの探索と、途中のcontext markerから過去requestをhydrateする経路が含まれる。source上、これらは
  model stepと累積context、source relation、journal eventを掛け合わせ得る。
- 実測（段階計測）: 単一`context_observation`を処理する`ctx` phase全体が**最大17,343ms**。このphaseの内訳は
  個別計測しておらず、decode、digest、既存blob照合、source探索、hydrateのどれが何msを占めたかは未確定である。
- `store.tx`のbodyが3〜12件のbatchで最大29秒、`busy.tick-gap`最大52.5秒を観測した。したがって、context
  materialization pathがHost main threadを長時間占有し、120ms周期のbusy timer（経過時間・spinner・redraw）を
  止めることは測定で確認できた。特定の内部subpathを単独の支配要因とはまだ断定しない。

### 2. `appendExecutionEventTx`のper-insert `max(worker_sequence)`走査（副次、対処済み）

- `appendExecutionEventTx`が1イベントごとに`SELECT max(worker_sequence) ... WHERE execution_id=?`を実行する。
  `worker_sequence`にindexが無く、PKの`execution_id`前方一致で当該executionの全行を走査する。
- 実測: `max(ordinal)`=0.01msに対し`max(worker_sequence)`=**0.8〜1.5ms/回**（10,257行時）。
  バッチ256件のflushが、256行時16ms→10,240行時**223ms**とO(n)増大。
- 対処: Increment 87で`execution_observations(execution_id, worker_sequence)`のpartial indexを追加し、
  オフラインでバッチ256件が**約11ms一定**、5件flushが0.4msになることを確認。`max(ordinal)`はPKで0.01ms。
- ただし実turnのstallは残ったため、このindex走査だけでは長時間stallを説明できず、上記context materialization
  pathが残った。

### 3. per-eventの接続open/closeとトランザクション（副次、対処済み）

- 変更前は観測1件ごとに`openSynchronousDatabase()`→`BEGIN IMMEDIATE`→`COMMIT`→`close()`。
  Increment 86で1接続1トランザクションのbatch flush（256件/25ms）へ変更し、traceability（1行=1イベント）は維持。
- `BEGIN IMMEDIATE`と`COMMIT`自体は0ms台で、stallの直接原因ではない。

### 4. `terminal.write`の長時間drain（副次）

- 計測で1回のterminal writeが最大33.6秒。CoalescingWriterは非同期だが、再描画の最新frameが滞る要因の一つ。
  主因ではない。

## 個別計測で大きな寄与を示さなかった要因

- 計測対象のprovider observation eventに対するenqueue検証（`structuredClone`＋`validateExecutionEvent`）:
  0.003ms/event。この計測は完全なmodel request／source sidecarの履歴観測cloneを対象としていない。
- `canonicalJson`/`canonicalJsonBytes`: 2.35MBで16.5ms（O(n²)懸念は実害なし）。
- markdown renderer・log内容: live本文は小さく主因ではない。
- payloadサイズ: 最大318 bytes（durable観測は切り詰め済み）。
- raw SQLite commit/fsync: 1ms未満。`BEGIN`/`COMMIT`は0ms台。

## 対処の現状

- 実装済み（green、`v0:gate` exit 0）: Increment 86（batch flush、1行=1イベント維持）、Increment 87のindex。
- Increment 87の(e)（既存blobの再decode/re-digest/byte比較の省略、`insertContextBlobTx`のcontent-addressed化）:
  `v0:check`、`increment_40`/`41`/`42`/`50`/`86`/`87`、gateはpass。しかし**tmux実機でstallは残存**
  （経過時間が約96秒停止）。
- 参照化（Increment 88の当初案: materialize済みitemの`bytesBase64`省略）は実装したが、`increment_42`の6件が
  `durable execution settlement failed`で失敗したため**revert**。
  - 参照item自体（parent/relationのblob存在確認）は例外に到達せず、commit時のcontext再materialize/検証の
    別経路で`history_invalid`が発生。時間内に特定できず、安全のためrevert。
- 残る確定範囲は、`writeContextObservationsTx`を含むcontext materialization pathの長時間占有である。source上は、
  完全request transport／validation、current requestの累積item処理、source journal探索、context marker hydrateが
  非線形な増幅経路になる。各経路の時間寄与は個別には未測定であり、根本対応では一つずつ局所最適化するのではなく、
  増分revisionとdirect referenceへ置き換える必要がある。`bytesBase64`を送らない参照化は、commit時の再構築と
  manifest照合を壊さずに設計し直す必要がある。

## 残課題（再設計の候補）

- Host側のみで、`validateContextModelRequestRecord`にmaterialize済みdigest集合を渡し、stored itemのdecodeを
  省略する（Worker contract不変）。ただし`structuredClone(message)`の受信時コストと、commit時再構築の整合は別途。
- Worker側で、materialize済みdigestを送らず参照だけにする（契約変更）。初回は必ずbytes、以降は参照の不変条件と、
  commit時再構築（`eventPayloadTx`／`readExecutionContextTx`）・manifest照合の整合を設計してから実装する。
- B6は未クローズ（部分クローズ）。
