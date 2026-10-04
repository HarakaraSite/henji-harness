# gpt-6-astraによる現行要素の意味整理

相談日: 2026-09-29

位置付け更新日: 2026-10-04。以下は9月29日時点の相談結果であり、本文中の「現行」や未決案は当時を指す。
この相談を受けた要件・実装結果は[159](../increments/increment-159.md)、その後の共通会話更新は
[170](../increments/increment-170.md)を参照する。現在の表示・操作は
[Host/Worker architecture](../architecture/henji-host-agent-worker.md#surfaceと現在のtui)、
未採用候補は[通常利用メモ](normal-use-inbox.md)を正本とする。

利用者の「現行要素の意味もastraに整理させて」という依頼に基づき、gpt-6-astraが通常HTTP接続TUIのcurrent
sourceをread-onlyで確認した相談結果。rootがdocsへ移し、参照リンクを整えた。設計・割当の確定、実装、実機検証はしていない。対象一覧は[現行要素一覧](footer-elements.md)、利用者の最新方針は[整理案の追加判断](astra-proposal.md#利用者の追加判断観測と更新案2026-09-29)を参照する。

## 結論

現行の混乱は、**「いま何ができるか」「いま何が動いているか」「先ほどの操作が届いたか」「その実行がどう終わったか」**を一つのstatus文字列に押し込んでいることが中心である。`accepted`と`completed`は`ready`の類語ではない。それぞれ別の問いへの答えなので、常設表示を省いても、必要な場面でその意味を確認できる経路は区別する。

正常時を`ready → working → ready`にする利用者方針は、この混在を解くものとして妥当。状態・経過時間は2行目、実行設定は3行目という方針に沿える。ただし`ready`を「文字を入力できる」と説明すると誤る。working中でも入力・編集はでき、Enterの意味は追加指示に変わる。readyは「このSessionへ新しいタスクを開始できる」と説明するのがよい。

通知も一種類ではない。実行結果と操作失敗は後から読める出来事、pickerのloadingは現在の操作進捗、入力履歴の端や補完候補は現在の入力補助である。すべてを本文へ蓄積する必要はない。一方、単にフッター通知を消して本文へ一度追加するだけでは次のsnapshotで消えるので、「本文へ移す」は表示位置の変更だけでは成立しない。

コマンドは14個あっても、入口の数と意味の数は同じではない。`/help`とF1はほぼ同じ目的の入口だが、`/view`と`/resume`、`/context`と`/recall`、追加指示と次タスク予約は結果が違う。入口をまとめる場合にも、この違いを操作選択として保持する必要がある。

## 人間向けの分類

以下は意味を説明する分類であり、九つのフッター欄や九つの新しい状態を増やす提案ではない。

| 分類                     | 人間が知りたいこと                                              | 現行の代表                                               |
| ------------------------ | --------------------------------------------------------------- | -------------------------------------------------------- |
| 現在の操作可否           | この画面から新しいタスクを開始・追加指示・キャンセルできるか    | ready、READ-ONLY、DISCONNECTED、操作案内、unavailable    |
| 実行活動                 | 表示中Sessionの実行が進んでいるか、停止を待っているか           | working、cancelling、spinner、elapsed、preparing         |
| 操作進捗と受付事実       | 指示を送っているのか、Coreが受けたのか、表示への反映を待つのか  | submitting、processing、accepted、syncing snapshot       |
| 実行結果                 | その実行はどう終わったか、次に何を判断すべきか                  | completed、cancelled、failed、interrupted、unknown、理由 |
| 内部採用と終了処理       | どの履歴へ採用されたか、Worker等の後処理が終わったか            | canonical、non-canonical、settlement                     |
| 表示位置と閲覧           | 何のどこを見ているか、下に新しい表示があるか                    | history位置、new below、Session閲覧、context画面         |
| 操作補助                 | 操作を見つける・入力を編集する・選択するには何を押すか          | F1、slash候補、usage、入力履歴、picker操作               |
| Sessionとworkspaceの識別 | どの作業場所・会話が対象か                                      | workspace、Session ID、title、new/resume/rename          |
| 実行設定と認証設定       | どのprovider/model/effortで使うか、credentialが保存されているか | 3行目、選択picker、login、credential present/missing     |

READ-ONLYはこのSessionへタスク送信できないという意味で、TUI全体の操作を禁止する意味ではない。DISCONNECTEDはCoreの現在状態を継続観測できないという別の問題で、`last phase`は過去の観測である。どちらもworkingの反対語でまとめない。

## 現行表示の対応表

「省略」はその意味自体や内部記録を削除する意味ではない。利用者方針と本相談の提案を区別して記した。

| 現行要素（同じ意味はまとめた）                                         | 意味・人間の用途                                                           | 統合・省略・保持                                                                                                          |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| ready / idle                                                           | 新規タスクを送れる待機。現行idleはnotice付きreadyの表記変換                | 利用者方針どおりreadyへ統一。入力編集可否とは呼ばない                                                                     |
| working（内部busy）、spinner                                           | 表示中Sessionのexecutionが活動中。待つか追加指示するかの判断               | 2行目に保持。spinnerは進行感の補助で別状態ではない                                                                        |
| elapsed `00:12` / `1:02:03`                                            | executionのcreatedAt起点の経過。遅さや継続を判断                           | working/cancellingと一緒に保持。停止要求からの時間ではない                                                                |
| cancelling                                                             | 現行ではcancel送信待ちからCoreの取消処理中までを包む表示                   | 「停止完了」と区別。現行の単語だけでCoreの受付確認済みとは断定しない                                                      |
| submitting / steering / queueing follow-up                             | どの種類の入力を送信しているか                                             | 進捗表現は整理できるが、送信先・実行タイミングの違いは保持                                                                |
| awaiting receipt / processing / requesting                             | 受付結果待ち、Coreのcommand処理中、cancel送信待ち                          | 重複表現は短くできる。何の受付を待つかは保持                                                                              |
| accepted                                                               | Coreで操作受付を確認したという事実                                         | 通常タスクで本文反映とworkingが確認できる場合、独立した常設成功通知は省ける。予約・追加指示の受付確認まで無条件に削らない |
| accepted, syncing snapshot / accepted · waiting for core snapshot      | 受付は確認済みだがTUIへの状態反映待ち                                      | 一つの表記へ統合可能。受付不明とは分ける                                                                                  |
| preparing / task admission in progress                                 | タスク開始の準備中。通常送信やfollow-up開始の境界にある待機                | 同じ進捗の二重説明を一つへ。ready扱いにして送れると誤認させない                                                           |
| DISCONNECTED / last phase …                                            | 接続断と、最後に観測したCore状態                                           | 現在の接続状態と古い情報である区別を保持。Core終了とは同一視しない                                                        |
| READ-ONLY                                                              | 表示中Sessionに新規タスクを送れない                                        | 送信可否として保持。viewでactive Sessionを見ると送れる場合もあり、viewコマンド自体を常にREAD-ONLYと呼ばない               |
| shutting down Core                                                     | Core終了要求を進め、Core停止確認を待つ                                     | 終了進捗として保持。TUIのdetachと分ける                                                                                   |
| completed                                                              | 直近実行の正常終了                                                         | 常設不要という利用者方針。現在のreadyで代替するのは状態表示だけで、結果の記録まで同義化しない                             |
| cancelled / failed / interrupted / unknown                             | 取消・失敗・中断・結果不明という実行結果                                   | 本文system>へ結果と得られる理由を残す方向。unknownをfailedに言い換えない                                                  |
| canonical / non-canonical                                              | 正式な会話履歴へ採用済みか                                                 | 通常フッターから省く方向。実行結果・本文が存在するか・ファイル変更を戻したかの意味には使わない                            |
| settlement running / settling / complete / unknown                     | Worker等の終了・後処理を含むcompletionの観測                               | 通常フッターから省く方向。内部/APIの能力は維持。unknownは失敗ではない                                                     |
| Enter submit / Enter steer / Alt-Enter queue                           | 同じ入力欄の内容を、新規タスク・実行中追加指示・次タスク予約のどれに使うか | 操作の意味は保持。キーとその場の案内の最終案は未決                                                                        |
| Esc cancel / cancellation unavailable                                  | 表示中executionの取消要求を送れるか                                        | 現在の操作可否。履歴・overlay中のEscの意味と合わせて説明する                                                              |
| Ctrl-C clear                                                           | TUIのdraftを捨てる                                                         | 現在のタスク・予約は消さない。保持対象                                                                                    |
| Ctrl-D detach / /detach / Ctrl-Q shutdown                              | TUIだけ離れるか、Coreも終了するか                                          | 各操作内の二つの入口は同義。二つの操作間は同義でない。終了コマンドは/quitへ変更する方針                                   |
| F1 help                                                                | 操作を調べる入口                                                           | /helpと目的は共通。フッター常設範囲は未決                                                                                 |
| history start / history record N of M / history                        | 本文閲覧位置。同じ情報の詳細・短縮形                                       | 一本化可能。N/Mはlog entry数で、turn数・Session数ではない                                                                 |
| Esc latest / new below N                                               | 最新へ戻る操作と、履歴閲覧中に下に更新があること                           | 履歴位置とまとめて表示可能だが、位置と新着は別の意味。Nは更新件数でmodel step数ではない                                   |
| cmds: …                                                                | 現入力に一致するslash候補                                                  | 入力補助。F1の全操作説明と役割が違う。既存pickerとは別物                                                                  |
| credential present / missing                                           | 選択providerの認証情報の存在                                               | 認証画面への集約案は合理的。presentを認証成功・API疎通成功とは呼ばない。unknown時は現行も通常案内なし                     |
| submission rejected …                                                  | Coreが入力を拒否した結果                                                   | 失敗理由を保持。実行開始後のfailedとは区別                                                                                |
| submission unconfirmed … / draft kept                                  | 受付を確認できない、手元の入力は保持                                       | 確認不能を拒否済みへ変えない。再送判断に必要な意味を本文通知等へ保持                                                      |
| submit response unknown · checking command                             | 応答不明後、command照会により受付を確認中                                  | 進捗。最終的なunconfirmedとは分ける                                                                                       |
| Session operation still pending等                                      | 先行操作・受付確認待ち                                                     | 操作の一時進捗にまとめられる。executionがworkingという意味ではない                                                        |
| task.submit unavailable等                                              | 対象Session・状態ではその操作を使えない                                    | 操作名と対象を保持。全機能停止という一語にまとめない                                                                      |
| cancel requested / already requested / idle / unconfirmed / rejected等 | 取消要求に対する受付結果、または照会不能                                   | requestedは停止完了ではない。idleはこの取消対象が実行中でない結果で、ready/idle表記統一の対象とは別                       |
| Session一覧・閲覧・新規・再開の進捗／失敗                              | 一覧取得・閲覧切替・Coreのactive対象変更の成否                             | 共通文体にできるが、閲覧と再開の操作名は保持。picker内進捗と失敗通知を分ける                                              |
| Session renamed / Session title unchanged                              | 改名結果                                                                   | 実際の新タイトルが見えれば成功の別表示は省ける。変更なしは失敗ではない                                                    |
| recall進捗・準備・解除・失敗                                           | 次タスクへ渡す過去実行の参照準備                                           | 次タスクに影響するため準備有無の確認を保持。単なる画面閲覧成功ではない                                                    |
| context取得中／取得失敗                                                | 読取画面の取得状況                                                         | 画面内進捗と操作失敗へ整理可能                                                                                            |
| provider/model/effort取得・変更・保存失敗、favorite通知                | カタログ取得、実行設定の変更、お気に入り保存                               | 更新後の選択値が見えれば選択成功通知は省ける。favoriteは選択変更と別操作なので一括削除しない                              |
| credential saved … / presence refresh unavailable                      | 保存結果と存在状態の再確認結果                                             | 設定変更成功。API認証成功ではない。保存成功と再読取不可の部分結果を潰さない                                               |
| パス取得・候補数・補完失敗                                             | workspaceパス文字列の入力補完                                              | 利用者が操作自体を廃止する方針なので関連案内も対象。@注入とは異なる機能                                                   |
| history empty / history boundary                                       | 入力履歴に候補なし／端まで来た                                             | その場の入力補助。本文会話の先頭とは区別して短く扱える                                                                    |
| paste exceeds 64 KiB / input too long                                  | 現入力が受け入れられなかった                                               | 入力操作の失敗。Core受付拒否とは違う。今回の相談で制限の変更を提案しない                                                  |
| unknown command / usage                                                | コマンド名・引数を直す手掛かり                                             | 入力補助として統合。実行結果failedとは呼ばない                                                                            |
| 改行操作の案内                                                         | キー形式と改行操作の説明                                                   | Ctrl-O専用操作は削除方向、F1等へ説明をまとめる                                                                            |
| Core終了の拒否・エラー・確認不能                                       | 終了操作の結果                                                             | 拒否、失敗、結果不明は保持。TUIが閉じたことだけでCore停止成功とはしない                                                   |
| workspace path / session:ID・none / title・untitled                    | 作業場所と表示中Sessionの識別                                              | 相互に代替しない。titleは人間向け、IDは同名Sessionの識別。通常の状態と一緒に保持する方針                                  |
| provider / model / effort                                              | 表示中Sessionの実行設定                                                    | 3行目に保持。三つは一組だが同義ではない                                                                                   |
| pending 種別:バイト数                                                  | 共有layoutにある入力laneの残量表示                                         | 通常HTTP経路は渡していない。今回、現行必須要素として再導入しない                                                          |

## 全14コマンドと操作の意味

### コマンド

| コマンド                    | 人間の目的と結果                                                          | 同じ目的の入口／保持すべき違い                                                                         |
| --------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| /help                       | 操作説明を開く                                                            | F1と共通。F1はヘルプから閉じる操作も持つ                                                               |
| /sessions                   | Sessionを選ぶ一覧を開く                                                   | 現行Ctrl-G/Ctrl-T。F2は候補。開くだけでactive Sessionは変わらない                                      |
| /view ID                    | このTUIの閲覧対象を変える                                                 | picker Enter。Coreの作業対象は置換しない                                                               |
| /resume [ID]                | SessionをCoreの作業対象として開き、TUIもそこへ移る                        | picker R。省略/latestは継続対象をCoreが選ぶ。止まったexecution自体をその途中から再始動する指示ではない |
| /new                        | 新しいSessionを作業対象として開く                                         | 直接キーなし。閲覧元のmodel選択とCore側activationに基づく。単なる表示消去ではない                      |
| /rename TEXT                | active Sessionのタイトルを変える                                          | 直接キーなし。IDや会話内容の変更ではない                                                               |
| /context                    | checkpoint、pending recall、latest requestの短い情報、active configを読む | 読取画面。modelへ文書を注入する操作ではない                                                            |
| /recall [ID\|latest\|clear] | 過去executionの参照を次タスク用に準備／解除する                           | execution IDを扱う。Session IDを扱うresumeとは異なる                                                   |
| /provider                   | providerを選ぶ                                                            | providerを変えるとそのdefaultSelection（model/effort込み）を適用する                                   |
| /model                      | provider内のmodelを選ぶ                                                   | model選択時にそのdefaultEffortも適用する。model一覧のTabはfavorite変更で、model選択ではない            |
| /effort                     | 選択modelのreasoning effortを選ぶ                                         | provider/modelを保持してeffortを変える                                                                 |
| /login                      | profileを選び、masked入力からcredentialを保存する                         | Enterで保存、provider選択とは別。ログイン疎通試験ではない                                              |
| /detach                     | このTUIを切り離す                                                         | Ctrl-D。Coreと受付済み作業は続く                                                                       |
| /shutdown（変更方針 /quit） | Coreを停止しTUIを離れる                                                   | Ctrl-Q。他の接続UIにも影響する。名前変更でdetachと同じ意味にしない                                     |

### コマンド以外の全操作（キー別名とoverlay文脈を統合）

| 操作                           | 現行の入口と作用                                                             | 整理上の扱い                                                                                                                        |
| ------------------------------ | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| 新規タスク・追加指示・予約     | 通常Enterはtask、実行中Enterはsteering、対応形式の実行中Alt-Enterはfollow-up | 同じdraftを異なる用途へ送る三つの意味を保持。slash入力Enterはコマンドを先に処理                                                     |
| 実行キャンセル                 | 最新表示のEsc                                                                | overlay閉じる・履歴から最新復帰が先。操作の意味は文脈で変わる                                                                       |
| draftクリア                    | 通常Ctrl-C                                                                   | 実行取消とは別。利用者の削除対象外                                                                                                  |
| 会話本文のスクロール・最新復帰 | PageUp/PageDown、履歴中Esc                                                   | 表示位置だけ変更する                                                                                                                |
| 入力履歴                       | 入力待ちの↑/↓                                                                | draftを過去の送信文に置換。↑は可能なら入力内の行移動が先、履歴中↓は新しい候補・元draftへ戻る                                        |
| slash補完                      | 通常Tab、入力が/で始まる場合                                                 | 候補一つで文字列を補完する。現在の/だけは候補なし。候補pickerは未実装                                                               |
| workspaceパス補完              | 通常Tab、slash以外                                                           | 相対パス文字列を補完する。廃止方針                                                                                                  |
| 改行                           | 対応形式Shift/Ctrl-Enter、idle Alt-Enter、CSI-u Alt-Enter                    | inputへ改行を入れる。環境で送られるキー列の差がある。最終キー未決                                                                   |
| 改行説明                       | Ctrl-O                                                                       | 改行は入れない。削除方向                                                                                                            |
| 一文字・一行のカーソル移動     | ←/→とCtrl-B/F、↑/↓                                                           | 同一操作の別名。↑/↓は履歴との優先条件あり                                                                                           |
| 現在行の先頭・末尾移動         | Home/End、Ctrl-A/E                                                           | 文書全体の先頭・末尾ではない。同一操作内の別名は案内を統一可能                                                                      |
| 一単語移動                     | Alt-B/F                                                                      | 空白区切りで移動。単語削除とは別操作で、削除方針を移動まで拡張しない                                                                |
| 一文字削除                     | Backspace/Ctrl-H                                                             | 同じ受信event。独立案内をBackspaceへまとめる案と、0x08対応を削除することは違う                                                      |
| 前後の単語削除                 | Ctrl-W、Alt-D                                                                | 通常入力の操作自体を削除する方向                                                                                                    |
| 現在行の前後削除               | Ctrl-U/K                                                                     | 通常入力の操作自体を削除する方向                                                                                                    |
| pickerの移動・確定             | ↑/↓、Session pickerは←/→も。Enterで選択                                      | Sessionはview、Rはresume。provider/model/effortは設定変更。認証profileは入力画面へ進む。Enterという物理キーだけで同一操作と扱わない |
| picker・補助画面を閉じる       | Esc/Ctrl-C、ヘルプはF1も                                                     | Ctrl-Cを削除しEscへという利用者方針。保存中の既存挙動は別途確認対象で、ここで変更を決めない                                         |
| model favorite切替             | model picker内Tab                                                            | 保存する選好。選択設定の変更でも補完でもない                                                                                        |
| model検索・検索語の末尾削除    | pickerで文字/貼付、Backspace/Ctrl-H                                          | 一覧を絞る。通常editorのカーソル編集とは別                                                                                          |
| 認証入力・保存・末尾削除       | masked画面で文字/貼付、Enter、Backspace/Ctrl-H                               | credential入力。通常会話draftではない                                                                                               |
| 認証入力の全消去               | masked画面Ctrl-U                                                             | credential全体を消す。通常入力Ctrl-Uの行頭まで削除と違い、今回の扱いは未決                                                          |

Ctrl-D/Ctrl-Qはoverlayより先に処理される。Ctrl-I、Ctrl-J/M、Ctrl-[はそれぞれTab、Enter、Escと同じ制御文字であり、別操作を増やしているわけではない。F2は現在未割当である。

## 混同しやすい対比

**ready / working と accepted / completed。**
新しいタスクを送る前はready、送信受付を確認した出来事がaccepted、実行活動がworking、結果がcompleted、その後に次タスクを送れる状態がready。現行はsettled
executionを先に返すためcompletedが残り、noticeのacceptedも残る。これは別々の事実を混ぜた表示であり、completedをreadyへ単純に名前変更する関係ではない。working中も追加指示を入力できるので「入力可／不可」の二値化もしない。

**cancel requested / cancelling / cancelled。**
Escで取消要求を出す、Coreがrequestedを返す、実行終了まで待つ、最後にcancelledという結果を読む、という区別がある。ただし現行cancellingは送信前後のローカル待ちも含む。したがって現行表示でcancellingを見ただけでは「Coreが取消受付を確認した」とは言えない。cancel
rejected/unconfirmedをcancelledへまとめると、再確認すべきか判断できなくなる。

**canonical / settlement。**
前者は正式な会話への採用、後者は実行プロセス等の終了処理。非採用でも途中本文やツール記録は存在できる。どちらもファイル変更のロールバック有無を表さない。通常利用では説明負担が大きくフッターから省けるが、APIまで削る提案ではない。

**view / resume / new。** 別Session Bをviewしても、Coreのactive Session
Aはそのまま。BをresumeするとCoreの作業対象がBになる。newは新しいSession Cを作る。view
Aで既にactiveのAを表示する場合は送信可になり得るので、「viewは常に読み取り専用モードを設定する」という説明は不正確。newも「この会話の複製」ではなく、閲覧元の実行設定等を引き継ぐ別Sessionの開始と説明するのがよい。

**context / recall。**
contextは現在の圧縮checkpointや準備中のrecall、直近request、active設定を読む。recallは過去executionの情報を次タスクのために用意する変更操作。context画面にrecallの確認が含まれるのは重複ではなく、変更した状態を読む関係である。将来候補の@注入が現在存在するとは扱わない。

**steering / follow-up。**
「この実装ではAを優先して」は現在のexecutionへの追加指示、「終わったらBも調べて」は別の次タスク予約。現行follow-upは単に終了後なら必ず実行されるのではなく、成功しstopReasonがfinal/tool_terminalのときに開始される。取消・失敗等では予約文と理由を記録に残して開始しない。両方を「追加メッセージ」とだけ呼ぶといつ実行されるかを失う。

**provider / model / effort。**
providerは接続先・提供経路、modelはそこで使うモデル、effortはその組の推論設定。UI上は独立三項目に見えるが、provider選択はmodel/effortも、model選択はeffortも変更し得る。更新通知を省くなら変更後の三項目を見れば実際の選択結果を分かることが前提。認証は別軸で、credential
presentだけでは実行成功は分からない。

**会話本文の履歴 / 入力履歴。**
PageUpで過去の返答を見ることと、↑で過去の送信文をdraftへ戻すことは別。`history N/M`と`history boundary`を一つの「履歴状態」にすると、何を動かしたか分からなくなる。前者は本文位置、後者はeditorの候補位置として扱う。

**detach / quit。**
detachは観測画面を離れるだけ。quit方針の現行shutdownは作業主体のCoreを終了する。コマンドとキーをそれぞれまとめて案内するのは可能だが、この二つをexitという一つの意味へまとめるのは目的を変える。

## 表示省略・表記統一・操作削除を分ける

- 表示だけ省く候補:
  通常タスクの独立したaccepted、常設completed、canonical/settlement、見えているタイトル・実行設定と重複する成功通知、credential
  present常設。省略により受付反映・準備済み予約・異常結果が見えなくならない範囲で行う。
- 表記を一本化できるもの:
  ready/表示上idle、同じ受付反映待ちの二表現、history位置の詳細/短縮、キー別名の案内、各種操作失敗の「対象＋結果＋理由」という文体。ただしcancel
  idle、入力履歴、確認不能は別の意味として残す。
- 操作自体の削除方向:
  workspaceパス補完、Ctrl-O改行説明、通常入力Ctrl-W/Alt-D/Ctrl-U/Ctrl-K、pickerを閉じるCtrl-C。これは情報の移設ではなく利用者が選ぶ操作体系の変更である。
- 統合時に失うと困るもの:
  viewとresumeのCoreへの影響、contextとrecallの読取/変更、steeringとfollow-upの実行対象と時機、clearとcancelの対象、detachとquitの寿命範囲。これらは見た目が近くても保持する。

## root案に対する補正・未決事項

root案の大枠に意味の重大な取り違えは見つからなかった。以下を補うとより正確になる。

1. readyの意味を「次の入力を送れるか」から「新しいタスクを開始できるか」へ絞る。実行中の入力・追加指示とは分ける。
2. acceptedを省く対象はroot案どおり「通常タスク」に限定して説明する。follow-upの予約成立はworkingでは分からず、現行は本文のfollow-up記録で別に示している。steeringも受付と本文反映までの間がある。
3. cancellingを厳密なCore状態と扱わない。現行はローカルcancel要求待ちも含む。整理後どの粒度を表示するかは未決。
4. `/context`説明にlatest requestの短い情報も含める。raw
   request全文や「modelへ送った全contextを見る」機能という説明はsourceが支持しない。
5. provider/model/effort変更成功を省く際、三つの選択が連動して変わる意味を保持する。個別項目だけを成功通知の代替にしない。
6. `history N/M`は本文log
   entryの位置である。新着Nもturn数ではない。短いラベルにしても件数の単位は混ぜない。
7. 「READ-ONLYだから失敗」「DISCONNECTEDだからCore停止済み」とは解釈しない。またviewは常に読み取り専用にする指示ではない。

未決なのは、文脈依存Enter/Esc案内の残し方、slash候補をpickerへ拡張するか、F1と常設案内の分担、Session一覧F2の確定、改行とfollow-upのキー、masked認証入力Ctrl-Uの扱いである。Shift-Enterを望む利用者意図と、Ghostty+tmuxではAlt-Enterだけ動く観測を分けて扱い、source上のCSI-u対応だけで利用環境でも使えると結論しない。`@`と`/edit`は将来メモのままとする。

結果と操作失敗をsystem>へまとめる方針には、HTTP経路で一般的な実行停止理由を本文へ投影することと、ローカル通知がsnapshot再構成後にも必要な期間残ることが必要である。現在のExecutionViewにはoutcomeとdiagnosticIdはあるが理由本文はなく、既存のworker
TUIでできることをHTTP経路で実装済みとは見なせない。配色について今回のsource調査は人間の見え方の代替にならない。

## 直接確認したsource

相対pathと行番号。記載はcurrent sourceの確認位置で、実機動作を追加検証したものではない。

- [v0/tui/remote_session.ts:841](../../v0/tui/remote_session.ts#L841)：保留command、active対象、submit/cancelの能力判定。
- [v0/tui/remote_session.ts:865](../../v0/tui/remote_session.ts#L865)：credential
  presenceの表示条件。
- [v0/tui/remote_session.ts:882](../../v0/tui/remote_session.ts#L882)：statusText。受付進捗・結果・ready・READ-ONLYが同じ関数に混在。
- [v0/tui/remote_session.ts:943](../../v0/tui/remote_session.ts#L943)：noticeとstatusの結合、readyをidleへ変換。
- [v0/tui/remote_session.ts:1011](../../v0/tui/remote_session.ts#L1011)：入力履歴と入力内行移動の優先。
- [v0/tui/remote_session.ts:1110](../../v0/tui/remote_session.ts#L1110)：command
  receiptをsnapshotで観測する判定、accepted notice。
- [v0/tui/remote_session.ts:1150](../../v0/tui/remote_session.ts#L1150)：task/steering/follow-up受付・draft保持・入力履歴登録。
- [v0/tui/remote_session.ts:1280](../../v0/tui/remote_session.ts#L1280)、`:1323`：取消受付結果と、API応答前からのcancellationRequested。
- [v0/tui/remote_session.ts:1360](../../v0/tui/remote_session.ts#L1360)：helpの説明、操作対象・停止時follow-up説明。
- [v0/tui/remote_session.ts:1393](../../v0/tui/remote_session.ts#L1393)、`:1525`、`:1559`：閲覧subscription変更とCore
  sessionOpenの別経路。
- [v0/tui/remote_session.ts:1690](../../v0/tui/remote_session.ts#L1690)、`:1748`：recall変更とcontext読取。
- [v0/tui/remote_session.ts:400](../../v0/tui/remote_session.ts#L400)：context画面のcheckpoint、pending
  recall、latest request、active config。
- [v0/tui/remote_session.ts:1818](../../v0/tui/remote_session.ts#L1818)、`:1851`：Core終了と14コマンドのdispatch。
- [v0/tui/remote_session.ts:1983](../../v0/tui/remote_session.ts#L1983)：グローバル終了キー、overlay優先、入力・履歴・送信の分岐。
- [v0/tui/remote_session.ts:453](../../v0/tui/remote_session.ts#L453)：elapsedはexecution.createdAtをrendererへ渡す。
- [v0/tui/remote_session.ts:568](../../v0/tui/remote_session.ts#L568)：snapshot本文投影とfollow-up/steering通知。
- [v0/tui/layout.ts:176](../../v0/tui/layout.ts#L176)、`:192`、`:217`、`:244`、`:272`：操作・結果の文字列分類、履歴entry位置、working/elapsed、各footer要素。
- [v0/tui/state.ts:946](../../v0/tui/state.ts#L946)：snapshot由来entriesによる本文置換。
- [v0/tui/snapshot_presentation.ts:269](../../v0/tui/snapshot_presentation.ts#L269)：HTTP会話本文のmessage投影、user>/steer>。
- [v0/tui/slash_command.ts:22](../../v0/tui/slash_command.ts#L22)、`:39`：14コマンドと候補検索。HTTPの引数解釈はremote_session.ts側。
- [v0/tui/input_decoder.ts:149](../../v0/tui/input_decoder.ts#L149)、`:158`、`:298`、`:355`：Enter制御文字、Backspace/0x08、Alt-Enter、CSI-u改行。
- [v0/tui/remote_catalog_ui.ts:389](../../v0/tui/remote_catalog_ui.ts#L389)、`:476`：picker文脈とprovider/model/effort選択の連動。
- [v0/tui/remote_catalog_ui.ts:563](../../v0/tui/remote_catalog_ui.ts#L563)、`:738`、`:749`、`:769`：設定保存、masked
  credential入力と全消去・保存。
- [v0/agent/host/core_service.ts:534](../../v0/agent/host/core_service.ts#L534)：newの閲覧元model選択とactive側設定の継承。
- [v0/agent/host/core_service.ts:1022](../../v0/agent/host/core_service.ts#L1022)、`:1151`、`:1218`：sessionOpen、selectionChange、recallのCore側操作。
- [v0/agent/host/task_service.ts:133](../../v0/agent/host/task_service.ts#L133)、`:168`、`:196`、`:276`：steering、follow-up、取消、成功後に限る次タスク開始。
- [v0/api/contract.ts:288](../../v0/api/contract.ts#L288)、`:336`：follow-up状態とExecutionViewの結果・採用・終了処理。
- [v0/agent/host/api_projection.ts:722](../../v0/agent/host/api_projection.ts#L722)：processSettlementのrunning/settling/unknownと保存済み結果の投影。

今回行っていないこと:
test、build、TUI/provider実行、config・稼働Core・binaryの読取、repository変更、別agent起動。相談報告以外の書込みなし。
