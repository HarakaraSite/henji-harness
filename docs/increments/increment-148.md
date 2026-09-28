# Increment 148 — HTTP接続TUIの起動ヘッダ・実行状態・入力クリア

更新日: 2026-09-28

ステータス: local実装・focused検証・compiled production
TUI確認、commit・push・常用配置・配置後確認完了。

## 採用動作と根拠

利用者は最新binaryでヘッダが表示されないことを報告し、原因調査後に修正を指示した。
通常起動、同Sessionへの再接続、Session切替で既存の起動ヘッダを表示する。
Sessionのtitle・identityと起動情報は現在表示中のSessionへ追従する。
Workerが未評価のcontext／skillsは未評価と表示し、評価済み情報が届いたら更新する。
利用者の追加報告によりworkingと経過時間も復旧する。追加指示によりCtrl-Cはbusy中も入力クリアに
統一する。cancelはEsc、detachはCtrl-D／exit。受付済み実行とfollow-upはdetach後も継続する。
利用者の追加指定によりworking／cancellingとelapsedはフッター二行目の最初のカラムへ置く。
一行目は通知・操作案内・履歴位置等を表示する。

配置済みsource `76ba82ec…`の通常起動を隔離XDG・tmuxで再現した。
footerは表示されるがヘッダはない。起動時のAPI startupはstatusだけで、execution／provider
requestはゼロ。 証拠: `/tmp/henji-header-diagnosis-eifrbjop/initial.txt`と`summary.json`。

## 現行経路と修正範囲

通常henji → tui_cli → remote_tui_cli → Core自動起動／session.open → Session SSE snapshot →
remote_sessionのrenderSnapshot → TuiRenderer → retained layout。
HTTP接続TUIへの切替でrenderCompactStartupの呼出しが抜けた。 API
projectionもWorker未評価時にHostが持つ既知の起動情報を返していない。

Hostが所有する起動表示情報を未評価時もAPIへ投影する。既存RuntimeDisplayStateに評価statusを付けた
API型を明示し、TUIはSession snapshotを既存のヘッダ表示stateへ変換する。 Hostで選択済みのbase
instructionも起動表示へ含める。context／skillsの評価のためにWorkerを起動しない。
新しい保存先、fallback、migration、provider callは追加しない。 remote TUIはturn_start
eventを受けないため、既存timerが開始されなかった。executionのcreatedAtを既存
rendererへ渡し、再接続でも実開始時刻からelapsedを表示する。notice付きstatusをworkingへ文字列変換
してfooterのbusy判定から外していた処理も修正する。Ctrl-Cのcancel／二回目detach分岐を入力クリアに置換する。

## 確認計画

focused確認は起動前の既知情報、Worker評価後の更新、title変更とSession切替、既存の履歴scrollを対象とする。
実Core／HTTP／Host／Workerとlocalhost providerによる既存経路を使う。type、format、lint、diff
checkを行う。
公式scriptで修正候補binaryをrepository外にbuildし、隔離XDG・tmuxで通常起動、detach／再接続、rename、
new／none切替とcompact表示を確認する。外部provider requestはゼロ。full gateは実行しない。
busy／cancel中のCtrl-C入力クリア、Esc cancel、Ctrl-D
detachと同実行への再接続、elapsedの進行も確認する。

local修正と非破壊的検証が承認範囲。commit／push／常用配置、構想・architecture・roadmap変更は含めない。

## 実装結果

未評価時もHostが持つ起動情報を返すAPI型を明示し、snapshotから既存ヘッダstateへ接続した。
通常起動・再接続・Session切替・session-only updateで現在のpositionと起動情報を反映する。 base
instructionはHostの選択結果を表示し、Worker未評価のcontext／skillsはnot evaluatedとする。

既存timerをexecutionのcreatedAtから開始する。snapshotを繰り返し受けてもtimerを作り直さず、
同実行への再接続で実経過時間を引き継ぐ。別execution開始時は起点を切り替え、idleでは止める。
working／cancellingとelapsedはフッター二行目の先頭へ移した。一行目のnoticeは実行状態を隠さず、
操作案内は幅に合わせて表示する。credential presenceは操作案内より優先しない。

Ctrl-Cのbusy cancelと二回目detachを廃止し、通常入力欄のdraftクリアへ統一した。
Escがcancel、Ctrl-D／exitがdetachとなる。ヘルプと[HTTP API操作](../operations/http-api.md)も更新した。

## 確認結果

remote TUIの140〜144・146、retained terminal、conversation presentationのfocused確認66件と、
実Core／HTTP／Host／Workerの139・140確認2件が通過した。API確認で起動情報のreadback、未評価時の
Worker未起動、評価後の更新を確認した。session-only updateのtitle／context／skills更新と、
二行目のclock、snapshot反復でのtimer維持、cancel中の入力クリアを追加確認した。 最後のcredential
presence表示調整後は、関係するretained／140／141／142の38件を再確認した。

変更経路と関連API consumerのtype check、変更fileのformat／lint、diff checkが通過した。
143の既存testは従来のdouble quote・80列styleを維持してformat確認し、無関係な全file整形を避けた。
full gate、独立agent reviewは実行していない。rootが差分と実経路を確認した。

