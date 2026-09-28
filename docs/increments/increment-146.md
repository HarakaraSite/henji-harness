# Increment 146 — S22 Slice 8: 通常入口切替・配布・旧経路整理

更新日: 2026-09-28

ステータス: 実装・検証・独立review・commit・push・常用配置完了。
利用者の追加指示による配置結果は[合同配置記録](s22-deployment-2026-09-28.md)を参照する。

## 採用動作と根拠

引数なしhenjiとhenji tuiを同じHTTP TUI経路にする。明示connectは指定Coreへ接続し、 localではSlice
7のlauncherがCoreを発見・起動する。TUIがSession／Worker／保存先を所有する
旧compositionを廃止し、headless run用factoryと既存run・history出力を維持する。
根拠は承認済み[詳細設計](../plans/s22-detailed-design-and-slices.md)のSlice 8と
[CLI・外部API設計](../plans/s22-cli-and-external-api.md)。構想・architecture・roadmap変更、
commit／push／常用配置・公開、WebUI本体、B6、migration・実データ削除は対象外。

## 現行経路と実装範囲

現行通常CLIは旧tui_cliからApplicationService、TuiApiBinding、adapter、Controllerを構築し、
UI終了時にCoreを閉じる。明示connectのみremote_sessionへ入る。共通Session grammarを純粋parserへ
分離し、通常入口もremote_sessionとHTTPへ統合する。remote_sessionのsnapshot mapperも純粋moduleへ
移し、Host projectionをimportする旧bindingを廃止する。通常editorの受付済み入力履歴をHTTP receiptへ
対応させる。旧navigation／adapter／Controllerはconsumerを追い、不要production経路とそれだけを
検査するtestを除去する。純粋renderer、editor、layout、tool previewとHost／Worker testは維持する。

## 分担と検証

RootはCLI・純粋invocation parser・旧composition撤去と該当test、統合・公式binary build・production
確認・finding採否・記録を担当する。UI implementerはremote editor入力履歴と純粋snapshot helper、
旧binding撤去と対応testを担当する。backend implementerは旧Controller／adapter／factory navigationと
対応testの整理を担当する。旧経路の責務を分離してHTTP UIとheadless factoryを同時に確認できる具体的な
利点があるため委譲する。他担当の変更は戻さない。

focusedは通常CLI grammar／routing、HTTP receiptに応じた入力履歴、既存run JSON／streamとhistory、
変更箇所のtype・project fmt・lint・diff
checkを使う。隔離XDGのtmuxでsourceと公式standaloneの通常起動、
同一Coreへの再接続、task／pending／Session／picker／path／private loginを確認する。 最小の実MiMo
Flash確認は対象・予定量・保存先を実行前に提示する。full gateは計画しない。 安定sourceをimmutable
artifactへ固定し、独立review初回30分以内、採用findingの限定再review一回15分以内。

## 入口とsource productionの結果

引数なしとtuiを共通HTTP clientへ切り替え、明示URLだけを使う経路とlocal launcherを分けた。 Session
grammarを純粋moduleへ移し、helpとWebUI未実装の説明を追加した。引数解析とTTY確認後に local
startupへ進む。旧CLIのApplicationService・TuiApiBinding・adapter・Controller・close所有は撤去した。
Increment 33の旧direct TUI起動testは、headless WorkerのDefinition評価failureを残し、HTTP TUIのlazy
activation動作は139／143のCore／HTTP確認へ移した。

sourceの隔離tmuxで引数なし、明示tui、別workspaceの明示URL clientが同一epoch・Sessionへ接続した。
二つのUIをCtrl-Dで閉じてもCoreが残り、環境なし・net権限だけのURL clientへ再接続できた。 Core
workspaceのpathをTabで引用付き挿入し、UI側workspaceでは探索しなかった。
provider呼出しはゼロ。証拠は`/tmp/henji-s22-slice8-probe/evidence/source-entry-summary.json`とscreen。
probe最初のpath入力は既存grammarにない@を付けたため、正しい./prefixへ直した。

CLI focused三件と143 activation、run output／stream／connected history十五件、root担当の旧parser・
standalone・managed Definition関連四十二件が通過した。後者はJSR SDKのtype依存がcached-onlyで
不足したため、testは既存task同様no-checkで実行し、別の通常type checkで確認した。 この時点でfull
gateは実行していない。入力履歴・旧経路整理と公式standaloneの結果は後段へ記録する。

