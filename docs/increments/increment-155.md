# Increment 155 — S25: TUIからCoreを停止する操作とスラッシュ案内

更新日: 2026-09-29

ステータス:
local実装・非破壊的検証・reviewer通常レビュー完了。commit/push・常用配置は承認済み、実施中。

## 要件と権限

利用者の「s25実装できる？ ショートカットも合わせて」により、S25を採用し、local実装と
非破壊的検証を行う。追加指示「\"/exit\"は/detachとしたら？」によりdetach操作を改名する。
追加指示「スラッシュと最初の一文字で案内を開始するようにしたら？」により、入力中の案内を追加する。
通常利用メモのS25を本書へ移す。元の観測は、UIからのdetach後に別CLIでCoreを停止する操作を、
UI内で完結したいという2026-09-28の利用者メモである。

対象は接続TUI、既存のHTTP Core停止経路、ショートカット、補完・ヘルプと操作文書。
WebUI本体は未実装であり追加しない。将来のWebUIは既存のbrowser-compatible API clientを使える。
当初のlocal実装指示には構想・architecture・roadmapの変更、commit/push、常用配置・公開を含めなかった。
利用者の追加指示「コミットプッシュ配置を行って」によりcommit/push・常用配置と配置後確認を行う。
JSR公開と構想・architecture・roadmapの意味変更は今回の追加指示に含めない。
既存の未採用S26メモは保持する。

| 操作                | 必要な動作                                                                                                                             |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `/detach`・Ctrl-D   | 操作元TUIの接続を切る。Coreと受付済みの仕事は続く。従来の`/exit`を改名し、aliasは設けない。                                            |
| `/shutdown`・Ctrl-Q | 接続先Core全体を停止し、資源清算後に操作元TUIも終了する。busy中と保存Session閲覧中も同じ動作。                                         |
| Ctrl-Qとoverlay     | ヘルプやpickerの表示中でもCore停止を開始し、overlayを閉じて停止中表示へ移る。                                                          |
| 別の接続TUI         | 停止されたCoreへの接続が切れ、DISCONNECTEDを表示する。別利用者は`/detach`・Ctrl-Dで閉じる。                                            |
| 別Core              | 同workspaceを含め、ほかのCoreは停止対象にしない。                                                                                      |
| 入力案内            | `/`だけでは案内を出さず、`/s`等の最初の文字から候補をフッターへ表示する。入力中の候補を優先して表示する。候補が一つならTabで補完する。 |

shutdownの意味は既存の明示Core停止と同じ。進行中の親子実行・tool/processを清算し、履歴を保存する。
通常のEOF・signal・detachはshutdownを送らない。停止の受付失敗はTUIに理由を表示する。

## 現行product経路と実装方針

通常CLI → `remote_tui_cli` → `runRemoteTui` → shared `HenjiApiClient` → `POST /api/v1/core/shutdown`
→ admission/SSE終了 → `CoreService.close` → Worker・子実行・process・history・instance所有権の清算 →
listener終了 → TUI terminal復元。
Coreが実行と保存状態を所有し、TUIはeditor・overlay・表示・自身の接続だけを所有する。
既存Core停止経路を利用し、新しい停止API・状態保存先・自動停止条件は増やさない。

既存CLIの停止観測をAPI clientへ移し、CLIとTUIで共有する。UIのdetachで観測を中止できるようにする。
入力decoderへCtrl-Qを追加し、Sessionやoverlayの状態に依存しない入口で処理する。
スラッシュ一覧を実際の接続TUIコマンドへ揃え、補完と受付の一覧を共有する。
editor変更時に候補を再計算し、フッターへ渡す。入力案内は状態とともに表示し、通常controlsより優先する。

## 検証方針

- 新しいfocused実Core
  testで、スラッシュ案内、補完、停止、清算完了待ち、他TUIの切断とterminal復元を確認する。
- decoder/slash/retained footerの既存focused確認と、接続TUI・Core管理・busy
  shutdownのregressionを確認する。
- 必要なtype check、format、lint、`git diff --check`を行う。full gateはこの計画に含めない。
- 隔離HOME/XDG/workspaceのtmuxで、sourceと検証用compiled TUIの実操作を確認する。 busy確認はloopback
  providerからBash toolを起動する。外部provider requestと実credentialの利用は行わない。

## 結果

### 実装

`/shutdown`・Ctrl-Qは接続先Coreの既存停止APIを呼び、503の清算期間を待ってlistener終了後に
terminalを復元する。Ctrl-Qはoverlay処理より先に受け付ける。停止中は停止表示を維持し、
Ctrl-Dで操作元TUIを先にdetachできる。`/exit`は`/detach`へ改名した。

コマンド一覧へ接続TUIで既に使える`/view`・`/resume`・`/context`も含め、補完と受付を同じ一覧へ揃えた。
候補の計算をeditor更新へ接続し、`/`では表示せず`/s`等から自動表示する。
入力中の案内はフッターのcontrolsより優先する。controlsは個別に幅調整し、追加のCtrl-Q案内で
既存Enter・detach案内がまとめて消えないようにした。切断後もDISCONNECTEDを優先して表示する。

ヘルプ、CLIの使い方案内、README、日本語README、HTTP操作文書を新しい操作へ揃えた。
構想・architecture・roadmapは変更していない。S25は通常利用メモから本書へ移し、既存S26メモは保持した。

### focused確認

- 11本の関連test file、77 testがpass。Core shutdown、Core管理、接続TUI、steering/follow-up、
  Session操作、catalog/login/path、decoder/slash、retained footerを確認した。
