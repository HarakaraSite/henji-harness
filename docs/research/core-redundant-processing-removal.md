# Coreの冗長な状態更新・実行状態走査の削除案

ステータス:
**調査時の削除案と測定証拠。2026-10-03に案1・2をIncrement 180へ採用した。**

現在の要件・計画・承認境界は[Increment 180](../increments/increment-180.md)を参照する。
以下は採用前の調査記録として保持し、現在の進行状態は180で管理する。

利用者の「henjiに冗長な処理がないか調査したい」に対するsource調査と、候補1・2の
providerなし測定を踏まえた削除案である。通常利用メモのA28として記録し、現在は180から参照する。
構想・architecture・roadmap、API/CLI adapter分離の採用範囲を変更しない。

## 1. 利用者が必要とする動作と目的

人間が同じSessionでtaskを繰り返しても、過去の実行件数に比例した全件転記を状態更新のたびに
行わない。公開状態が変わらないと確認された重複再投影を減らす。
その際、task受付結果、実行状態の表示、cancel、steering、follow-up、履歴保存・参照を維持する。

目的は不要な仕事を除くことであり、通知数やtest件数を減らすこと自体ではない。
今回の測定は処理件数の測定で、CPU時間・入力遅延は測っていない。
この変更だけで通常利用の入力遅延が解消するとは主張しない。

## 2. 現行product経路と状態所有

```text
TUI / HTTP client のtask送信
  → CoreService.taskSubmit
  → ApplicationTaskService.admit / begin
  → 共通Worker Session → Agent Worker / Data Worker
  → 実行状態通知・durable settlement
  → Coreのcontrol snapshot・公開revision
  → snapshot/update配信 → TUIの表示
```

- `ApplicationTaskService`はtask受付・準備・終了に対応する実行状態を`executions`
  Mapへ保持する。
- Coreも実行照会と公開snapshotへの相関に使う`executions` Mapを持つ。
- Coreの`refreshSlotSnapshot()`は、毎回TaskServiceのMap全件をCore側へ転記し、control
  snapshotを 再投影する。
- `publishSnapshot()`は5項目をそれぞれ`JSON.stringify()`で比較し、変更もData
  deltaもない場合は
  revision更新・配信を行わない。ただし、それまでの再投影・全件転記・比較は実行済みである。
- TaskServiceからの通知でCoreが再投影した後、`taskSubmit()`もadmit成功後に再投影する。
- Data
  Workerの会話更新、semantic履歴、canonical採用、TUIのlayoutは別責務であり、削除対象ではない。

### Data Workerとの境界

直接変更する範囲はTaskService → Coreの実行状態反映であり、Data
Workerの実装・保存形式・ 通信contractは変更しない。Data
Workerへ新しい責務を移す案ではない。

Coreの`executionRead()`はDataから取得した実行記録へ、Coreが追跡する
`submittedByCommandId`と`processSettlement`を付加する。DataのSession更新に含まれる
実行情報も、公開snapshotではCoreの追跡情報と合成される。
この合成責務は、全件転記を差分反映へ置き換えた後も維持する。

Data側の終了確定とCore側の後処理完了は同一ではない。Dataで実行が終了済みでも、
Coreでは後処理中である区別を失わないようにする。Dataの終了通知でTaskServiceの
状態反映を代用しない。

source根拠（調査時の行番号）:

- [`task_service.ts`](../../v0/agent/host/task_service.ts):
  `executionStates()`、`begin()`、`settle()`。
- [`application_service.ts`](../../v0/agent/host/application_service.ts):
  observationのpublishと購読。
- [`core_service.ts`](../../v0/agent/host/core_service.ts):
  `publishSnapshot()`（390行以降）、
  `refreshSlotSnapshot()`（552行以降）、購読callback（698行）、admit後の再更新（1422行）。
  Data更新からのsnapshot合成（461行以降）、`executionRead()`での追跡情報の付加（828行以降）も参照する。

architecture文書にはData
Worker導入前の説明が残るため、今回の配置・処理の判断は現行sourceに基づく。
既存の反映待ちについては[API/CLI分離検討文書](api-worker-separation-design.md)も参照する。

## 3. 測定根拠

### 条件

Deno 2.9.7、隔離HOME/XDG/workspace/state、1 Core・1 Sessionで100
turnを順次実行した。
既存`physicalIoMode: provider-free`のWorkerProbeModelによるtoolなしのfinal回答である。
Coreのbyte
sinkを1本購読し、HTTP/TUIは起動していない。ネットワーク権限は与えず、外部providerを
呼び出していない。

