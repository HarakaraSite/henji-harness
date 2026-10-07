# Increment 161 — セッションピッカーからの個別削除

現在の状態: **完了（2026-10-07、利用者判断による一律整理）**。

以下の状態・未実施・承認待ちの記載は当時の記録であり、本incrementの現在の残作業として扱わない。
この完了判断は過去の作業を閉じるもので、当時未実施だった実装・検証・配置等を実施済みに変更するものではない。

更新日: 2026-10-01

ステータス: **利用者確認・完了承認済み（2026-10-01）。Increment 161は完了。**
local実装・検証・常用配置・配置後確認を完了した。
利用者の「確認しました両インクリメントを完了とします」により完了承認を取得した。

## 目的と採用範囲

利用者の「セッションピッカーに削除操作をつけたい」により、A9の手動個別削除のTUI操作を採用する。
当初の指定は「Deleteキーでy/n確認して削除」。
配置後の追加指示「deleteキーじゃなくてdにして」、続く「操作体系は揃えたい」により、
現在の削除キーは`d`／`D`とする。再開の`r`／`R`と同様に大小文字を受け付け、表示は`D delete`。
保存期間、一括整理、期限による自動削除は今回の対象に含めない。
local変更と隔離環境での検証を行う。追加指示「配置して」により常用配置と配置後確認を実施した。
実データの削除、commit/push、公開は未指示。
構想・architecture・roadmapは変更しない。

## 必要な動作と根拠

- `/sessions`またはF1で開くピッカーで、選択したSessionで`d`または`D`を押す。
- 対象のtitleと完全なID、関連履歴も削除することを表示して`y/n`を確認する。
  `y`で削除し、`n`／Escで選択・ページを保持した一覧へ戻る。
- 成功後は一覧を再取得し、削除した行を除いた位置へ選択を合わせる。
  閲覧中の保存Sessionを削除した場合は、Coreの現在のSessionへ表示を戻す。
- Coreが開いているSessionは既存保存処理のロック対象なので、削除できない理由と
  そのCoreで別Sessionへ切り替える操作を案内する。実行中の作業を中断しない。

根拠は利用者の上記指定と、既存CLI `henji sessions delete --session ID --yes`の実装。
削除単位はSession・execution・semantic履歴・request
fact・recall参照関係を一体とする既存transactionを使う。

## 現行経路と変更計画

`/sessions`／F1 → remote TUI → `HenjiApiClient.sessionsList` → Coreの`sessionsList` →
SQLiteの保存Session一覧 → rendererのsession picker。
Enterは閲覧、Rは再開。TUIがローカルに保持するのは表示・選択・入力状態で、保存状態はCoreが所有する。
CLIの削除は`SqliteHistoryV7ProductionStore.delete`を直接呼んでいる。

1. HTTP APIに`session.delete` commandを追加し、既存CoreのcommandId／receipt経路から
   既存保存transactionを呼ぶ。API contract、codec、client、server、Coreを同時に更新する。
2. ピッカーの`d`／`D`入力で削除確認overlayを開く。
   確認中は対象選択を固定し、取消・成功・失敗をピッカー内で扱う。
3. 保存Sessionの閲覧subscriptionとCore側のsnapshot cacheを削除結果に合わせる。
   削除したSessionの履歴を表示し続けない。
4. 対応するfocused test、type check、format、lint、diff checkと、隔離XDG・tmuxのproduction
   TUIで確認する。full gate・外部provider callは計画に含めない。

## 検証と結果

現在の確認対象は`d`／`D` → y/n、取消時の無変更、削除後の一覧更新、閲覧中Sessionからの表示復帰、
Coreで開いているSessionの削除失敗表示、保存Sessionと関連execution履歴の実削除。
既存のSession閲覧・再開とretained terminal表示もfocused testで確認する。

### 初回Deleteキー版の実装とfocused確認

`session.delete`をHTTP commandとして追加し、既存の削除transactionを呼ぶ。 commandIdの再送とreceipt
readbackは同じ結果を返す。削除後はCoreのsnapshot cacheと
該当Sessionのsubscriptionを終了し、一覧から保存Sessionを除く。

ピッカーのDeleteキーでtitle・完全ID・関連履歴の削除を表示する。
`y`で削除、`n`／Escで元の選択・ページへ戻る。 削除中は確認操作を待機し、成功後は一覧を再取得する。
閲覧していた保存Sessionを削除した場合は、Coreの現在のSessionへ表示subscriptionを戻す。
Coreで開かれているSessionの既存ロックは維持し、そのCoreで別Sessionへ切り替える旨を表示する。

