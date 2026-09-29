# Increment 159 — フッター・操作案内・コマンドピッカーの整理

更新日: 2026-09-29

ステータス: 四sliceのlocal実装・focused確認・隔離production
TUI/最小実provider確認・各sliceのreviewerコード/test review完了。Slice
2/3の採用findingは修正・限定re-reviewで解消。残るBlocker/P1/P2は0。利用者確認・increment完了承認は未取得。2026-09-30の追加指示でcommit/push・常用配置を進行中。
フッター整理と通常利用メモS27を、このincrementの計画対象として扱う。

## 目的・規模・権限

利用者が入力の送り先を選び、進捗と結果を読み取り、操作を探せるTUIへ整理する。
状態、操作案内、受付・結果通知が混在している現在の1行目を分け、
F1＝Session一覧、F2＝次タスク予約、F3＝現在タスクへの追加指示に揃える。
入力先頭の`/`でコマンドピッカーを開き、操作を探して補完できるようにする。

規模は中程度。Increment 158のような表示の局所修正を超え、入力の振分け、picker、
snapshot後も残す通知、三行footerとhelpにまたがる。
下の四sliceを一つのincrementとして順に進める。各sliceをproduction TUIで確認し、
reviewerによるそのsliceのコード・test reviewを終えてから次へ進む。 Coreのタスク実行方式、Agent
loop、DB形式を変更する作業にはしない。

利用者の追加指示は、計画のreviewerによる通常・批判的review、 実装時のsliceごとのコード・test
review、各sliceでの最小限の実provider確認を許可する。
実provider確認は対象・見込み回数・保存先を事前に報告し、承認済みの最小確認について再確認を求めない。
2026-09-29の追加指示で、計画に沿うlocal実装と非破壊的検証を開始する。
2026-09-29のlocal実装指示にはcommit/push・常用配置を含めない。2026-09-30に利用者が追加指示した。
構想・architecture・roadmapの変更承認は含まれない。

## 根拠と採用範囲

- [配置済み要素一覧](../experience/footer-elements.md)はcurrent sourceの観測、
  [astra整理案](../experience/astra-proposal.md)はこの計画に至る検討記録。
  [現行要素の意味](../experience/astra-element-meanings.md)も参照する。
- 利用者の判断: ready → working → readyへ整理し、idleという別名とcompleted表示を省く。
  accepted、canonical、settlementもfooterへ出さない。working・経過時間は2行目に置く。
- ターン中の運用メッセージと保持範囲は「いまの案で良い」と了承済み。 F1
  helpのfooter案内は不要。最新案ではhelpキーも外し、F1をSession一覧へ使う。
- 最新のキー提案はF1 Session一覧、F2予約、F3追加指示。「明示的に送り込む」操作へ分ける。
  実行中の通常文をEnterで送らない案と、slash pickerを今回一緒に作る案を計画へ取り込む。
- submitting・preparingが短く読めないのではという指摘を受け、workingへまとめる。 shutting
  downのfooter表示も省く。時間を測った結果ではなく、表示を分ける必要性に対する判断。
- Alt-EnterはGhostty＋tmuxで動くとの利用者観測がある。現在のbusy時予約との二重用途を解消する。
  本来の希望はShift-Enterであり、端末から区別可能な改行eventが届く経路は維持する。
- パス補完、Ctrl-O、通常入力の単語・行頭／行末削除と移動の別名を廃止する。
  pickerを閉じるCtrl-C、Session一覧のCtrl-G／Ctrl-T、Ctrl-Hの独立案内も省く。
  masked認証入力のCtrl-U全消去とBackspaceの正常な受信は残す。

入力欄の高さは既存仕様のまま。94×23のペインで一行となることは利用者確認済み。
1turnのsteering回数、予約枠、失敗後の予約内容の扱いは既存Coreの動作に従う。 `@`注入、`/edit`、TUI
helpとCLI helpの内容統合は今回に含めず、S28〜S30へ残す。

## 利用者から結果までの現行経路

| 経路           | 入口から結果・保存まで                                                                                          | 今回の変更                                                                       |
| -------------- | --------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| 入力・送信     | terminal → input_decoder → remote_session → task.submit／execution.steer／followUp.queue → TaskService → Worker | キーを振り分け直す。対象Session／executionとoperationsによる既存の受付可否を維持 |
| slash・picker  | editor → slash候補・Tab補完 → runSlashCommand → 既存Session／catalog／help操作                                  | slash選択用pickerを追加し、既存コマンドへ補完。Session等の実操作は既存経路を使う |
| footer         | Core SSE snapshot＋TUIの送信・取消待ち → statusText／updateStatus → layout → terminal frame                     | 操作・状態・設定を分離。状態名と各行の内容を揃える                               |
| 受付・操作通知 | command API応答／照会・操作失敗 → local notice → footer                                                         | 運用通知を本文へ移し、snapshot／typing後も見返せるようにする                     |
| 実行結果       | Worker outcome → 既存execution・semantic保存 → API projection → SSE／execution.read → TUI                       | 保存済み停止理由をHTTP表示経路へ渡し、本文で結果を説明する                       |
| 予約           | TaskService内の予約record → snapshot.pending → 本文。成功後に別タスクを開始                                     | Core所有は維持し、予約／開始／未開始の表示を整える                               |
| パス補完       | Tab → RemoteCatalogUi → client.pathRead → GET /workspace/paths → Coreのpath index                               | 利用者操作と、それだけに使う取得・index・通知・API経路を廃止                     |