Core moduleの一時複製へcounterと呼出し元labelだけを加え、import先は元production
moduleを使用した。
既存分岐・処理順・比較・配信は維持し、元sourceのhashとcounter差分を照合した。
100 executionのcompleted/canonical
settlementと、最後の`committedTurn=100`、`active=false`を確認した。

### 結果（Session初期化を除く）

| turn | refresh回数 | execution Map走査件数 | refreshの変更なし回数 |
| ---: | ----------: | --------------------: | --------------------: |
|    1 |          19 |                    19 |                    11 |
|   10 |          19 |                   190 |                    12 |
|   50 |          19 |                   950 |                    12 |
|  100 |          19 |                 1,900 |                    12 |

100 turn累計はrefresh **1,900回**、走査 **95,950件**。 この測定経路ではturn
nで19n件、N turn累計で`19N(N+1)/2`件を走査した。

| refreshの呼出し元            |  回数 | 走査件数 | 変更なし回数 |
| ---------------------------- | ----: | -------: | -----------: |
| 購読callback / task_state    |   300 |   15,150 |            0 |
| 購読callback / runtime_state | 1,500 |   75,750 |        1,099 |
| taskSubmitのadmit成功後      |   100 |    5,050 |          100 |
| 合計                         | 1,900 |   95,950 |        1,199 |

変更なしrefreshでも累計 **60,599件**を走査した。
Data経由のpublishを含めると、100
turnで`publishSnapshot()`は2,200回、変更ありupdate/配信は
1,001回、5項目比較は11,000回（`JSON.stringify()`は22,000回）だった。
refresh由来の比較は9,500回、その他は1,500回。

初期化は別にrefresh1回・走査0件・比較5回・update1回（購読前）。
最初のturnはupdate/配信11回、残り99 turnは各10回だった。

### 証拠保存先・未確認事項

git管理外の[測定報告](../../.tools/redundancy-probe/REPORT.md)、同directoryの`results.json`、
`summary.json`、`source.json`、`counter-only.diff`、`run.ts`に保存した。
これらはcheckoutやcloneに含まれない。本書には判断に必要な条件と集計値を転記している。

最初の試行は100 execution終了後のprobe側snapshot
decodeで失敗した。probeだけを修正して
再実行し、上記集計は成功試行だけを使用した。probeの型確認と`git diff --check`は成功。

実providerのstream量、tool
loop、cancel・失敗、複数Session、HTTP/TUIについて、この件数を
一般化しない。件数は性能向上の保証ではない。

## 4. 削除案

### 案1 — snapshot更新から実行状態Mapの全件転記を外す

**優先する整理対象。**

削除対象は`refreshSlotSnapshot()`内の`executionStates()`全件走査・転記である。
過去の実行状態やDB記録そのものを削除する案ではない。

実行状態の追加・変更が起きた箇所から、その実行だけをCoreへ反映する経路へ置き換える。
TaskServiceの既存observation経路を第一候補とし、別のpolling、全件同期cache、独立した状態管理層を
新設しない。開始・受付失敗・終了を扱う既存の状態変更箇所と、Coreの照会経路を照合してから
具体的な通知形を決める。

Core側MapにはSessionをまたいだ照会用途があるため、単純なMap削除や、終了後の記録の間引きはしない。
TaskService側Mapと`executionStates()`が置換後も必要かを参照先で確認し、使われなくなるAPI・処理は
同じ変更で撤去する。不要な状態の二重保持を新しい別Mapへ移すだけの変更にしない。

期待する結果は、snapshot再投影のたびに過去のsettled executionを転記しないこと。
開始・終了などの実際の変更件数に対応して反映する。具体的な削減件数は変更後の同条件probeで確認し、
測定前に数値を完了条件として固定しない。

### 案2 — task受付後の重複再投影を除く

削除候補は`taskSubmit()`で`tasks.admit()`成功後に呼ぶ明示的な`refreshSlotSnapshot()`である。
100回すべて変更なしだったことを根拠とする。

admitに伴うTaskService通知から必要な公開状態とrevisionが確定し、受付結果のcursorがその状態を
参照できることを確認したうえで、この呼出しを削除する。
受付失敗時の再投影や、他operationの類似呼出しは今回の測定だけを根拠に削除しない。

この測定経路では当該呼出し100回が、走査5,050件・5項目比較500回を伴っていた。
案1を先に実施すれば走査はそちらで解消するため、両案の削減量を二重計上しない。

### runtime通知のno-op — 一括削除しない

runtime通知経由にも1,099回の変更なし再投影があった。ただし、公開snapshotに差分がないことは、
内部通知が不要なことと同義ではない。

