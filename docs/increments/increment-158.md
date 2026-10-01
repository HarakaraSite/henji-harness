# Increment 158 — フッター2・3行目の区切りとラベル省略

更新日: 2026-10-01

ステータス: **完了（2026-10-01、利用者がIncrement 168まで完了と明示）。**
配置後の操作確認は利用者指定により省略した。完了承認は末尾の利用者判断を参照する。

## 要件と権限

利用者の「フッター2行目、3行目も区切りとして | を入れる provider: model:は省略する」を採用する。
区切りは1行目と同じ `│` に揃える。2行目はworkspace、session、titleの間、3行目はprovider、model、
effortの間へ区切りを入れる。`session:`は保持し、`provider:`と`model:`は省略する。
実行中の2行目先頭にあるworking／cancellingと経過時間、狭い画面での省略順序を維持する。

```text
[/home/agent/projects/henji-harness │ session:4de84efc │ untitled]
[opencode-go-chat │ mimo-v2.6-pro │ auto]
```

当初の指示はlocal変更と非破壊的検証を許可する。
追加指示「コミットプッシュ配置して」によりcommit/push・常用配置を行う。
利用者の追加指定により、配置後のフッター・working・elapsedの操作確認は省略する。公開は未指示。
構想・architecture・roadmapの意味変更は不要。

## 現行経路と計画

通常CLI → remote TUI → CoreのSession SSE snapshot → `projectionFromSnapshot`／起動表示state →
`TuiRenderer` → `layoutUi`の`footerSessionText`／`footerModelText` → terminal frame。
CoreがSessionのidentity・選択を所有し、TUIはその表示を組み立てる。保存形式・API・新しい状態は変更しない。

`v0/tui/layout.ts`の2・3行目を変更し、区切りを含めた表示幅で既存のpath／model省略を計算する。
3行目のラベル有無による分岐は不要になるため一つの表示式へまとめる。 既存footer
testの旧表記を更新する。

## 検証方針

- footerのfocused testで2・3行目、title・model・Session切替、狭い画面の表示幅を確認する。
- retained terminalのfocused確認で実行状態とelapsedの先頭表示を確認する。
- 必要なtype check、変更ファイルのformat・lint、git diff --checkを行う。full gateは要求しない。
- 隔離HOME/XDG/workspaceのtmuxでproduction TUIを起動し、通常表示、title更新、狭い画面を確認する。
  workingと経過時間の実画面はlocalhost模擬providerへの一回のrequestで確認する。
  外部providerへの送信は行わず、実config・既存Core・常用binaryは変更しない。

## 結果

### 実装とfocused確認

2行目のworkspace／session／title、3行目のprovider／model／effortの間へ `│` を入れた。
3行目はラベルを省略し、表示幅の計算を新表記へ揃えた。既存のpath／model末尾を残す省略と、
表示幅不足時のtitle／path省略順序を維持した。working／cancellingとelapsedを作る処理は維持した。

- footerのfocused確認9件がpass。model・Session・titleの更新、狭い画面、working／cancelling、
  elapsed更新と同実行のsnapshot反復によるtimer維持を確認した。
- 差分確認でfooter以外のlayout testにも旧ラベルのassertionが一つ残っていたため更新し、 conversation
  presentationとretained terminalの47件がpass。
- production CLIと関連4 test fileのtype check、変更TSのlint、変更TSとincrement文書のformat、 git
  diff --checkがpass。handoffの既存部分の折り返しは保持した。full gateは実行していない。
- 自己reviewでSession snapshotから表示までの経路、区切りを含めた幅計算、
  実行状態と時計の既存表示、旧ラベルを要求するassertionの残存を確認した。
  局所的な表示変更のため専門agentは利用していない。

最初のtest実行はcached-onlyの型依存cache不足で開始しなかった。 CLIとtestのtype
checkを別途実施し、focused実行はno-checkで検証した。

### 隔離tmuxのproduction経路

公式build scriptで今回のsource差分を含むcandidateを作り、そのcompiled CLI/Core/TUIを操作した。
HOME/XDG/workspaceとtmux socketを隔離し、実config・既存Core・常用binaryは変更していない。

