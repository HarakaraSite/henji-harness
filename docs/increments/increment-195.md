# Increment 195 — Coreの保存会話復元で累積本文を一括保持しない

状態: local実装・focused確認・実DBコピー比較・compiled production Core／TUI確認済み（2026-10-05）。
通常・批判的review、source commit・常用配置も完了した。

## 必要な動作と採用根拠

保存Sessionの初回表示・再開時に、全semantic eventの累積本文を配列へ展開せず、
一件ずつ共通Conversation engineへ反映する。会話内容、順序、内部索引、SQLiteの読取整合性を維持する。
利用者の「引く続いて、coreの方も調査できる？」による調査結果を受け、
「では対応しようか」によりA28のこの修正とlocalの非破壊的検証を採用した。

採用前の調査証拠:

- 参照先はcommitではなくSession `2bc2699f-71c6-4db1-bb9f-a162871b7946`。
  利用者が残した稼働Coreと実DBは参照のみとし、復元・起動のprobeにはSQLite backupのコピーを使った。
- 対象は28 execution、611会話entity、snapshot約1.9 MiB。 `assistant_message`の5,447
  semantic記録はpayload合計96,229,657 bytesで、 うち5,398件／95,968,715
  bytesが未完了の累積thinking更新だった。
- 従来の`readSessionConversationFacts`は全executionのoccurrenceと最新未完了本文を
  JSON.parse済み配列へ集め、その後`replaySessionConversation`が並べ替えて反映した。
  調査時の全fact読込後のGC済みheapUsedは約203.6 MiB、復元後は約8.1 MiBだった。
  全factを永続保持するleakではなく、復元時の大量割当と一時的な保持を確認した。
- 調査用の逐次復元spikeは全state／normalizerの一致とピークPSSの低下を確認した。
  このspikeをproductの読取transactionと全consumerへ適用するのが今回の範囲である。

## 現行の利用経路と変更範囲

CoreのSession表示・再開 → DataのConversationWriter初回load → SqliteHistoryStoreの Session fact読取 →
共通Conversation engine → Core snapshot／TUI表示。
Dataの履歴表示と単独の`henji history --view session`も同じfact読取・復元を使う。

SqliteHistoryCoreがevent本文を含まないID・序数・未完了本文のkeyだけを先に読み、 従来と同じfirst
event ordinal、event ordinal、semantic occurrence IDの比較順で並べる。
本文は反映直前に一件ずつ読む。最新未完了本文も同じ順へ挿入する。
SqliteHistoryStoreはexecutionとeventを一度だけ消費するiteratorを返し、
全executionの復元中に一つのSQLite read transactionを維持する。
完了・途中return・例外で読取connectionを閉じる。

ConversationWriterは同じ一回の読取でexecution順とstore revisionを集計する。
共有replayは受け取った順で逐次反映するため、Data履歴表示と履歴CLIにも適用される。
保存schema、保存fact、entity、normalizer、履歴内容・表示範囲は変更しない。

## 実装・確認計画

1. 全本文配列とreplay側の本文を含むsort配列を撤去し、順序付きの逐次読取へ置換する。
2. 既存のlive／replay一致、producer attribution、writerの保存・購読・revision、
   Session表示、cancelled partialの再読込、child途中本文保存のfocused testを確認する。
3. 新しい読取で本文が必要になった一件だけを読むこと、未完了本文の位置、
   読取途中の追加commitが後続executionを含むsnapshotへ混入しないことを確認する。
4. 同じ実DBコピーで変更前後の全state／normalizerを比較し、復元単体とcompiled Coreの
   初回参照・反復参照のメモリを分けて測定する。
5. 隔離HOME／XDGのcompiled production Core＋tmux TUIで保存Sessionの表示、
   履歴操作、入力、切離し・再接続と履歴CLIの実経路を確認する。 外部provider
   callとtask送信は行わない。

この局所変更ではfull gateを必須にしない。常用配置、commit/push、公開、実data削除、
構想・architecture・roadmap変更は今回の承認に含めない。

## 結果

- store contractを配列からexecution／eventの一回消費iteratorへ変更し、全production
  consumerを切り替えた。
  読取順の比較は従来と同じで、eventを間引く、本文を切る、保存記録を削除する処理は追加していない。
- 新195 testでは実storeへ二つのexecutionと途中本文・steeringを保存した。 execution
  metadata読取時にはoccurrence本文をparseしないこと、eventを一つ進めるごとに
  その本文だけを読むことを確認した。最新未完了本文は最初の位置で復元される。
  iteratorの読取中に両executionへ追加保存しても初回snapshotへ混入せず、
  次の復元では追加内容を読めることを確認した。
- focused testは既存11件と新195の1件が通過した。
  既存138は途中本文の保存先を直接参照し、181は復元された会話からcancelled
  partialを確認するようにした。 170のlive／replay一致、producer attribution、writer、Session
  Dataの確認も通過した。 関連source／testのtype check、format、lint、`git diff --check`も通過した。
- 同じ実DBコピーから復元した611 entityを含む全state／normalizerは、
  Mapをentryへ変換したJSONで2,535,195 bytes、SHA-256は変更前後とも
  `63304fb5b06e363faa3d410a4e218c84a83789b50696e1045129f5798270c5cb`だった。

| 復元単体の測定         | 変更前    | 変更後    |
| ---------------------- | --------- | --------- |
| ピークPSS              | 374.9 MiB | 154.6 MiB |
| 復元後のGC済みheapUsed | 8.1 MiB   | 8.1 MiB   |
| 復元所要時間（単回）   | 610 ms    | 473 ms    |