Session・execution・予約の所有者はCore、draft・picker・viewport・ローカル通知はTUIである。
TaskServiceのpreparing、受付receipt、executionのoutcome／adoption／processSettlementは内部で維持する。
footerから表記を省くことを、内部状態や実行完了条件を削除する要求とは扱わない。

## 実装後の動作

### 送信・キー・コマンドピッカー

- 入力待ちの通常文はEnterで新規タスクへ送る。実行中の通常文はEnterでは送らず、draftを保つ。
- F2は入力内容を現在execution成功後の次タスクとして予約し、F3は現在executionの続きへ追加指示する。
  F2／F3を入力待ちの新規送信へ転用しない。送り先のSessionとexecutionを要求に固定する。
- 可否は既存operationsに従う。受付拒否・確認不能時は入力を保持し、結果を本文で説明する。
  F3の追加指示は既存の反映時点に従い、provider応答やtoolを即時中断する機能を加えない。
- Alt-Enterは入力待ち・実行中とも改行。端末が送るShift／Ctrl-Enterの既存newline経路も残す。
- F1はSession一覧。Enter view、R resume、Esc closeという既存picker操作を維持する。
- `/shutdown`を`/quit`へ変更する。`/detach`はTUIだけを切り離す。Core shutdown APIの名前は変えない。
- 通常入力の先頭で`/`を入力すると全14コマンドのpickerを開く。入力でコマンド名を絞り、
  ↑／↓で選び、Enterでコマンド名を入力欄へ補完してpickerを閉じる。
  選択行には短い説明・引数usage・直接対応するキーを載せ、キーがなければ対応なしとする。
- 補完後は必要な引数を入力し、Enterで実行する。選択時にタスク送信やコマンド実行を重ねない。
  補完・Esc終了直後に、同じ入力のままでpickerを再び自動表示しない。
  slashのコマンド名を編集した時は再び候補を扱う。引数入力中はコマンド名選択を割り込ませない。
- Escはpickerを閉じてdraftを保ち、閉じる操作を実行キャンセルへ流さない。
  overlayの選択・認証入力は通常キー処理より先に扱う。Ctrl-D／Ctrl-Qの既存全体操作は維持する。
- helpは`/help`から開き、全スラッシュコマンドと残すキー操作を対比表へ載せる。
  F2／F3のようにコマンドのない操作も対応なしとして載せる。

### 本文の運用メッセージと保持

| メッセージ                          | 内容                                                                       |
| ----------------------------------- | -------------------------------------------------------------------------- |
| 実行の失敗・取消・中断・結果不明    | 終了結果と得られる短い理由。受付の結果とは分ける                           |
| 入力の受付拒否・確認不能            | 対象入力、理由、入力を保持したこと、次に確認すべきこと                     |
| キャンセル要求の拒否・確認不能      | 要求の結果。実行終了のcancelledとは区別する                                |
| 次タスクの予約・開始・未開始        | 予約内容と状況。失敗・取消等では開始せず、内容と理由を残す                 |
| 追加指示の受付                      | 対象入力が受け付けられたことを示す。semanticな追加指示表示との重複を避ける |
| Session・設定・認証・recall等の失敗 | 対象操作、結果、短い理由                                                   |
| credential保存・recall準備／解除    | 画面だけでは分かりにくい結果。credential保存をAPI認証成功と呼ばない        |
| 接続断                              | 一度の出来事として通知。現在の接続状態はfooter2行目にも表示                |

ラベルは`system>`へ揃える。通常通知は通常文字色、失敗通知はラベルと短い失敗語を赤にする。
正常なタスク受付・正常終了の独立通知と、画面で分かる改名・model変更の成功通知は省く。
pickerのloading／savingはpicker内、usage等は入力補助で扱い、本文へ逐次蓄積しない。
通常画面にあるcredentialの有無は`/login`の既存profile一覧の確認経路へ集約する。
credential不足で送信できなかった時は既存の失敗経路に従い本文で知らせる。

| 対象                                   | 保持する範囲                                                                                              |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| 通常会話・反映された追加指示・実行結果 | 既存Coreのsemantic／execution記録。結果通知は取得した記録から表示する                                     |
| 予約・開始・未開始record               | 同じ稼働Coreへの再接続でsnapshotから表示。Core再起動後の予約復元は追加しない                              |
| ローカル操作通知                       | TUI内でSessionに対応づけて保持し、snapshot・typing・画面切替で消さない。TUI再起動後の通知復元は追加しない |
| picker・補完・usage                    | その操作中の一時表示。Session履歴へ保存しない                                                             |

表示上の`system>`は保存種別ではない。全通知をDBへ保存する機能を加えない。
同じcommand／execution／予約の更新をsnapshotごとに重複追加せず、
対応する本文表示を一箇所に保つ。別Sessionの操作結果を今のSessionの結果として表示しない。

### フッター各行

| 行 | 表示するもの                                                                    |
| -- | ------------------------------------------------------------------------------- |
| 1  | 状態に応じて使える入力操作、slash／picker／履歴の操作案内                       |
| 2  | ready／working／cancelling、経過時間、接続・閲覧状態、workspace・Session・title |
| 3  | provider、model、effort。項目間は`│`、provider:/model:ラベルは省略              |

```text
[Enter submit │ / commands]
[ready │ …/henji-harness │ session:4de84efc │ <タイトル>]
[opencode-go-chat │ mimo-v2.6-pro │ auto]

[F2 queue │ F3 steer │ Esc cancel │ / commands]
[⠋ working 00:12 │ …/henji-harness │ session:4de84efc │ <タイトル>]
[opencode-go-chat │ mimo-v2.6-pro │ auto]
```