今回の最小削除案では、runtime通知全体の間引き、phaseの省略、timer/debounce、新しい比較cacheは
追加しない。案1・2の後も整理が必要なら、同じ状態を繰り返し通知する具体的な発生箇所と、その通知の
consumerを確認して別途削除範囲を決める。

## 5. 維持する動作・対象外

維持する動作:

- taskの受付結果とexecution identity、受付cursorの意味。
- preparing → running → settling → idleの必要な状態遷移、入力受付可否。
- cancel、steering、follow-upと実行終了の相関。
- 実行状態の照会、Session切替後の既存参照の意味。
- Dataの実行記録とCoreの受付・後処理状態の合成、`submittedByCommandId`と
  `processSettlement`の意味。Data側の終了確定とCore側の後処理完了の区別。
- completed/cancelled/failed等のdurable履歴、canonical/non-canonical採用の区別。
- snapshot/updateの順序、公開revision、再接続時の状態参照。

対象外:

- 履歴・実data・終了済みexecutionの削除、保存期間や容量制限の追加。
- HTTP/API/CLI Worker配置変更、公開schema変更、一般的hardening。
- 全JSON比較の置換、Dataの会話projection、TUIのlayout・renderer変更。
- 最初の調査の候補3（base
  instruction再解決）。今回は測定・削除案の対象にしていない。
- 構想・architecture・roadmapの正本変更、常用配置、commit/push、実provider確認。

## 6. 採用後の実装・確認の進め方

### Increment 179との順序・分離

利用者の確認により、[Increment 179](../increments/increment-179.md)は現在の計画どおり進め、
本案（A28）の冗長処理削除は混ぜない。179の受入と変更前baseline比較を完了した後、
本案を別incrementへ採用するか判断する。この順序の合意は、本案の実装開始や個別incrementへの
採用を承認するものではない。

179はAPI/CLI adapterのWorker分離、A28はTaskService →
Coreの内部状態反映の整理であり、
責務上は両立する。ただし、同時に変更すると、Worker境界追加による負担と冗長処理削減による軽減が
混在するため、179の性能比較へA28を含めない。179の要件・実装範囲は広げない。

A28の実装と測定は179反映後のsourceを基準にする。保存済みprobeのCore複製をそのまま使わず、
179後のCoreからcounter付きprobeを更新して変更前後を同条件で測定する。 従来の100
turn測定は当時の変更前証拠として保持し、179後の件数と同一とは扱わない。

A28の利用動作の確認は179後の正式API
Worker経路で行い、受付cursor、購読revision、実行照会、
Dataの終了確定とCoreの後処理中・完了の区別を維持する。Data
Workerの実装・保存形式・ 通信contractと、API Workerの公開operation
contractを変更する案ではない。

### 採用後の手順

1. 179の受入・baseline比較完了後、案1・2を別incrementへ採用するか、利用者が判断する。
2. 179反映後のsourceの状態変更箇所から照会・公開状態までを再照合し、差分反映の最小contractを具体化する。
   実装時に使われなくなる全件走査・API・状態保持も対象へ含める。
3. 案1、案2の順に実装し、変更した具体的動作をfocused確認する。
4. 179後のCoreを使った同条件のprovider-free
   probeで変更前後を測定し、全件走査が消え、admit後の重複呼出しが消えたことを確認する。
   正常完了・canonical採用・idle復帰も再確認する。
5. 差分通知が変更する開始・受付失敗・終了・Session切替の参照と、案2が変更する受付cursor・準備中の
   cancelを既存の実経路確認に対応づける。steering/follow-upの表示・終了連携も、影響する箇所に絞って確認する。
   Dataの実行記録とCoreの追跡情報を合成した実行照会・公開snapshotについて、
   `submittedByCommandId`の相関と`processSettlement`による後処理中・完了の区別が
   差分反映後も保たれることを確認する。Data Workerのcontract変更は計画しない。
   未観測variantや網羅matrixを追加する計画にはしない。
6. 必要な型確認・format/lint・diff checkを行う。隔離XDG・tmux上のproduction
   TUIで、送信から完了、
   working表示とidle復帰、影響する操作をproviderなしで確認し、incrementへ記録する。
   offline件数削減だけを人間の利用可能性の代替にしない。

実provider確認が必要になった場合は、対象・回数・保存先を提示して別途承認を得る。
今回は提案文書の作成だけで、実装・再測定・採用後の確認は未実施である。

## 7. 元調査からの意図的な整理

元の測定事実・件数・利用契約は変更していない。削除案として、候補1の全件転記と候補2のadmit成功後の
再投影を最小範囲に選び、runtime通知のno-op全体と候補3は範囲外へ分けた。
差分反映は提案であり、すでに実装・検証されたcontractとしては扱わない。