時間は単回の記録であり、継続的な速度改善の保証ではない。 ピークPSSはsubprocessの`smaps_rollup`を10
ms間隔で観測した値である。 修正により復元時の全累積本文の一括保持を解消した。

### compiled Core全体のメモリと残る課題

同じDB backupをそれぞれ隔離HOME／XDGへコピーし、空Sessionで起動したcompiled Coreに
対象Sessionを初回参照、その後100回参照した。taskは送信せず、明示GCも行っていない。
変更前は常用binary（source `fa258148`）、変更後は194・195のlocal sourceを含む確認用binaryを使った。

| Core processのPSS              | 変更前    | 変更後    |
| ------------------------------ | --------- | --------- |
| 空Session idle                 | 61.0 MiB  | 90.0 MiB  |
| 対象Session初回参照後のidle    | 561.2 MiB | 537.4 MiB |
| 対象Sessionを100回参照後のidle | 705.0 MiB | 705.3 MiB |
| 測定中のピーク                 | 720.9 MiB | 719.7 MiB |

100回参照後の匿名page分は685.7→654.3 MiB、file page分は19.2→51.0 MiBだった。 使用binaryのfile
page共有条件も異なり、Core全体の常駐PSSを大きく下げる効果は
この測定では確認できていない。さらに5秒idleでも両者のPSSは同程度のままだった。
復元単体のピーク削減と、Core全体の常駐メモリ削減は区別する。
反復snapshotの生成・転送等の割当とallocatorの残存pageの内訳は未確認で、
A28の残る調査候補として当時記録した。今回の修正範囲を追加のcache制限・GC・表示制限へ広げない。

### productionの表示・操作

- 公式buildで`.tools/increment-195/henji`を生成した。 build
  IDは`fbdd4b117f01f8818bbd49f80489da08ecf4b4d003fc0da06dc674bef37ef2ec`。 local未commit
  sourceを含む確認用binaryであり、常用binaryは変更していない。
- 実DBコピーを隔離XDGに置き、専用tmux socket上のproduction Core＋TUIで対象Sessionを開いた。 611
  entityの復元・表示、PageUpの履歴スクロール、Escapeの最新表示への復帰、
  draft入力とCtrl-Cによるclear、Ctrl-Dの切離し、同Sessionへの再接続を確認した。
  切離し前後でconversation snapshotは完全一致した。
- 接続経由のData履歴表示と単独のcompiled `henji history --view session`はともに502,314 bytes、
  SHA-256 `5f57e4142465e0c4e91084d2e5565ed260f37d571cc8c5d8e2fcbd300f21117a`で一致した。
- task送信・外部provider callは0回。実Sessionへの操作と実configへの書込みは行っていない。
  確認用Core／TUI／tmuxは終了した。
- 自己reviewで全consumerの一回消費、本文を含まない並べ替え、同一transactionでの読取、
  generatorの完了・中断時のconnection解放、writerの順序・revision集計を確認した。
  今回の範囲に機能correctness上の未解消findingはない。

調査証拠はgit管理外の`.tools/a28-core-investigation/`、今回の確認証拠は
`.tools/increment-195/`の`replay-*.jsonl`／`replay-*-peak.json`、
`compiled-*-result.json`、`tmux-result.json`、画面記録、履歴CLI出力、
`focused-tests.log`／`replay-test.log`、type check／lint／build logに置いた。
確認準備ではprobeの相対importと新testのiterator型・admission eventを含む序数期待値を修正した。
これらに合わせたproductの仕様変更は行っていない。

local修正と上記検証は完了した。Core全体の常駐メモリに残る課題は当時A28へ残した。
後続の改善を経て、2026-10-06に利用者がA28全体を完了とした。完了判断と原観測の移設先は
[Increment 199](increment-199.md)を参照する。source
commit・常用配置は後述の追加指示により完了した。push・公開は未実施。

## 通常・批判的review（2026-10-05）

利用者の依頼により、別々のreviewerが195・196のコードとtestをread-onlyで確認した。
対象は`.tools/review-195-196/manifest.json`で固定した10
fileと合成diffで、両者ともhash一致を確認した。

- 通常reviewは、従来と同じ比較順、未完了本文の位置、executionをまたぐSQLite snapshot、
  Writer・Data履歴表示・CLIの一回消費を確認した。195・196と既存replay／producer attribution／
  writerのfocused確認は7件通過した。所要約3分。
- 批判的reviewは、上記に加えてsemantic attribution、writerの順序・revision集計を確認した。
  新195・196と170関連のfocused確認は8件通過した。隔離一時DBのprobeで、通常完了、 outer
  iteratorのreturn、for-ofのbreak、replay例外、writer経由例外のconnection解放と、
  例外後のwriter再読込を確認した。所要約6分。
- 両者から採用対象となるcorrectness・回帰・具体的なtest不足のfindingはなく、 coordinating
  ownerも今回の範囲に未解消findingなしと判断した。
- 大きい実DBコピーの一致、compiled Core／tmux TUI、メモリ測定は既存証拠を参照し、
  reviewerによる独立再実行はしていない。full gate、外部provider
  call、稼働Core・実DB操作は行っていない。

reviewの固定diff・manifestと結果はgit管理外の`.tools/review-195-196/`に保存した。
reviewに伴うproduct source／testの変更はない。

## Commit・常用配置（2026-10-05）

利用者の「コミット配置して」により、194・195・196をsource commit
`da251e56c52eada6d521e1960a973eba2fdc8703`へまとめ、公式buildと常用配置を完了した。
配置先のversion・SHA一致と隔離production Core／TUIの起動・終了を確認した。
詳細は[196の合同配置記録](increment-196.md)を参照する。
新しい起動から適用される。稼働中の実Core／TUIは停止・再起動していない。