1行目は既存の操作可否に応じ、受付済みで使えなくなったF2／F3等を案内しない。 F1 help、Ctrl-C
clear、detach、quit等の固定操作を常設せず、helpへまとめる。
履歴閲覧中は`history N/M │ new K │ Esc latest`と成立する入力操作を表示し、
Escを実行取消の案内にしない。picker内はpickerに対応する操作を表示する。

2行目のworkingは新規タスク送信から、Coreの新規入力受付が再び可能になるまでの処理中を表す。
終了・後処理の間も実状態に従う。readyは新規タスクを開始できる状態であり、
単にcompletedを受け取った時点で先にreadyへ戻さない。
取消待ちはcancelling。working中も入力編集・利用可能な追加指示はできる。
経過時間はexecution.createdAtを起点に、実行情報取得後から表示する。
送信・準備中には経過時間を作らない。同じexecutionへのsnapshot反復・再接続で起点を保つ。

受付確認不能は拒否確定ではない。本文の確認不能通知と、既存Coreの状態・操作可否を使い、
受付済みの可能性が残る状態を単純に「もう一度送れるready」として扱わない。
表示ラベルを減らしても、既存の照会・draft保持・取消・終了待ち処理は維持する。 shutting
down、submitting、preparing、idle、accepted、completed、canonical、settlementは
footerのどの時点にも表示しない。

長いpath・modelの末尾を残す省略と、状態・経過時間を優先する既存の幅処理を維持する。
3行目は選択変更時にprovider・model・effortを一緒に更新する。

### 全コマンドと残すショートカットの対応

| 操作                     | スラッシュコマンド | ショートカット                               |
| ------------------------ | ------------------ | -------------------------------------------- |
| ヘルプ                   | `/help`            | 対応なし                                     |
| Session一覧              | `/sessions`        | F1                                           |
| Session閲覧              | `/view ID`         | Enter（Session picker）                      |
| Session再開              | `/resume [ID]`     | R（Session picker）                          |
| 新規Session              | `/new`             | 対応なし                                     |
| Session改名              | `/rename TEXT`     | 対応なし                                     |
| context確認              | `/context`         | 対応なし                                     |
| 過去実行の参照準備       | `/recall [ID]`     | 対応なし                                     |
| provider選択             | `/provider`        | 対応なし                                     |
| model選択                | `/model`           | 対応なし                                     |
| effort選択               | `/effort`          | 対応なし                                     |
| 認証情報登録             | `/login`           | 対応なし                                     |
| TUI切り離し              | `/detach`          | Ctrl-D                                       |
| Core終了                 | `/quit`            | Ctrl-Q                                       |
| 新規タスク送信           | 対応なし           | Enter（入力待ち）                            |
| 実行中への追加指示       | 対応なし           | F3（実行中）                                 |
| 次タスクの予約           | 対応なし           | F2（実行中）                                 |
| 実行キャンセル           | 対応なし           | Esc（最新表示・実行中）                      |
| 入力欄クリア             | 対応なし           | Ctrl-C（通常入力）                           |
| 改行                     | 対応なし           | Alt-Enter。区別可能なShift／Ctrl-Enterも受信 |
| コマンドピッカー         | 対応なし           | 入力先頭の`/`                                |
| コマンド補完             | 対応なし           | Tab。picker内Enterは選択候補を補完           |
| 会話スクロール           | 対応なし           | PageUp／PageDown                             |
| 最新表示へ戻る           | 対応なし           | Esc（履歴閲覧中）                            |
| 入力履歴の前後移動       | 対応なし           | ↑／↓（入力待ち、既存の行移動との優先条件）   |
| 一文字左／右             | 対応なし           | ←／→                                         |
| 一行上／下               | 対応なし           | ↑／↓（既存の入力履歴との優先条件）           |
| 行頭／行末               | 対応なし           | Home／End                                    |
| 直前の文字削除           | 対応なし           | Backspace                                    |
| picker内の選択移動       | 対応なし           | ↑／↓。Session pickerでは←／→も使う           |
| picker内の選択確定       | 対応なし           | Enter                                        |
| picker・補助画面を閉じる | 対応なし           | Esc                                          |
| modelのお気に入り切替    | 対応なし           | Tab（model picker）                          |
| model検索語の末尾削除    | 対応なし           | Backspace（model picker）                    |
| 認証入力の保存           | 対応なし           | Enter（masked入力）                          |
| 認証入力の末尾削除       | 対応なし           | Backspace（masked入力）                      |
| 認証入力の全消去         | 対応なし           | Ctrl-U（masked入力）                         |

Ctrl-C clearは実行キャンセル・予約解除ではない。Ctrl-Uは通常入力では廃止し、masked入力では残す。
Ctrl-Hは独立案内を省くが、Backspaceと区別できないbyte 0x08の受信を削らない。
通常入力のTabはslash補完のみ。パス補完は取得・index・通知も廃止する。
`/resume`の省略／latestはCoreの継続対象、`/recall`の省略／latestは最新実行、clearは参照準備解除。
`/view`はCoreのactive Sessionを切り替えず、`/resume`はCoreのactive対象を変える既存動作に従う。

## 実装を進める四slice

### Slice 1 — キー・コマンドの振分けと廃止経路

F2／F3のdecodeを追加し、F1をSession一覧へ割り当てる。Enterはslashを処理した後、
入力待ちだけ新規taskへ送り、実行中の通常文を送信しない。
Alt-Enterのbusy時queue分岐を除き、常に改行へ送る。helpを`/help`へ揃え、`/quit`へ改名する。
廃止キーの通常入力・overlay内の枝を外し、masked Ctrl-UとBackspaceは維持する。