- focused testでは入力decoder、取消、削除、一覧更新、閲覧subscriptionの復帰、
  開かれたSessionの失敗表示、既存の閲覧・再開とretained terminalを確認した。
  修正後、対象4ファイルの43件がpass。production CLIと対象testのtype check、
  変更TSのformat・lint、`git diff --check`もpass。
- HTTPと実SQLiteの確認では、localhost模擬providerの1requestで保存したSessionを削除し、 Session
  readが404となり、execution・semantic履歴を再取得できないこと、
  同じcommandIdの再送とreceiptが同じ結果になること、Coreの現在Sessionが残ることを確認した。
- 初回確認で削除後の表示復帰が自分のcommand pending状態に遮られる問題を修正した。
  API成功後にpendingを解除し、既存の表示切替経路を使う。 HTTP
  testのcredential環境、模擬SSE、削除済みexecutionのread期待も既存契約へ合わせた。

### 初回Deleteキー版の隔離tmuxのproduction確認

公式build scriptのcandidateでCLI／Core／TUIを起動し、隔離HOME・XDG・workspaceで操作した。
実config、実Session、常用binary、既存Coreは変更していない。

| 操作                                   | 観測                                                      |
| -------------------------------------- | --------------------------------------------------------- |
| F1で一覧、Delete                       | 選択対象の日本語title・完全ID・関連履歴削除とy/nを表示    |
| `n`とEsc                               | 保存Sessionが残り、同じ選択へ戻る                         |
| 40列へresize                           | title・完全ID・確認操作を折り返して表示し、取消可能       |
| 保存SessionをEnterで閲覧し、Delete→`y` | 保存一覧から消え、Coreの現在Sessionへ表示を戻して一覧更新 |
| 開かれているSessionでDelete→`y`        | 削除せず、Coreで別Sessionへ切り替える理由を表示           |
| Ctrl-Q                                 | TUI／Coreともexit 0、terminalのcanonical／echoを復元      |

production tmuxはprovider request 0。HTTP focused testはlocalhost 1request／runで、 外部provider
callは0。確認用Core・TUI・tmuxは終了した。

証拠の保存先: `/tmp/henji-increment-161/`。 production
captureは`tmux-199495/`、一覧は`tmux-results.json`。 candidate build
IDは`5300b373035012688ec99322fcebf04b351e26e8f94e9a4d53633bfb113dd73e`。 full
gateは計画に含めず実行していない。常用配置と配置後確認は以下を参照する。commit/push・公開は未指示。


## 初回Deleteキー版の常用配置・配置後確認（2026-10-01）

利用者の「配置して」により、常用binaryへ配置した。commit/pushは今回の指示に含めず、
検証済みlocal sourceのcandidateを配置したためsource identityは`85256f4e…+dirty`。

現在のsourceを公式scriptで再ビルドし、検証済みcandidateとのversion・build ID・runtime digestの一致を確認した。
再ビルドの実行ファイル全体はbyte一致しなかったため、配置には操作確認済みcandidateそのものを使用した。
配置前のbinaryを`deployment/henji.previous`へ保存し、一時fileから常用先へrenameした。
配置後のbinary SHA-256と`--version`は検証済みcandidateと完全一致。

- 配置先: `/home/agent/.local/bin/henji`
- version: `henji 0.8.0`
- build ID: `5300b373035012688ec99322fcebf04b351e26e8f94e9a4d53633bfb113dd73e`
- runtime SHA-256: `d9975e1d4f9473a0be7d21a79ad1f7729d80b79e564f90609d0fde0d00d94e28`
- binary SHA-256: `8638e22f2f27a36e851ae953ac48b76189378b3a758c9f44b7cc06eb6ffb0c28`
- 配置前後とも既存Core PID `32600`／`62516`を保持。停止・再接続・既存Sessionの削除は行わない。

配置済みbinaryを隔離HOME・XDG・workspace・tmuxで起動し、F1のピッカー、Delete→y/n、
`n`／Esc取消、40列の確認表示、閲覧中Sessionの削除、一覧更新と現在Sessionへの表示復帰、
開かれているSessionの削除失敗案内を確認した。Ctrl-QでTUI/Coreともexit 0。
確認用Core・TUI・tmuxは終了し、provider requestは0。

配置前の初回probeはbyte一致確認が止まった後に旧binaryで動き、Delete確認に到達せず終了した。
操作確認済みcandidateそのものを配置して、配置後probeを再実行し全操作がpass。
実config・実Sessionはこのprobeに使っていない。

