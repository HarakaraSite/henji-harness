# Increment 196 — Session metadata取得で不要な履歴本文を展開しない

現在の状態: **完了（2026-10-07、利用者判断による一律整理）**。

以下の状態・未実施・承認待ちの記載は当時の記録であり、本incrementの現在の残作業として扱わない。
この完了判断は過去の作業を閉じるもので、当時未実施だった実装・検証・配置等を実施済みに変更するものではない。

状態: local実装・focused確認・実DBコピー比較・compiled production Core／TUI確認済み（2026-10-05）。
通常・批判的review、source commit・常用配置も完了した。

## 必要な動作と採用根拠

保存Sessionの初回表示・再開で、最新requestとrequest件数の取得に不要なthinking・tool等の
全文を展開しない。最新requestの選択、件数、Session情報と会話表示を維持する。
195後のA28追加調査を受け、利用者の「追加修正しよう」により、二つのmetadata読取の
local修正と非破壊的検証を採用した。

採用した調査証拠（通常利用メモA28から移設）:

- 保存Sessionのdescriptor生成は、DataSessionOwnerの最新request探索と最新executionの
  request件数取得で、いずれも全semantic本文を展開していた。後者は全eventのcontext復元・cloneも行った。
- `2bc2699f`の直近executionは2,080 semantic記録で、assistant_messageの1,726件が 31,294,685
  bytesを占めた。必要なmodel_request記録は15件／61,660 bytes、request開始は5件だった。
- 現行sourceのsemantic分類はcontext_observationとprovider request開始をmodel_requestへ保存する。
  調査用spikeはこの分類で読取を絞り、request開始をSQLiteでCOUNTした。
  実DBコピーのdescriptor全体と611 entityの会話snapshotは完全一致した。
- 同条件のDeno source probeで、起動から100回参照まで明示GCを入れずに比較した。
  初回参照後のPSSは532.6→208.9 MiB、100回参照後は711.9→333.7 MiBだった。 spikeのcompiled
  binary確認は調査時点では未実施で、常用環境への削減量保証ではない。
- GC後の生存heapはCore 5.6、Data 9.4、API 4.5 MiBで、spikeも同程度だった。 DataのV8 physical
  heapはGC後74.8→42.3 MiB、累積JavaScript割当は約1,284→980 MiB。
  glibcの解放済み領域も確認したが、native memory全体の内訳は未確定で、永続保持のleakとは断定しない。

調査証拠はgit管理外の`.tools/a28-core-followup/`の`findings.json`、
`baseline-natural-http-result.json`／`metadata-natural-http-result.json`、
各isolateの記録、Data単体比較、native領域確認と`metadata-spike.patch`にある。
spikeは調査用コピーだけへ適用した。稼働Core・実DBへの操作、外部provider
call・task送信は行っていない。

## 現行の利用経路と変更範囲

Coreの保存Session表示・再開 → DataのSession descriptor → DataSessionOwner初期化 →
最新request／executionの読取 → Core制御情報・context表示。
最新requestはexecutionをcreatedAtとexecution IDの降順で探索し、
各execution内のmodel_request_deltaで最大requestOrdinalを選ぶ。
該当requestがないexecutionは次へ進む。request件数はprovider_request_start eventの数である。

SqliteHistoryStoreへmodel_request occurrenceだけを読む経路を追加し、
DataSessionOwnerの最新request探索をこの経路へ切り替える。
request件数取得は同分類のprovider_request_startをSQLiteでCOUNTする。
全履歴を返す既存読取経路は、履歴表示・会話復元等のconsumerで引き続き使う。
保存schema、履歴本文、表示範囲、最新requestの比較順は変更しない。

## 実装・確認計画

1. 採用した二つのmetadata読取を変更する。
2. 保存Sessionのdescriptor再読込で、最新requestの探索順とrequest件数を確認する。
   thinking等の本文をこの読取でdecodeしないことを既知の大量読込のregressionとして確認する。
3. 既存Data Workerのcontext／execution読取、Session Data、Data persistenceのfocused testを行う。
   関連fileのtype check、format、lint、diff checkを行う。
4. 同じ実DBコピーで変更前後のdescriptor・会話結果を比較する。 195のcompiled
   binaryと今回の公式buildを同条件で初回・100回参照し、明示GCなしのPSSを測る。
5. 隔離HOME／XDGのproduction Core＋tmux TUIで保存Session表示、履歴操作、入力、
   切離し・再接続と履歴CLIを確認する。外部provider call・task送信は行わない。