パス補完は唯一のproduction consumerがRemoteCatalogUiであることを確認した。
TUIの補完・cacheに加え、client／codec／contractのpath.read、HTTPのworkspace/paths、 Coreのpath
indexと、参照がなくなるfile_reference.tsを同じ段階で除く。
`docs/operations/http-api.md`も、廃止するpath APIの記述を同じ変更で更新する。
廃止機能だけを要求している既存testは修正または削除する。旧キー・旧コマンドのaliasを追加しない。

主な対象: `input_contract.ts`、`input_decoder.ts`、`remote_session.ts`、`remote_catalog_ui.ts`、
`slash_command.ts`、`input_editor.ts`の専用経路、`v0/api/{contract,codec,client}.ts`、
`v0/agent/http/server.ts`、`v0/agent/host/core_service.ts`、`file_reference.ts`。

このsliceの完了は、F1〜F3・Enter・Alt-Enterの振分け、/quit、廃止経路が実操作で成立し、
その変更を確認するfocused testとreviewerのコード・test reviewを終えた時点。
footerの最終配置と通知の保持は後続sliceの範囲で、暫定画面の案内も新キーと一致させる。

### Slice 2 — スラッシュコマンドピッカーとhelp

既存14コマンドの定義を使い、説明・引数usage・対応キーをpickerとhelpで共有する。 入力先頭のslash
tokenを絞込みに使い、選択・補完・終了を既存overlayの優先経路へ接続する。
補完後にpickerが再表示されないこと、引数入力とコマンド実行が続けられることを成立させる。
通常入力・Session picker・model picker・masked入力のキーを混ぜず、それぞれのhelpへ反映する。

主な対象: `slash_command.ts`、`remote_session.ts`、`state.ts`、`tui_renderer.ts`、`layout.ts`。
pickerの表示状態はTUI所有で、Coreへ保存しない。

このsliceではslash入力から選択・補完・引数入力・実行までとhelpの対応表を確認する。
picker内Enter／Esc、補完後の再表示抑止をfocused testとproduction TUIで確認し、
reviewerのコード・test reviewを終えてからSlice 3へ進む。

### Slice 3 — 終了結果・運用通知の本文統合

現行ExecutionViewはoutcomeを持つが停止理由を持たない。
`StoredExecutionRow.outcomeJson`には既存LoopOutcomeのstopReasonと診断があり、 production
storeはcompactOutcomeとして既に保存している。 API
projectionからExecutionViewへstopReasonと短い理由の表示に必要なcode／stageを渡し、
snapshotとexecution.readの両方で同じ値を扱う。理由は既存の表示用分類に対応させる。 DB保存形式やraw
request／responseの収集は増やさない。

ローカル通知をSessionに対応づけてTUI内に保持し、snapshotの会話projectionと合わせて表示する。
command・execution・予約のidentityを使い、同じ更新の重複表示と別Sessionへの混入を防ぐ。
操作通知と結果表示をsystem>へ揃え、色と本文の保持範囲を上記仕様へ合わせる。
既存semanticのsteer入力を、受付だけの通知と同じ意味にしない。

主な対象: `v0/api/contract.ts`、`codec.ts`、`v0/agent/host/api_projection.ts`、
`remote_session.ts`、`snapshot_presentation.ts`、`state.ts`、`conversation_renderer.ts`、`tui_renderer.ts`。
既存stored outcomeの取得は上記sourceで確認済み。短い表示への変換は実装で確認する。

このsliceではHTTPを通じた短い停止理由と、本文通知のsnapshot／typing後の保持を確認する。
拒否・失敗の再現には既存API経路を使うlocalhost
providerの制御も使い、外部への誤ったrequestで失敗を作らない。
実providerの実行取消で取得・保持の実経路を確認し、reviewerのコード・test reviewを終えてからSlice
4へ進む。

### Slice 4 — 三行footerの統合と全体確認

remote側の状態・操作・通知を詰めたstatus文字列を分離し、layoutへ行ごとの表示情報を渡す。
Coreの状態・operationsと既存の送信／取消待ちを使ってready／working／cancellingを表示する。
結果・通知・内部処理名をfooterへ戻さず、履歴／slash／pickerの案内と経過時間を揃える。
通常高さ・狭い幅で状態とelapsedを優先し、Session・設定の省略規則を保持する。
最後に候補binaryをbuildし、隔離tmuxで全体の表示・操作を確認する。

主な対象: `remote_session.ts`、`state.ts`、`layout.ts`、`tui_renderer.ts`と変更経路の既存test。
この分離はHostの表示入力だけで行い、新しいCore phaseや保存状態を加えない。

このsliceの完了は三行footer、状態・経過時間、履歴中の案内と、先行sliceの操作を
同じ候補binaryのproduction TUIで確認し、reviewerのコード・test reviewを終えた時点。
先行sliceの確認を全てやり直さず、footer変更に接続する操作と採用findingの修正箇所を確認する。

### 各sliceの実装・確認・コードreview手順

1. 当該sliceだけを実装し、対応する既存testを更新し、必要なproduct動作のfocused testを追加する。
2. 変更経路のfocused確認、必要なtype check、format・lint、git diff --checkを行う。
3. そのsliceの安定候補をbuildし、隔離XDG／tmuxのproduction TUIを確認する。
   実provider確認が必要な操作は下表の最小シナリオで行い、通常利用可能性とHTTP／semantic結果を記録する。
4. slice開始時から終了時までの差分とsource状態を固定し、reviewerへコード・testと実測結果を渡す。
   先行sliceの差分は文脈として区別し、今回変更していない範囲を再reviewの対象へ広げない。