| 操作・状態   | 観測結果                                                              |
| ------------ | --------------------------------------------------------------------- |
| 100列で起動  | 2行目のworkspace／session／titleと3行目の全項目が区切られる           |
| `/rename`    | 2行目のtitleが更新され、区切りを保持する                              |
| 40列へresize | pathとmodelを省略し、2・3行目が幅内に収まり、区切りを保持する         |
| 80列で実行   | 2行目先頭にspinner・working・elapsed、続いてworkspace／session／title |
| 実行継続     | elapsedが00:00から00:02へ進み、3行目の全項目と区切りも維持する        |
| Escでcancel  | executionがsettledとなり、workingと時計の表示が止まる                 |
| Ctrl-Qで終了 | TUI/Coreがexit 0。terminalのcanonical／echoを復元                     |

最初のtmux probeは、41文字のmodel行が40列でも全文表示されると誤って期待したため停止した。
実画面の正常なmodel省略を確認し、probeの期待を修正した。productionの省略規則は変更していない。
最終probeはlocalhost Responses providerへ1request、外部providerへ0request。
確認用Core/TUI/tmuxとBashは終了済み。実credentialは使用せず、実configへの書込みもない。

candidateと証拠の保存先: `/home/agent/.local/state/henji-build-artifacts/increment-158-20260929/`。
binaryは`henji.candidate`、build IDは
`5eb1fa96bed201c4a68bf6b53fee42da8fdea7d63421ecf353785c61ee5de2ec`。
`build.log`、`tmux.log`、`tmux-results.json`と`compiled-132382/`の画面・Core identityが実行証拠。

## 残る境界

この時点では利用者による表示確認・increment完了承認は未取得だった。後続の完了承認は末尾を参照する。公開は未指示。
構想・architecture・roadmapは変更していない。

## commit・push・常用配置（2026-09-29）

利用者の追加指示に従い、実装・既存testの表記更新・increment文書・handoffをcommitしてorigin/mainへpushする。
固定commitのclean checkoutから公式buildし、受入済みcandidateとruntime
SHA-256が一致することを確認する。
旧binaryを保存し、常用先へ原子的に配置する。利用者の追加指定により配置後の操作確認は省略する。
配置先とbuild候補のhash・version・source・buildの同一性を確認する。 追加provider
requestは行わない。既存Coreは停止・移行しない。 配置結果は後続の文書commitへ記録・pushする。

### 配置結果

実装・test・increment文書・handoffの6ファイルをcommit
`aacf90cc1bb652d3aba3a76feac9db6b7788959a`へまとめ、origin/mainへpushした。 固定commitのclean
checkoutからDeno 2.9.7で公式buildし、sourceDirty=falseのbinaryを生成した。 runtime
SHA-256は受入済みcandidateと一致した。
旧binaryを保持して`/home/agent/.local/bin/henji`へ原子的に配置し、
配置先とbuild候補のhash・version・source・buildが一致することを確認した。henji 0.7.0。

- build ID: `f89cf2a9a89adaf5cecaab601af95afb4d23d1e598499f36e6a6571015549860`。
- runtime SHA-256: `52ff26cfa05ab0b4ff953c5ec4b874572eace6de53bc256b4998474dc711b08b`。
- binary SHA-256: `d1032205ae8d8762980086896d50a8c7a31866fae98d38dc3034a691299ad493`。
- 旧binary:
  `/home/agent/.local/state/henji-build-artifacts/increment-158-20260929/deployment/henji.previous`。
  SHA-256: `eb4ad7cda6ca51a708f31b63342c47b51ac618487e282d312f47e8e8b003d4cf`。

証拠は同じ`deployment/`の`build.log`、`deployment.json`、`version.txt`。
配置後のフッター・working・elapsedの操作確認は利用者指定により省略した。 追加provider
requestは0回。既存Coreの停止・移行は行っていない。JSR公開とProduct正本の変更は行っていない。

## 完了承認（2026-10-01）

利用者の「同期して168まで完了してるし」により、Increment 168までの完了承認を記録した。
構想・architecture・roadmapの現行説明への同期も指示され、正本へ反映した。既存の検証・配置結果は上記を正本とし、
今回追加の実provider確認や公開は行わない。
