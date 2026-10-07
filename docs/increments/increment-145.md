# Increment 145 — S22 Slice 7: Coreの発見・自動起動・独立lifetime・明示停止

現在の状態: **完了（2026-10-07、利用者判断による一律整理）**。

以下の状態・未実施・承認待ちの記載は当時の記録であり、本incrementの現在の残作業として扱わない。
この完了判断は過去の作業を閉じるもので、当時未実施だった実装・検証・配置等を実施済みに変更するものではない。

更新日: 2026-09-28

ステータス: 実装・検証・独立review・commit・push・常用配置完了。
利用者の追加指示による配置結果は[合同配置記録](s22-deployment-2026-09-28.md)を参照する。

## 採用動作と根拠

canonical workspaceとXDG state rootからCoreを発見し、未起動なら自分のsource／standalone executableで
独立processを起動する。同時launcherは同じCoreへ接続する。UIの終了とsignal後もCoreは残る。
statusは起動せず照会し、明示stopは新規受付を閉じ、Worker／子実行／processを清算して終了する。
停止後の次の人間の起動は新epochとなり、途中taskを自動再実行しない。
根拠は利用者承認済み[詳細設計](../plans/s22-detailed-design-and-slices.md)のSlice 7と
[CLI・外部API設計](../plans/s22-cli-and-external-api.md)。通常入口切替はSlice 8で行う。

## 現行経路と変更範囲

serveはCoreServiceとHTTP serverをforegroundで所有し、remote TUIは明示URLへ接続する。
launcherがdescriptorと短い起動mutexを所有し、Coreは別のinstance lockを生存中保持する。
listen後にatomic ready metadataを公開し、launcherはtoken付き起動結果とAPIのworkspace・epochを
照合してから返す。内部bootstrapは親が持つ起動mutexを再取得しない。
Coreの既存close経路がWorker／子実行／history／SSEを清算し、HTTPのstopがその経路へ入る。
metadataはSession／executionの正本ではなく、credential・task本文を含めない。 自動restart、task
replay、idle自動停止、systemd、WebUI本体、一般hardening、B6は対象外。

## 分担と検証

Rootはlifecycle helper、統合、production操作、finding採否と結果記録を担当する。 CLI
implementerはserve／管理CLI／内部bootstrap／launcher focusedを、backend implementerは
CoreとHTTPのshutdown・共有contract・shutdown focusedを担当する。lifecycleとCLIとshutdownを
責務境界で分離して並行実装する具体的な利点があるため委譲する。他担当の変更は戻さない。

focusedは隔離processで同時launcher、別workspace、status非起動、stale descriptorと新epoch、
startup失敗、HTTP stopの資源清算を確認する。変更箇所のtype・deno.v0 fmt・lint・diffを使う。
Rootは隔離XDGとtmuxでsource・standalone双方の独立寿命、UI終了／signalと再接続、 少量の実provider
task、明示stopを確認する。実providerの対象・回数・保存先は直前に報告する。
安定sourceを固定して30分以内の独立reviewを行い、採用finding変更だけの再reviewは一回15分以内とする。
構想・architecture・roadmap変更、commit／push／常用配置は対象外。

## 実装・production観測

`core_discovery.ts`がcanonical workspaceごとのdescriptor、起動mutex、instance lock、atomic ready、
起動tokenとAPIのepoch照合を所有する。Coreは独立processのnull stdio・detach・unrefで起動する。
serveと内部bootstrapは同じserviceへ入り、instance lockを終了清算まで保持する。 HTTP
shutdownは202のreceiptを返し、新規受付とSSEを閉じてから進行中HTTPをdrainし、
既存commandの受付処理・credential登録・Worker／子process／historyを清算する。 serve
signalも同じbeginShutdownとcleanupを使う。

隔離保存先は`/tmp/henji-s22-slice7-probe/evidence`。sourceの同時launcherは同じepoch・PIDへ
合流し、片方だけが新規起動となった。最初の実測でroot helperのDeno lock既定がsharedであることを
見落とし、二つの空Coreを作った。task前・provider呼出しゼロでHTTP停止し、lock／tryLockの
exclusive=trueを明示して再確認した。既存userdataへ書いていない。