- 新しい実Core testでは80列のterminalで、`/`に候補が無いこと、`/s`からの候補、補完による停止、
  ヘルプ中Ctrl-Q、清算中503でTUIが待つこと、別TUIのDISCONNECTEDと明示detach、terminal復元を確認した。
- 最後のヘルプ修正後、155と140の6 testを再確認しpass。CLIと新testのtype check、変更TSのlint、
  format、`git diff --check`がpass。full gateは実行していない。
- 初回のbusy shutdown test実行は検証commandの`NODE_V8_COVERAGE`へのenv権限不足で中断した。
  実行commandを修正して既存testをpassさせた。productionへの回避処理は追加していない。

### 隔離tmuxのproduction経路

80×30、隔離HOME/XDG/workspaceでsourceと検証用compiled CLI/TUI/Coreを使った。 loopback Responses
providerが実Bash toolとその子processを起動する。最終比較のloopback requestは各1回、
合計2回。外部provider requestは0回、実credentialは使っていない。

| 操作・観測          | source                                                  | compiled                           |
| ------------------- | ------------------------------------------------------- | ---------------------------------- |
| `/exit`             | unknown commandとして扱う                               | 同左                               |
| `/detach`と再接続   | Core epochを維持                                        | 同左                               |
| `/`・`/s`・Tab      | `/`は案内なし、`/s`から2候補、`/shu`＋Tabで`/shutdown`  | 同左                               |
| busy中Ctrl-D        | TUI終了後もCore・Bash・子processが存続                  | 同左                               |
| busy中のCore停止    | `/shutdown`でCore/TUI終了                               | ヘルプ中Ctrl-QでCore/TUI終了       |
| busy中の入力案内    | `/s`から候補が見える                                    | 同左                               |
| 別接続TUI           | DISCONNECTEDを表示し、`/detach`で終了                   | 同左                               |
| 同workspaceの別Core | 停止対象外で継続                                        | 同左                               |
| 保存履歴            | 別CoreのHTTP historyで停止したexecutionをreadback       | 同左                               |
| idle時停止          | Ctrl-QでCore/TUI終了                                    | `/shutdown`でCore/TUI終了          |
| 保存Session閲覧中   | `/view`でactive slotを維持し、`/shutdown`でCore/TUI終了 | 同じ閲覧操作後Ctrl-QでCore/TUI終了 |
| terminal復元        | canonical/echoを復元、TUI exit 0                        | 同左                               |

busy停止後はBashと子processがともに不在で、Coreと操作元TUIもexit 0。
履歴のexecutionはsettled、表示は既存Core停止処理に従うfailed/non_canonicalだった。
実configへdefault-selectionを書かず、確認用Core/TUI/tmuxは終了済み。既存常用Coreには操作していない。

証拠は`/tmp/henji-s25-20260929/`。`focused-tests.log`、`help-focused-tests.log`、`build.log`、
`tmux-results.json`、`saved-view-results.json`に結果を保存した。 実画面、terminal設定、HTTP
historyは`source-run-99846/`・`compiled-run-99846/`、
保存Session閲覧の画面は`source-saved-run-100963/`・`compiled-saved-run-100963/`に保存した。
検証用binaryは同directoryの`henji-final`、build IDは
`ff5108983f39ca5ed0308e02f0074a858ec9e3962e335aa8d1a3568046657be8`。

local実装報告時点ではcommit/push・常用binary配置・公開は未実施だった。
その後の追加指示に基づく配置を次節に記録する。WebUI本体の操作は未確認であり、将来の実装範囲として残る。

## reviewer通常レビュー（2026-09-29）

利用者の「reviewerにコードとテストを通常レビューさせて」に従い、read-onlyのreviewerへ
コードとテストを独立確認させた。通常レビューの結果はBlocking 0 / P1 0 / P2 0、採用findingなし。

停止APIへの両入口、503の清算待機、terminal復元、通常detach/EOF/signalの独立性、overlayと
非同期callbackのgeneration処理、別TUI切断、editor更新と履歴・補完による候補更新、
スラッシュ一覧とdispatch、/exit alias廃止、受付失敗notice、footerとtestのproduct動作対応を確認した。
変更5 test file（155、140、keymap、retained terminal、tool preview）を隔離HOME/XDG・loopback限定で
独立実行し、57 testがpass。型checkとgit diff --checkもpass。

新しいproduction tmuxは実行せず、busy・保存Session閲覧・別Core継続は記録済みsource/compiledの
実経路証拠と照合した。停止受付失敗とEOF/signalはsource確認に留まる。
review中の対象16ファイルは開始時SHA-256と終了時が一致し、コード変更は無かった。
一時review入力・結果は`/tmp/codex-agent-context/increment-155-normal-review/`へ保存した。

## commit・push・常用配置（2026-09-29）

利用者の追加指示に従い、レビュー済み実装・test、要件・結果・レビュー結果、操作文書、
S25の採用移動とhandoffをcommitし、origin/mainへpushする。既存の未採用S26メモはlocalに保持する。
固定commitのclean checkoutから公式buildし、受入済みcandidateのruntime SHA-256と一致することを
確認して、旧binaryを保持したうえで常用先へ原子的に配置する。既存Coreは停止・移行しない。
配置binaryそのものを隔離HOME/XDG/workspace/tmuxで確認し、結果を後続の文書commitへ記録・pushする。
外部provider call、full gate、JSR公開、構想・architecture・roadmapの変更は行わない。

配置結果は実施後に追記する。