5. defaultがfindingの要件・実経路・影響を確認し、採用した問題をそのslice内で修正する。
   修正のfocused確認と、同じreviewerによる変更箇所・findingの限定re-reviewを行う。
6. 必要な動作確認と採用findingの解消を記録してから次のsliceへ進む。

各sliceのコード・test reviewはreviewerによる通常reviewを一回行う。
目的は当該sliceの要件・既存外部契約・実利用経路・変更によるregressionの確認であり、
一般的hardeningや未観測のprovider variantを追加しない。
通常reviewはrepository規則の30分上限、限定re-reviewは一回・15分以内を既定とする。 reviewerはfull
gateや実provider callを実行せず、defaultが検証とfinding採否を担当する。

### Sliceごとの最小実provider確認

実providerは当日の常用provider／modelを一組選び、実行前に具体的な選択と対象操作を報告する。
回数は下表の見込みでありproductのrequest上限ではない。実際のmodel step・物理request数は記録する。
生成に関係しないpicker・認証編集・幅省略の確認のためだけには外部callを増やさない。

| Slice | 実providerで確認する操作            | 最小シナリオと見込み                                                                                  |
| ----- | ----------------------------------- | ----------------------------------------------------------------------------------------------------- |
| 1     | F3追加指示・F2予約から次task開始    | 二task完了、実測3物理request。下の結果を参照                                                          |
| 2     | picker利用後の通常task              | 一task完了、実測1物理request。下の結果を参照                                                          |
| 3     | 実行取消と本文結果の保持            | 実taskを一回開始して取消、system>の理由をsnapshot・typing後に見返す。1 task、物理requestは1〜2回程度  |
| 4     | working・elapsed・readyと三行footer | 短いtaskを一回開始・完了し、進捗・時間・操作案内・終了後の状態を確認。1 task、物理requestは1〜2回程度 |

実確認は隔離XDGで行い、実configへselectionやcredentialを書き込まない。
credentialは既存の承認済み参照経路から利用し、値・Authorizationを証拠へ記録しない。
証拠は`/home/agent/.local/state/henji-build-artifacts/increment-159-20260929/slice-N/`へ保存する。
各sliceのsource／build identity、操作、画面、短いrequest fact、semantic
outcome、review結果を本incrementに記録する。
予定と異なる追加callは、同じ確認を成立させる具体的な理由がある時だけ最小限に行い、対象と見込みを報告する。

## 検証と受入

実装後に変更経路のfocused test、必要なtype check、format・lint、git diff --checkを行う。
各sliceで変更部分を確認し、full gateは要求しない。test件数を目標にしない。

| 確認するproduct動作  | focused確認・production TUIでの受入                                                                                             |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| 送り先をキーで選ぶ   | ready Enterで新規task、busy Enterで送信なし、F3で現在taskへ追加指示、F2で成功後の別task予約。内容と対象executionを確認          |
| 改行と操作の優先     | Alt-Enterをready／working双方で入力改行に使う。picker内のEnter／Escと通常操作が衝突せず、masked Ctrl-Uが動く                    |
| コマンドを探して実行 | `/`で全候補、絞込み・移動・Enter補完、引数入力後の実行、Esc終了後のdraft保持。補完後に自動再表示しない                          |
| 予約の開始・未開始   | 成功後にだけ次taskが始まり、失敗／取消では始まらず内容と理由が残る。既存開始条件を使う                                          |
| 通知と結果を見返す   | 受付拒否等、取消・失敗結果がsystem>に残り、snapshot／typing後にも見返せる。反復snapshotで重複せず、Session切替で混入しない      |
| 状態と時間を読む     | ready→working→ready、cancelling、停止後に時間が進まない、同executionの起点維持。内部状態名・accepted・completedがfooterへ出ない |
| 三行footerとhelp     | 各行の内容、幅省略、履歴中Esc latest、provider/model/effort更新、全コマンド・キーの対応なしを含むhelpを確認                     |
| 旧操作の廃止と終了   | 通常TabがパスAPIを呼ばず、/quitとCtrl-QでCore終了、/detachでCore継続。Ctrl-Cは通常draft clear、pickerを閉じない                 |

tmux確認は隔離HOME／XDG／workspaceとtmux socketでcompiled production CLI/Core/TUIを使う。
localhostの制御可能なproviderで成功・失敗等の再現を行い、
上表の最小実provider確認を各sliceの実操作へ組み合わせる。
実provider確認は利用者の今回の指示で承認済み。具体的な対象・回数・保存先を提示して実行する。
確認時の操作、画面、HTTPの短いfactと実行結果は本incrementへ記録する。
GhosttyクライアントからのF1〜F3物理入力は現時点で未確認であり、tmuxへ送るキー列の確認と区別して結果を記す。

完了条件は、利用者がproduction TUIでコマンドを選び、送り先を分け、進捗・結果を確認できること。
offline testと案reviewだけを完了の代替にしない。

## 案レビューの記録

2026-09-29、利用者指示によりgpt-6-astraが独立した通常レビューと批判的レビューを実施。
Blocking／P1限定、全体10分上限。約3分半で両方完了し、双方Blocking 0件／P1 0件。
対象はこの計画作成前の整理案先頭節の固定snapshotで、SHA256は
`9527d1fce0944362a1b5c12602b979a2be2c1b0cc81f6096db0dbb2a75286430`。 記録:
`/tmp/codex-agent-context/footer-proposal-review-20260929/normal-review.md`、`critical-review.md`。