source TUIはMiMo Flash ResponsesでBash sleepを含む1taskを送った。二つ目のUIが途中実行へattachし、
最初のUIへのSIGINT・二つ目へのHUPと全tmux window終了後もCoreが生存してtaskを完了した。
2物理request、canonical、清算completeとなり、同じepoch・保存Sessionへ再接続できた。
probe側の全window終了後の再接続をnew-windowで行うsetup失敗は、new-sessionへ修正した。
この時taskは既に完了していたため、再試行provider callは行っていない。

Slice 7では通常入口切替前のため、compiled確認は/tmpの検証entryからproduction launcher・
内部bootstrap・serve・remote TUIへ入るstandaloneを使った。既存buildと同じWorker includeと権限で
stagingを埋込み、staging削除後に空白を含むrepository外のpathへ移して実行した。
同時launcherが一つの自分のexecutable由来Coreへ合流した。MiMo Flashの1task／1物理requestで
Bashを起動し、UI Ctrl-D、SIGINT、HUP後も同じCoreが稼働した。後続UIが途中実行へ再接続し、 明示core
stopでBash PIDが終了し、保存履歴を読めた。CoreとUIのprocess group／sessionが異なることも確認した。
検証entryはproductの公開subcommandへ追加していない。通常binaryの最終buildはSlice 8で行う。

source・compiledともstop直後のlauncherで新epochとなり、途中taskを自動再実行しなかった。
sourceの保存Sessionは--continue相当のAPI操作で再開でき、startupはunevaluatedのままだった。
別workspaceの明示serveは別epochとなり、SSE clientが接続中のSIGTERMでもstreamを閉じて終了した。
実provider合計は2task／3物理request。credential／Authorizationやraw provider
responseは記録していない。

145のlauncher focusedとHTTP shutdown focusedは計6件通過し、type・deno.v0
format・lint・diffも通過した。 HTTP focusedはlocalhost Responsesで実WorkerとBash親・子の終了、202
receipt、post-stop受付拒否、 SSE
drainと保存履歴を確認した。もう一件は受付済みsession.openとCore.closeの順序を確認した。 非保存none
Sessionに履歴保存を要求したfixtureをpersistent newへ直した。production修正は不要だった。

追加の実操作で、instanceを保持して接続できない場合にlauncherは二つ目を起動しない一方、statusが
「稼働なし」と誤表示する問題、および既存Coreへserveを再実行するとunknown optionを解釈せず成功する
問題を観測した。前者はread-onlyの既存lock照会でrunning=null／unreachableと説明し、
stopもHTTPで到達できないownerを停止済み扱いしないよう修正した。後者はdeclarationと Session
grammar・Definition selectionをlock／reuseより前で解釈するよう修正した。
実操作で両方の解消と既存Coreの保持を確認し、launcher focusedにも具体的な再現経路を追加した。
source／testをimmutable artifactへ固定して独立reviewを完了した。

## 独立reviewと完了

初回reviewのP2を二件採用した。SSE subscriptionの返却前にshutdownするとcontroller未作成の
終了通知が消失するため、終了をlatchしてcontroller作成時にもEOFへ進めた。
実HTTPのsubscription返却を遅延させたfocusedで再現順序とEOFを確認した。 もう一件は明示URLのcore
stopがlistener停止を清算完了とみなし、Worker／history／instance lockの
解放前に成功した問題である。停止中はlistenerを維持して503を返し、受付済みhandler、Core資源、
matching metadataとinstance lockの順に清算してからlistenerを閉じる。 sourceとrepository外のcompiled
binaryで、環境なしの明示URL clientによるstop直後に 新epochで起動できた。source
clientはnet権限のみで確認した。追加provider呼出しはゼロ。
証拠は同じ保存先のsource-url-stop-fixed.jsonとcompiled-url-stop-fixed.json。

変更した四fileを再固定し、一回の限定再reviewで両findingの解消を確認した。
未解決findingはない。launcher三件とshutdown三件、type、project-configured format・lint、 diff
checkが通過した。通常入口切替と公式binary buildはSlice 8へ引き継ぐ。
commit／push／常用配置・公開は実施していない。