## 公式standaloneのproduction確認

公式build scriptで候補を作り、staging削除後に空白を含むrepository外の
`/tmp/henji-s22-slice8-probe/outside checkout/henji`へ移した。
最初の候補buildは`7f99f8d238f110c3912ae92a4bac9ee6d279c0c2e0ab374ceeafca981de3b8be`。
通常の引数なし起動から同じexecutable由来の独立Coreへ接続できた。
provider・model・effortのpicker、Core pathとslash Tab、masked /loginを実操作で確認した。 private
dialogの試験値は隔離openai profileにだけ登録し、画面・Session snapshot・履歴へ含まれないことを
確認した。実OpenRouter credentialと実configは変更していない。

MiMo Flashの親taskがBash sleepを実行中にEnter steeringとAlt-Enter follow-upを受付した。
Ctrl-DでUIを閉じても両taskはCoreに残り、明示tuiで途中へ再接続して完了した。
同じSessionでrename、新規Session、picker閲覧、元保存Sessionへのviewと明示resumeを確認した。
viewは別のactive slotを置き換えず、resumeで明示的に戻る。local／connected canonical
historyは一致した。
入力履歴は既存どおりidle時の操作なので、再接続UIで最小の一taskを追加してUpによる受付済みpromptの
復元とDownによる未送信draftの復元を確認した。busy中の矢印はcaret移動であり、履歴確認の
証拠へ採用しない。これはprobe側の想定修正であり、productを変更していない。

probeではnotice文字列をready固定で待つ誤りと、rename前から同じtitleであるのにreceipt確認とみなして
次commandを早く送るsetupを修正した。renameの再確認・Session操作にはproviderを呼んでいない。
headlessは非TTYへ--taskを渡す既存grammarが拒否したため、正しいstdin入力へ修正して確認した。
この拒否もWorker／provider開始前であり、新しいproduct修正へ拡張しない。

headless JSON／streamもstdin経由で完了した。実provider合計は5task／6物理requestで、すべて
completedとなった。TUIの三executionはcanonical、headlessは非保存Sessionとして完了した。
TUIは親二request、follow-up一request、入力履歴確認一request、 headlessは各一request。短いrequest
factのreadbackも保存した。
証拠は同じ保存先のcompiled-product-summary.json、all-real-execution-summary.json、
各executionのrequest-facts.json、historyとscreen、run JSON／streamのstdout／stderr。
credential値の照合は保存した証拠全体で一致ゼロだった。確認用Coreとtmux sessionは停止済み。
未使用の旧UI pending owner撤去を候補へ反映し、そのbinaryでもproviderなしの再開確認を行った。

旧pending ownerとobsolete test task参照を整理した候補buildは
`dd787af4a013914535aa18e001db27e643bc36bd74481d41457739bbd130b590`、runtime SHAは
`7677e9ceb32e6c74e0cf12dc8f57c823512ff562d25e3b99c3675432cf7c8d88`。 同じrepository外pathへ移し、tui
--continueで以前の保存Sessionへ新epochで接続した。
startupはunevaluated、既存executionは五件のままで、taskの自動再実行と新provider callはゼロ。
Ctrl-D後のCore保持と明示stopも確認した。証拠はfinal-binary-summary.jsonとsnapshot／screen。
最終lintの二変数const化まで反映したreview前の公式buildは
`7f92397d898c4f0c8ec51cbe6eb219fe3c6334cc19720a5c8940e87c34ebf6e2`、runtime SHAは
`8646ca9f1f04cc63bb84837351a50ba7951fa41cb490f493b524cadd352a5d8b`。
repository外の同じpathへ移し、保存Sessionへの再接続・unevaluated startup・既存execution五件維持・
Ctrl-D後のCore保持・stop完了を再確認した。追加provider callはゼロ。
この候補の再接続も成功し、finding対応後の最終候補でも同じ保存先を使って再確認した。
機能の実provider確認は最初の候補で行い、以後の差分は未使用owner撤去、CLI errorの文言とtest
task参照・ format・constの整理であり、HTTP
TUI・Worker実行動作は変更していない。常用binaryは配置していない。

## 旧経路整理とfocused確認