この局所変更ではfull gateを必須にしない。常用配置、commit/push、公開、実data削除、
構想・architecture・roadmap変更は今回の承認に含めない。

## 結果

- `listModelRequestOccurrences`を追加し、model_requestのrecord IDだけを選んで本文を読む。
  最新requestのexecution探索順、各executionで最大requestOrdinalを選ぶ比較、該当requestがない
  executionを次へ進める動作は維持した。
- `readExecutionRequestCount`は同分類のprovider_request_startをSQLiteでCOUNTする。
  件数取得のための全event読取・context復元・cloneを撤去した。
  履歴全体を読む既存methodとそのconsumerは変更していない。
- 新196 testは実storeへSessionと二つのexecution、request開始・context delta・thinkingを保存した。
  Sessionを開き直し、最新executionにrequestがない場合の探索、最新executionの最初のrequest、
  同execution内の新しいrequest、parent／plannerの情報とrequest件数0／1／2を確認した。
  このdescriptor取得ではmodel_request以外の本文をdecodeしないことも確認した。
  原因調査で見つけた不要な全文展開を、実際のdescriptor経路で検出するregression確認である。
- 関連focused testは既存5件と新196の1件、計6件通過した。 170 S2のData Worker
  context／execution読取、170 S3のSession Data・Data service、 181のData
  persistence、175のproduction Worker／HTTP steeringと継続requestを含む。 関連source／testのtype
  check、format、lint、`git diff --check`も通過した。
- 同じ実DBコピーで、195のsource copyと現在のproduct sourceからData serviceを作って比較した。 Session
  descriptor全体は1,433 bytes、SHA-256は両者とも
  `70812dc2491026bf83d033dbcdda2acb6a4a655368f61a273dd6e07c8bd4375b`。 conversation bytesは1,954,337
  bytes、SHA-256は両者とも
  `c56631b3c967a6650be5864dc7ee0d08314a9ac103a6763cac29b6e8abfbec21`で一致した。
  request件数は5、最新requestは同executionのrequestOrdinal 5、parent、modelStep 5、itemCount
  283だった。

### compiled Coreの変更前後比較

変更前は195の確認用binary、変更後は今回の公式buildを使った。 各binaryのbuild IDは順に
`fbdd4b117f01f8818bbd49f80489da08ecf4b4d003fc0da06dc674bef37ef2ec`、
`da71ff7486e591928963aa5062e1f223ebe006eb8dee115cc17d8566fea3eca7`。
変更後binaryは`.tools/increment-196/henji`に置いた。local未commit sourceを含む確認用である。

同じSQLite backupを各隔離HOME／XDGへコピーし、空Sessionで起動後、
HTTPで対象Sessionを初回参照、その後100回参照した。 明示GC、malloc_trim、task送信、外部provider
callは入れていない。

| Core processのPSS | 変更前（195） | 変更後（196） |
| ----------------- | ------------- | ------------- |
| 空Session idle    | 90.0 MiB      | 91.6 MiB      |
| 初回参照後のidle  | 534.7 MiB     | 218.5 MiB     |
| 100回参照後のidle | 720.2 MiB     | 383.9 MiB     |
| さらに5秒idle     | 720.2 MiB     | 383.9 MiB     |

取得したsnapshotは両者とも611 entity、1,956,849 bytesだった。 Core
epoch／cursor等を除く公開Session／conversation／context／executionのうち存在する項目の
SHA-256も両者とも `5b9a54afc602f2f96bcb042b4adb6f329a2854ee08e5d09becaa77633a080391`で一致した。

この同条件のコピー実験では、100回参照後のPSSが約47%減った。
実際の長時間のAgent実行・他Session・通常環境へ一律の削減量を保証する測定ではない。 約384
MiBの常駐量は残り、native memory全体の内訳などの追加候補は当時A28に残した。
後続の改善を経て、2026-10-06に利用者がA28全体を完了とした。完了判断と原観測の移設先は
[Increment 199](increment-199.md)を参照する。
追加のGC、cache、メモリ上限はproductへ導入していない。

### productionの表示・操作と終了

- 実DBコピーの隔離XDGと専用tmux socket上で、compiled production Core＋TUIを起動した。
  対象Sessionの再開と611 entityの表示、PageUpの履歴スクロール、Escapeの最新表示への復帰、
  draft入力とCtrl-Cでのclear、Ctrl-Dでの切離し、同Sessionへの再接続を確認した。
  切離し前後でconversation snapshotは完全一致した。