案の入力・可否・保持範囲とcurrent sourceの整合を確認した静的reviewであり、
本計画や将来の実装のreviewを済ませたことにはしない。実端末のキー・表示は未検証。
review時点で未確認だった停止理由のHTTP表示経路は、計画調査でstored outcome→API
projectionの経路を確認した。

## 計画レビューの結果

2026-09-29、利用者の指示により独立したreviewer二人が、上記四sliceの固定計画を通常・批判的にreviewした。
前回と同じBlocking／P1限定・全体10分上限とし、約5分以内に両報告を確認した。 双方Blocking 0件／P1
0件、必須修正なし。rootの採用findingもない。
対象のSHA256は`78e32f8ca653b58ac03a0b77e97361df78d5511ddc13f5aca5e25af5ffdfb9d2`。
[両reviewerの報告と採用判断](increment-159-plan-review.md)を保存した。

確認対象は要件・既存責務・slice間依存・確認とreviewの順序。 実装後のコード・test review、production
TUI、実provider確認はこの計画reviewの対象外であり、各sliceの実装時に行う。
この計画reviewの結果を実装や実端末確認の代替にしない。

## Product正本への変更案と残る境界

構想のWhyとcomponent間の状態所有は変えない。 実装後の記述はarchitectureのHost-owned
Surface節とroadmap F01の現行UI説明に差分が生じる。 変更案は三行footerの役割、F1〜F3と/help、slash
picker、通知のsystem>統合・色、 履歴中のEsc
latest、credential常設表示・パス補完の廃止を現在の説明へ反映すること。
これらの正本は本計画では変更せず、対象・理由・意味変更を提示して別に承認を得る。

計画reviewと、実装時のsliceごとのコード・test reviewおよび最小実provider確認は指示済み。
追加指示により四sliceのlocal実装と非破壊的検証を進める。
commit/push・配置、Product正本変更には着手しない。

## 実装・検証の進行

2026-09-29、利用者の「計画に沿って実装し、可能な限りincrementの最後まで進める」という追加指示で着手。
local実装、隔離production TUI、各sliceの最小実provider確認とreviewerコード・test reviewを順に行う。

| Slice | 実装・focused確認     | production TUI・実provider     | reviewerコード・test review |
| ----- | --------------------- | ------------------------------ | --------------------------- |
| 1     | 実装・focused確認済み | 実provider確認済み             | Blocking/P1/P2 0            |
| 2     | 修正・focused確認済み | production確認済み             | 採用P1/P2解消、残0          |
| 3     | 修正・focused確認済み | production・実provider確認済み | 採用P2解消、残0             |
| 4     | 実装・focused確認済み | production・実provider確認済み | Blocker/P1/P2 0             |

Slice 1の実provider対象は常用selectionの`opencode-go-chat / mimo-v2.6-pro / auto`。
短いBash実行を含むtask中にF3の追加指示とF2の次task予約を一回ずつ行い、二つのtaskの完了を確認する。
物理requestの見込みは3〜5回。保存先は本計画の`slice-1/`で、credential値・Authorizationは記録しない。

### Slice 1 production確認

- compiled候補: source `027d1bdd…`＋local差分、dirty、build
  `bf48125af314fe757311e6e4f79db5ba7b87f81b805bd73a74a8d374a2a16cc6`。
- 隔離XDG／workspace／tmux、100×32。F1のSession一覧、readyでF2を押しても新taskへ転用せずdraftを保持することを確認。
- busyの通常文にEnterを押しても送り込まず、Alt-Enterで改行できた。F3で改行を含む追加指示を受付、F2で次taskを予約した。
- Bash実行後のassistant回答に`S159_STEER`を確認。予約は次executionとして開始し、assistantが`S159_QUEUE`を回答。両task
  completed、物理requestは合計3回。
- `/quit`で確認用TUI・Coreが共にexit
  0。credentialの確認用参照は解除し、既存Core・常用configは操作していない。
- 証拠: `slice-1/real-147212/`の操作画面、snapshot、execution
  readback、`results.json`。保存先のrootは上記artifact path。
- 起動時の`--root-provider`がprovider既定modelを選ぶため、最初の確認用Coreは送信前に終了し、次のCoreで確認selectionを明示した。最初のCoreの外部requestは0回。
- tmuxへ送ったF1〜F3のキー列は確認済み。Ghosttyクライアントの物理キー入力は未確認。

Slice 1のfocused確認は66件pass。変更24 TypeScript filesのtype
check、format、lintと`git diff --check`がpass。 HTTP catalogはテスト起動権限を揃えてpass。production
sourceはbuild・実測後に変更していない。 26
filesの固定差分SHA256は`c857d273873d9767748362ffb64eb7b800b2ffeafda43a02f6913eb344504aec`。
review入力は`/tmp/codex-agent-context/increment-159-slice-1-review/`。

Slice 1コード・test通常reviewは2026-09-29 11:39〜11:42
UTCに完了。Blocking／P1／P2は全て0件、rootの採用findingなし。
報告は[Sliceごとのレビュー記録](increment-159-slice-reviews.md)。Slice 2へ進む。

### Slice 2 実装・確認

- コマンドの説明・usage・対応キーを定義へ集約し、pickerとhelpで共有した。対応キーのないコマンド、コマンドのないキーは「対応なし」と表示する。
- `/`で全14コマンドを開き、名前入力で絞る。↑／↓選択、Enter／Tabで補完して閉じる。引数入力はpickerを割り込ませず、次のEnterで実行する。
- Escはdraftを保ってpickerを閉じる。補完・Esc直後は同じdraftで再表示せず、コマンド名編集時には再表示する。
- helpの旧行数切捨てを外し、PageUp／PageDownで全コマンド・残す全キーを読めるようにした。
- focused確認は39件の異なるtestがpass（remote Session 5、catalog 2、read-only TUI 4、shutdown
  2、retained TUI 26）。変更10 TypeScript filesのtype check、format・lint、diff checkがpass。