旧Controller四module、adapter五module、API bindingとunused PendingInputCoreを撤去した。 factory
navigationを除去し、HostActiveSessionとCore／rendererが必要なSession・pending DTOは維持した。
headless factoryとrestoreRecordMessages、Host query／semantic projectionは維持した。
Controller／adapterだけを検査する35・66・135 dialog・overlay・142 bindingのtestを廃止し、 obsolete
task参照を削除した。残すmixed testは純粋snapshot helper／fixtureへ移した。
Session・pending・picker・private loginの人間の動作は140〜144のCore／HTTP／remoteと今回のproduction
確認へ対応付けた。139は実Core／HTTPで二executionの同provider call_idを区別し、persisted reopenでも
意味上のtool occurrenceが保存されることを確認するtestへ移した。

backendの変更に対応したfocused134件（foundation・headless・provider・recall・Definition・history・
Worker process・credential registration・Responses note・renderer／editor／layout／tool
preview）が通過した。 担当source／test十八moduleのtype・lint、project format・diffも通過した。
旧Controller／adapter／binding／navigationのsource・test参照はゼロとなった。 最終lintでunused
importと再代入されない二変数のconst化を整理した。後者は挙動変更を含まない。
そのsource／testを三十三fileのimmutable artifactへ固定し、独立reviewへ渡した。
初回artifactは`/tmp/codex-agent-context/s22-slice8-review`。初回reviewは三十分以内で完了した。

## 独立review

初回reviewは三十三fileのhashを照合し、CLI routing・preflight・help、入力履歴、snapshot分離、
旧consumer／testの対応、task設定、headless factoryの維持を確認した。P2一件を採用した。
過去ログをPageUpで閲覧中、通常taskが受付成功しても最新へ戻らず、新しい出力が画面外へ残る。
これは[Increment 3](increment-3.md)のadmitted task時のlatest recovery要件に対する、通常入口切替の
退行である。拒否・未確認・steering・follow-upではanchorを保持し、通常taskの受付成功時だけlatestへ
戻す修正を行った。追加findingはなかった。

修正前の公式binary・production CLI／TUIでも、隔離tmuxと制御したlocalhost HTTP Coreを使って再現した。
PageUp後と受付receipt前・拒否後はanchorを保持し、受付成功後も新しい出力が見えなかった。
証拠は同じ保存先のviewport-anchored-summary.jsonとscreen。外部provider呼出しはゼロ。

有効なaccepted receiptを検証した後、ordinary taskでanchor中の場合だけrenderer.latestへ戻す。 focused
testは長い保存会話をPageUpし、保留したHTTP receipt前はanchorを保ち、受付成功後にlatestへ
戻ることを確認する。既存の入力履歴・draft復元も維持した。変更した二fileのtype・format・lintと
focused test、diff checkは通過した。

修正後の最終公式buildは `ce76ff27aa35022817386cab00da6b9c982cdf1d2c00a420814dd6a1cabc7816`、runtime
SHAは `0585235802615129a63fa048da888231b65fb69c603c0967f0d6eb3cf0b473f9`。
空白を含むrepository外pathへ移し、同じproduction CLI／TUI操作で、receipt前・拒否後のanchor保持と
受付成功後の新しい出力表示を確認した。viewport-latest-summary.jsonとscreenが証拠である。
これはUIのreceipt timingを制御するlocalhost HTTP Coreであり、実provider probeとは区別する。
最終binaryの保存Session継続・unevaluated startup・既存execution五件維持・UI detach後のCore保持・
明示stop完了も再確認した。final-binary-summary.jsonとsnapshot／screenはこの最終候補の証拠である。
finding確認と再接続による追加外部provider callはゼロ。

変更した二fileを`/tmp/codex-agent-context/s22-slice8-rereview`へ再固定し、ほかの三十一fileが初回の
hashと一致することを確認した。一回十五分以内の限定再reviewでP2の解消を確認した。
processing・拒否・未確認の早期returnとsteering／follow-upではanchorを変えず、通常taskの有効な
accepted receipt後だけlatestへ戻る。変更範囲内で新しいBlocker／P1はなかった。

Slice 8はlocal完了。採用findingの未解決はない。最終source／testは固定artifactと一致し、
focused確認・公式binary・隔離tmux操作・独立reviewを完了した。full gateは実行していない。
確認用Coreとtmux sessionは停止済み。構想・architecture・roadmap変更、commit／push／常用配置・
公開は行っていない。