証拠・旧binary・配置結果の保存先:
`/home/agent/.local/state/henji-build-artifacts/increment-161-20261001/`。
local確認の証拠も`local-verification/`へ複製して保存した。
配置記録は`deployment/deployment.json`、配置後実操作は`deployment/tmux-200501/`と
`deployment/tmux-results.json`。新しい通常起動から適用する。
旧Coreへの明示再接続では、そのCoreの旧機能を引き続き使う。


## 小文字`d`版への変更・再配置（2026-10-01）

利用者の「deleteキーじゃなくてdにして」により、ピッカーの削除キーを`d`へ変更した。
フッターとピッカー見出しは`d delete`と表示する。`y`で削除、`n`／Escで取消する操作は維持。
当初追加したDelete専用の入力event・decoder分岐とそのtestは利用先がなくなるため削除した。
通常入力欄の`d`は文字入力で、削除確認を開くのはSessionピッカー内のみ。

- 対応する既存remote TUI testを`d`操作へ変更し、閲覧・再開・retained terminal・keymapを含む
  focused 41件pass。production CLIのtype check、変更TSのformat・lint、diff checkもpass。
- 新candidateと配置済みbinaryの両方を隔離HOME/XDG/workspace/tmuxで確認した。
  `d`→y/n、`n`／Esc取消、40列の表示、閲覧中の保存Session削除、一覧更新と現在Sessionへの復帰、
  Coreで開いているSessionの失敗案内、Ctrl-Qでの正常終了を確認した。
- 直前のDeleteキー版を`d-key/henji.previous`へ保存して常用先へrenameした。
  配置後のファイルdigestとversionは操作確認済みcandidateと一致する。
  実config・実Session・既存Coreは変更せず、確認用Core/TUI/tmuxは終了。provider requestは0。

配置先は`/home/agent/.local/bin/henji`。新しい通常起動から`d`操作が有効。
最新build ID: `abe8b5556ce09ba675a782a45d43264b594c5ce2ebf242317ca2f82fbf14edf8`。
最新runtime digest: `12138979535d6d798279676264c000b1cfe9acba7fb357533d8fd9f3ffc2aef7`。
最新binary digest: `181b306de02f5c996c5ed9c03c548f62e53ed1b72d9210977c3543ed49ee3afd`。
sourceは引き続き`85256f4e…+dirty`。commit/push・公開は未指示。

証拠の保存先は`/home/agent/.local/state/henji-build-artifacts/increment-161-20261001/d-key/`。
配置前のcaptureは`tmux-201103/`、配置後は`tmux-201261/`。
最新の配置結果は`deployment.json`、配置後の操作結果は`tmux-results.json`。


## 大小文字の操作体系統一・再配置（2026-10-01）

利用者の「操作体系は揃えたい」により、削除キーを`d`／`D`の両方へ変更した。
再開の`r`／`R`と同じ受付方針とし、表示は`R resume`・`D delete`とする。
`y`／`Y`で削除、`n`／`N`・Escで取消という既存動作は維持した。

- 既存操作testを大小文字の双方で確認する入力へ更新し、remote TUI・retained terminalのfocused
  34件pass。production CLIのtype check、変更TSのformat・lint、diff checkもpass。
- candidateと配置済みbinaryを隔離XDG・workspace・tmuxで操作した。
  `D delete`表示、小文字`d`での確認・取消、大文字`D`での確認・削除、40列表示、
  一覧更新と閲覧中Sessionからの復帰、開かれているSessionの失敗表示を確認した。
- 操作確認済みcandidateを常用binaryへ配置し、配置後のversionとbinary digest一致を確認した。
  直前の小文字`d`版は`d-case/henji.previous`へ保存した。
  実config・実Session・既存Coreは変更せず、確認用Core/TUI/tmuxは正常終了。provider requestは0。

最新build ID: `fac87003fba6d3cee8857e77a2b5825395674eafec0b3b78cb175e6ac9f90959`。
最新runtime digest: `36dd743b27cd50f1a8c0abdb6351b4c538eab0e1d08fe503d8b887aa734a2721`。
最新binary digest: `dffcd02b9f1132501a42c935c1b03ddf29bb52075069faf53034dd60dcf236fd`。
sourceは引き続き`85256f4e…+dirty`。commit/push・公開は未指示。
新しい通常起動から適用する。

証拠は`/home/agent/.local/state/henji-build-artifacts/increment-161-20261001/d-case/`。
配置前は`tmux-202152/`、配置後は`tmux-202384/`。
最新の配置結果は`deployment.json`、操作結果は`tmux-results.json`。