- テストのコマンド入力を補完→実行の二段階へ更新した。catalog
  testは失敗時にもTUIをdetachしてSSEを閉じるようにし、観測済みのteardown停止を解消した。
- compiled候補: source `027d1bdd…`＋local差分dirty、build
  `057dc0520663b23c511616b672a383a3d9db99c74d9e5ed029aeeabacb792a36`。
- 隔離XDG／workspace／tmux、100×32と40×23。全14候補、renameの補完時未実行→引数入力と次Enterで改名、Esc保持・prefix編集再表示、helpの最終masked
  Ctrl-Uまでを確認。
- 40×23のpickerでは末尾候補`/quit`とusage／Ctrl-Qが可視。通常taskはassistantが`S159_PICKER`を回答、completed、物理request
  1回。確認用TUI・Coreはexit 0、credential参照解除済み。
- 証拠:
  `slice-2/real-152040/`の画面・snapshot・results、root直下の`slice-2-focused*.log`、`slice-2/build.log`。

### Slice 2 review修正

通常reviewのP1一件（別draftへ残る補完抑止）とP2一件（引数を保持したコマンド名編集）は要件とsource-to-impactが成立するため採用。抑止を未編集の現在draftに限定し、cursorが先頭slash
token内にある時にpickerを開く。補完はtokenだけを置換して引数を保持する。

修正後のremote focused5 tests pass。新しい `/quit` と名前を削除して復元した `/quit`
の最初Enterが補完だけになること、引数付きrenameの次Enter実行を確認。type check・config
format/lint・diff check pass。compiled build
`c688591d4199cce9fbeec31f74a06a5c7387ad39443b44ae7969f4fe0b92746e`。`slice-2/real-153617/`
のproduction TUIで同じ操作を確認、Ctrl-Q
exit0、追加外部request0。通常reviewの固定入力は保持し、修正差分SHA256
`fcea765c7c1f040d04006792e62ec06e815803613f8ca4bc07909c0f7948f950` を限定re-reviewへ渡した。

Slice 2の限定re-reviewは12:08 UTCまでに完了、既存P1/P2双方解消、残るBlocking/P1/P2
0件。固定sourceとfocused/compiled証拠を照合した報告をslice review記録へ保存。

### Slice 3 API実装・focused確認

既存StoredExecutionRow.outcomeJsonからstopReasonと診断code/stageをExecutionViewへ渡す。DB・Loop・raw保存は変更しない。共通projectionをsnapshotとexecution.readで使用。HTTP
focusedで正常final、cancelled、localhost503によるcontract_failure/http_error/httpを確認した。API関連3
tests pass、typecheck・config fmt/lint・diff check
pass。testの最初のstage推測providerは実観測httpへ直し、production分類を変更していない。TUI通知部分の実装と確認を継続する。

Slice 3のTUI通知保持はRemoteSystemNoticesへ集約。Session別に保持し、command/execution/queue
identityでupsertする。本文の元の会話位置をanchorとして次task後も見返せる。queueは同じnoticeを状況更新し、semantic
steer入力が現れた時は受付noticeを除く。正常completed noticeは作らない。失敗はfailureWord
prefixだけ色を付ける。新focused3と既存本文/retained47がpass、type・config
fmt/lint確認済み。操作結果とのwiring後にproduction確認する。

### Slice 3 production確認

compiled build
`ab47649673e567a2436fb788ff9212328cbaac9e1be1f479517528cab2f94054`。隔離XDG/workspace/tmux100×32で確認した。localhost503によるFAILED/provider
request failedと、idle
F3のREJECTED/draft保持がtyping後も残る。/newの別Sessionへ混ざらず、/view元Sessionで理由が再表示された（slice-3/real-160815、外部request0）。

opencode-go-chat/mimo-v2.6-pro/autoの実taskをBash実行中にF2予約し、Escで取消。CANCELLEDとNOT
STARTED/予約内容/cancelled理由を表示。execution.readとsnapshot共にstopReason cancelled、diagnostic
turn_cancelled/turn_control、processSettlement complete。typingとtitle
snapshot更新後も通知を見返せた。実task1、物理request1、TUI
exit0（slice-3/real-160816）。確認用credential参照は解除、常用config/既存Coreへ変更なし。

focusedはAPI3、通知projection3、既存本文/retained47、remote141の7、implementer担当remote17がpass。旧正常受付/改名成功/queue表示とF1
helpを待つtestは今回の要件に揃え、production機能を狭めていない。typecheck、config fmt/lint、diff
check pass。固定差分でコード・test通常reviewへ進む。

Slice 3通常reviewはBlocker 0/P1 0/P2 1。別executionで同じsteer文面を再送した時、古いsemantic
steerとtextだけで照合して受付通知を省くP2を採用。APIに既存のmessage.executionIdをTUI user
projectionへ渡し、対象execution
IDとtextで一致判定する最小修正を加えた。新規/更新focused8とtype/config fmt/lint/diff check
pass。固定修正差分SHA256は `5288b6afa8e922579d5c56ef8127d7eb5772d4fc2c48540eb48e7caaea63a093`。