- 接続経由のData履歴表示と単独のcompiled履歴CLIはともに502,314 bytes、 SHA-256
  `5f57e4142465e0c4e91084d2e5565ed260f37d571cc8c5d8e2fcbd300f21117a`で一致した。
- task送信・外部provider callは0回。実Session・実configへの書込みは行っていない。
  確認用Core／TUI／tmuxは終了した。
- 自己reviewで、保存時のsemantic分類と読取条件の一致、request比較順・探索の維持、
  request開始だけの件数集計、既存の全文履歴consumerとの分離、読取connectionの解放を確認した。
  今回の範囲に機能correctness上の未解消findingはない。

今回の確認証拠はgit管理外の`.tools/increment-196/`の`descriptor-equivalence.json`、
`compiled-before-result.json`／`compiled-after-result.json`、`tmux-result.json`、画面記録と履歴CLI出力、
`metadata-test.log`／`focused-tests.log`、type check／lint／build logに置いた。
新testの準備では初期Session recordの取得を実在する`admissionSessionRecord`へ修正した。
product側の仕様変更は行っていない。

local修正と上記検証は完了した。source commit・常用配置は後述の追加指示により完了した。
push・公開は未実施。

## 通常・批判的review（2026-10-05）

利用者の依頼により、195と合わせた固定diff・10 fileを二人のreviewerがread-onlyで確認した。
両者とも、現行producerのmodel_request分類と読取／COUNTのSQL条件が一致すること、
execution探索順、最大requestOrdinalの選択、requestなしの探索継続とrequest開始件数の維持を確認した。

通常reviewは関連7件、批判的reviewは関連8件のfocused確認をそれぞれ実行し、全件通過した。
両者から採用対象となるcorrectness・回帰・具体的なtest不足のfindingはなく、 coordinating
ownerも今回の範囲に未解消findingなしと判断した。
確認範囲・所要時間・195の解放probeは[195のreview記録](increment-195.md)を参照する。

実DBコピー、compiled Core／tmux
TUI、メモリ測定は既存記録を参照し、reviewerによる独立再実行はしていない。 full gate、外部provider
call、稼働Core・実DB操作は行っていない。
結果はgit管理外の`.tools/review-195-196/`に保存した。reviewに伴うproduct source／testの変更はない。

## 194・195・196のCommit・常用配置（2026-10-05）

利用者の「コミット配置して」により、194・195・196のsource commit・公式build・常用配置を承認された。

- source commit: `da251e56c52eada6d521e1960a973eba2fdc8703`
  （`fix: reduce TUI and saved-session memory allocations`）。コード、test、increment文書、
  A28の追加候補とhandoffを含む。追加候補のproduct修正は行っていない。
- 公式`henji:compile`で0.9.0をbuildした。sourceDirty=false、build IDは
  `b101817e6860896a429a3b00d5c61eb699a60c98eebcec2615886848bb435345`。 runtime
  digestは`c4e99fca8ac8651c1386a24db2267bdf6a9768cd26a1501537c3d409960e58f2`で、
  focused確認・review・実DBコピー比較・compiled Core／TUI確認済み候補と一致した。
  195・196のreview対象10 fileのhashも固定manifestと一致した。コード変更がないため、 focused
  testやメモリ比較を繰り返さず、計画どおりfull gateは行っていない。
- candidateの`--version`・`--help`を確認し、`dist/henji`と
  `/home/agent/.local/bin/henji`へatomic配置した。両配置先のversionとbinary SHA-256は一致した。
  SHA-256は`7ffa717ecba5dbbd91db9c6bc83fdf736aac48faf21596875e6a0b14d6be6a48`。
  旧binaryは`.tools/increment-196/deployment/henji.dist.previous`と`henji.local.previous`へ退避した。
- 配置先binaryで隔離HOME／XDG／workspace、外部DenoのないPATHと専用tmux socketを使い、 production
  Core／TUIを起動した。Core APIから0.9.0・source commit・clean buildを確認し、
  TUIのready表示とCtrl-Q終了、Coreのexit 0を確認した。task送信・実provider requestは0回。
- 配置は完了した。稼働中の実Core／TUI、実Session、実configは操作していない。
  新しい起動から適用される。push、公開、構想・architecture・roadmap変更は行っていない。

配置証拠はgit管理外の`.tools/increment-196/deployment/`の`build.log`、`deployment.json`、
`install.py`、`startup-check.py`、`startup-verification.json`、`startup-core.json`、
`startup-tui.txt`に保存した。