公式build scriptで最終candidate `/tmp/henji-i148-probe/henji`を作成した。

- version: `henji 0.7.0`、source `e5872d18…+dirty`（今回の未commit差分を含む）。
- build ID: `db6005bce44f64c32488e99f41f1244d756325ffa599d2ef1aa41a87cd18f87b`。
- runtime SHA-256: `56b37145d45bea8c94c1d0748ef472bf55aa16ec7443c214baa7cd2db92771fd`。
- binary SHA-256: `27752f674c564bae7556704c3adeb6f60ef05ee353e9403fb8d315c852284497`。

最終candidateそのものを隔離XDG・tmuxのproduction TUIで確認した。
通常起動のヘッダと未評価表示、Worker評価後のAGENTS.md表示、80列でworking／clockの二行目表示、
busy中のdraftクリアと二回目Ctrl-Cでも実行継続、Ctrl-D後のCore／execution維持と同実行への再接続、
elapsedの引継ぎ、完了後の通常起動で同Sessionへの再接続、rename、/new、CLI --new、Esc cancel、 none
Sessionと50列・12行のcompact headerを確認した。最終probeはlocalhost providerへの2requestだけ。
確認用Core・tmuxは停止済み。実config・既存Session data・常用binaryは変更していない。

最終証拠は `/tmp/henji-i148-probe/production-5/evidence`のproduction-summary.jsonと各screen。
検証scriptは `/tmp/henji-i148-probe/production_smoke.py`。 途中probeではbuiltin providerのendpoint
override設定と不整合なstream fixtureを修正した。 またCLI
--newのprovider指定漏れにより、隔離された検証用仮キーでOpenRouter Chatへ1requestが発生し、
HTTP401で停止した。実credentialは使用していない。短いfactは
`/tmp/henji-i148-probe/production-4/evidence/incidental-provider-request.json`に保存した。
最終probeではCLI --newにもlocalhost providerを明示し、追加の外部requestはゼロ。

## commit・push・常用配置

利用者は2026-09-28にpushと配置を明示指示した。修正と関連文書・通常利用メモをcommitし、
origin/mainへpushする。cleanな実装commitから公式build scriptでbinaryを作り、検証済みcandidateと
runtime SHA-256が一致することを確認する。旧binaryを保持して常用先へ原子的に配置し、
配置binaryそのものを隔離XDG・tmuxで通常起動、ヘッダ、detach、再接続、Core stopまで確認する。
追加の実provider requestとfull gate再実行は行わない。

配置前のread-only確認では、`/home/agent`とrepository workspaceのCoreはともに非稼働だった。
起動情報APIを修正したため、次の通常起動では配置済みの同じbinaryでCoreとTUIを起動する。
JSR公開、構想・architecture・roadmapの意味変更は今回の配置対象に含めない。
未採用の一括終了スラッシュコマンド案は利用者の「メモだけ」指示に従い、
[通常利用メモS25](../experience/normal-use-inbox.md#s25--tui将来のwebuiとcoreをまとめて終了するスラッシュコマンド)
へ記録した。subagent起動判断の検討も同メモA24へ記録した。両項目の実装は今回に含めない。

### 配置結果

実装・test・関連文書・通常利用メモをcommit
`b4ac0b94173cb04bdd435489d928ac961f0b654e`へまとめ、origin/mainへpushした。
cleanな実装commitからDeno 2.9.7の公式build scriptでcompiled binaryを作り、
`/home/agent/.local/bin/henji`へ原子的に配置した。

- version: `henji 0.7.0`、sourceは上記実装commit、dirtyなし。
- build ID: `6118ba3ba26ca884f9263bf99d6651a1dfca6dcad048921f4a87685c9e914f47`。
- runtime SHA-256: `56b37145d45bea8c94c1d0748ef472bf55aa16ec7443c214baa7cd2db92771fd`。
  working／elapsedと入力操作を含む最終検証済みcandidateと一致した。
- binary SHA-256: `cbdc92d8df12e67371d3b7e12163bd932067a2b6c210f00b994dde45c9267681`。
  clean候補と常用先のhash・version・source・buildが一致した。
- 旧binaryは`/tmp/henji-i148-deploy-2026-09-28/henji.previous`へ保持した。

配置binaryそのものを隔離XDG・新規workspace・専用tmuxで確認した。
Core自動起動、起動ヘッダと未評価表示、Ctrl-D後のCore保持、通常起動による同Session・同epochへの再接続、
rename、/new、none Session、50列・12行のcompact header、明示Core stopまで確認した。
利用者の追加質問に合わせ、二つのTUIが同じCore・Sessionへ同時接続すること、draftが各clientに独立していること、
片方のCtrl-Dがもう片方のTUIとCoreを終了しないことも確認した。 execution
admissionはゼロ、追加provider requestもゼロ。確認用Core・tmuxは停止済み。 実config・既存Session
dataには書いていない。

build・配置の証拠は`/tmp/henji-i148-deploy-2026-09-28/evidence`のbuild.logとdeployment.json、
最終production証拠は同rootの`production-2/evidence`のdeployed-smoke-summary.jsonと各screenに保存した。
配置後記録とhandoffは実装commitに続くdocs commitへまとめてpushする。
JSR公開、構想・architecture・roadmapの正本変更は行っていない。