修正後のcompiled production TUIをlocalhost providerで確認。証拠
`slice-3/real-162267`。同じSessionの2 taskに同文 `Keep reply short`
をF3で送り、両executionの受付通知が出て、対象executionのsemantic
steer反映後だけ通知が消えた。localhost物理request4、追加外部request0、exit0。再現probeの最初の2回はlocalhost応答をJSONとしたこと、tool名をBashと推測したことにより待機条件が成立せず停止。現行SSE契約と実測tool名bashへprobeだけ修正し成功した。いずれも確認用Core/tmux終了・credential
link解除済み。限定re-reviewは既存P2解消、未解消Blocker/P1/P2 0。Slice 3完了、Slice 4開始。

### Slice 4 三行footer統合・production確認

remote
controllerの表示入力をUiFooterへ分け、本文通知・Core内部status・操作案内を文字列へ詰める処理を除いた。1行目は入力/picker/historyの操作と短い一時案内、2行目はready/working/cancelling/READ-ONLY/DISCONNECTED・経過時間・Session情報、3行目はprovider/model/effort。footer専用のcredential
presence cache/callbackも削除し、/login内のpresence表示と保存refreshは維持した。

時計はexecution.createdAtだけを起点とし、実行情報のない送信/準備中はspinnerのみ。反復snapshot・同executionへの再接続で起点を維持し、readyでtimerを解除する。受付確認不能時はSession別TUI
receipt markerで古いsnapshotから再送可能と判断せず、既存command照会後のfresh Core
read/購読snapshotで受付可否を確認する。Core/DBの状態は追加していない。

focusedはretained27・remote141の7・その他remote17の計51がpass。型、config fmt/lint、diff check
pass。narrow
clockの対象assertionもpass。旧footerのCtrlC/CtrlD・preparing・receipt文字列・settlement・shutting
downを待つtestを新仕様に合わせた。正常なCoreの取消・queue
receipt・drain待ちをtestのために狭めていない。

実provider証拠 `slice-4/real-163580` はMimo autoの1 task、物理request2、completed/settlement
complete。ready・working/elapsed・終了後readyの三行footerが見えた。短い会話が100x14
viewportへ収まり履歴移動をしなかったためprobeのhistory待機はtimeout。追加実providerは呼ばず、そのsnapshot/画面を保存して確認用Core/tmuxを終了した。

最終candidate SHA256 `eb1d47b330b45d56661b0b8b5058018082ffa238b37fca72adf86c4de738a5de` のcompiled
production TUIをlocalhostで補完確認。`slice-4/real-165459`で長い入力のタスク実行、履歴中Esc
latest、busy中picker、detach後同Core/同executionへ再接続・時計起点維持、終了後ready・1.3秒後も時計停止、40x23、provider/model/effortをまとめて変更（推論なし）、/quit
exit0が成立した。localhost物理request2、外部0。先行 `real-164905`
は幅変更途中のcaptureへprobeが即アクセスしてIndexError、待ち条件のみ修正して成功した。

`slice-4/real-165809` は推論0で/login profile presence、masked Ctrl-U clear、別SessionをCore
activeにした時の旧view READ-ONLY、接続断DISCONNECTED通知1件・typing後保持、detach exit0を確認。先行
`real-165682` のprobe POST
path誤りは現行clientの/sessions/openへprobeだけ修正した。すべて隔離環境で行い、確認用Core/tmux終了・credential
link解除済み。コード/test通常reviewはBlocker/P1/P2 0で完了。

### Local実装の結果と残る境界

2026-09-29、Slice 4の通常コード・test reviewはBlocker 0/P1 0/P2 0。固定11 files・差分SHA256
`fcc1452a61b8d34dd4fc1b76b19d327bdbda74659043f3f7caefa016e1a37bce`
とfocused結果・production証拠の整合を確認し、rootもlocal完了を採用した。各sliceのreviewとSlice
2/3の限定re-reviewは[レビュー記録](increment-159-slice-reviews.md)へ保存。

F1 Sessions/F2次task予約/F3追加指示、通常Enterの送り先、Alt-Enter改行、slash
pickerの補完→実行、全コマンドと残すキーの/help、保持されるsystem>通知と色、ready→working→readyと経過時間、三行footer、パス補完・旧キーの廃止が実装された。各sliceを順にproduction
TUIで確認し、レビューを終えてから次へ進んだ。実providerはMimo autoの計5
task・物理request7（Slice1:3、Slice2:1、Slice3:1、Slice4:2）。追加の修正・補完確認はlocalhostで行った。

local実装確認用candidate/Core/TUI/tmuxはすべて終了し、隔離credential参照は解除済み。local実装時点で常用binary・実config・既存Coreは変更していない。GhosttyクライアントからのF1〜F3物理キー入力は未確認で、確認済みのtmuxキー列と区別する。local実装と検証は完了した。利用者確認・increment完了承認は未取得。2026-09-30の追加指示でcommit/push・常用配置を実行する。architecture/roadmap/conceptも変更せず、必要な説明更新案は本incrementの「Product正本への変更案と残る境界」に留める。

## commit・push・常用配置（2026-09-30）

利用者の追加指示により、Increment
159の実装・test・要件/検証・操作文書・採用移動・handoffをcommitし、origin/mainへpushする。別件の未追跡`docs/research/a23-*`二件は対象外とする。固定commitのclean
checkoutでDeno 2.9.7の公式buildを行い、Slice 4で実操作したcandidateとruntime
SHA-256が一致することを確認する。旧binaryを保存し、常用先`/home/agent/.local/bin/henji`へ原子的に配置する。配置binaryを隔離XDG/workspace/tmuxで最小の非provider操作で確認し、配置記録を後続文書commitへまとめてpushする。実provider呼出しは追加しない。既存Core・実configは停止・移行・変更しない。
