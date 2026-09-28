# Increment 143 — S22 Slice 5: Session操作とactivation設定

更新日: 2026-09-28

ステータス: 実装・検証・独立review・commit・push・常用配置完了。
利用者の追加指示による配置結果は[合同配置記録](s22-deployment-2026-09-28.md)を参照する。

## 採用動作と根拠

接続TUIでSessionのnew、保存済みresume、rename、recallを使い、checkpointと実際のcontext観測を読む。
busyのSessionから表示を離れても実行を継続する。noneにはruntime IDで再接続する。
根拠は利用者の全8sliceのlocal実装・独立reviewへの承認、就寝中も順次進める指示と
[詳細設計](../plans/s22-detailed-design-and-slices.md)のSlice 5・CLI option scope。
手動compaction、新schema、restart replay、B6の未採用修正は含めない。

## 現行経路と変更

remote TUIはHTTP snapshot／SSEで表示するが、現在は明示Sessionへのattachとtask操作だけである。
Coreのsession.openはlazyなApplicationServiceを作り、idleの旧Hostをcloseする。
保存Sessionのreadは既存SQLite historyを参照し、Hostをactivateしない。
旧navigationのcreateNew／switchToはWorker起動を含むため、そのままremoteへ移さず、Coreのlazy
openを使う。 UIの表示SessionとCoreの実行slotを分け、pickerからの閲覧と明示resumeを別操作にする。

openのactivationはDefinition selector、root maxSteps、provider
timeout、new／noneの初期providerを持つ。
保存activeModelはroot-providerより優先する。/newはCoreが表示元selectionと現slotのactivationを読む。
既存slotへのattachは設定を変えず、異なる明示optionは差と実効値を表示して明示newへ案内する。
openも共有command結果へ統一し、応答喪失後に同じcommandIdを読む。旧形式への互換readは追加しない。

effectiveConfigは稼働runtimeのみの値とし、managed lazyで未評価のDefinition既定を数値で捏造しない。
実Worker Ready後は実manifestのmaxStepsを読む。recallは既存Hostの準備・clear・次taskでの消費を使い、
pending状態は同じHostから読む。contextは既存checkpointとhistoryの物理request
ordinal／step／item数を写す。 raw requestの新規常設収集や推定token数を追加しない。

## 分担と検証

RootはCore操作・HTTP・統合と最終検証を担当する。backend担当へ共有DTO／client／codec／projection、
factoryとHostの実効値queryを、TUI担当へremote navigation／pickerとCLI activationを任せる。
責務を分けて同じ共有contractに沿う実装を並行できるために委譲する。他担当の変更は戻さない。

focused testは既存Workerでのlazy resume、保存selection優先、new引継ぎ、rename、recallの一回消費、
busy中の保存閲覧とcheckpoint再開適用へ対応させる。remote testは実HTTP操作と表示先の切替を確認する。
変更箇所のtype／fmt／lint／diff checkを使い、途中のfull gateは実施しない。 隔離XDGのtmux
productionで同じ操作を確認する。実providerは既存MiMo flash Responsesで最小task数とし、
具体的な対象・回数・保存先を実行前に報告する。recallの準備と保存queryはproviderを呼ばない。
安定候補のsource／testとhashを固定し独立reviewを30分以内で行い、必要なら変更・既存findingだけを一回15分で再確認する。

## 結果

### VM復帰後の実装と確認

VM復帰時はTUIの再接続型とSession操作の入力結線が未完了だった。
再接続generationと購読iteratorの所有を一本化し、slash、Ctrl-G／Ctrl-T、pickerのEnter閲覧／R再開、
context overlayを入力へ結線した。実操作で`/rename`が通常taskへ送られることを観測し、修正後は
renameがproviderを呼ばず成立した。idleの稼働slotのeffectiveConfigも表示する。

独立backend reviewのP2を採用した。従来のSSEは購読時のslotに固定され、別clientのresumeによる
保存閲覧→稼働、旧稼働→保存閲覧の変化を通知しなかった。Session単位の購読とderived projection
cacheへ統一し、既存reducerで処理できる順序付きupdateを配送する。保存閲覧のruntime操作も
稼働slotの変化へ追従する。snapshot／updateはSession／historyの正本ではない。

TUI最終reviewのP2三件も採用し、修正した。保存閲覧中の同じSessionへのpicker Rをexact openへ
配送し、実際のDefinition refのresourceId／sha256 digestからCLI指定との照合と表示を行う。 managed
Definitionをpositionのrole `default`と混同しない。`/resume latest`はCoreが最新保存対象を
exactへ解決し、既に同じ稼働slotなら再openせずattachする。旧動作のfailed結果を実APIで再現し、
修正後は同じ最新Sessionの繰り返しresumeと実効設定の保持を確認した。

143 HTTP focusedは実Workerとlocalhost Responsesでactivation、保存selection優先、new引継ぎ、
rename、recall一回消費、checkpoint再開適用、none再接続を確認した。同じ購読で保存Sessionのresume、
実task、別slotへの切替とeffectiveConfigの除去を確認した。139〜142の既存HTTP／read計6件も通過し、
SSE修正後の140〜142の3件も通過した。core／HTTP／共有APIのtype／format／lint／diff checkは成功。 full
gateは行っていない。

TUI／CLIの140〜143 focused 16件は通過した。追加caseはslash／context中のbusy維持、Ctrl-Gの
保存閲覧、同じ保存表示からのR resume、managed実refによる同revision attachとbuiltin差分案内を
確認する。TUI／CLI担当4fileのtype／format／lintとdiff checkも成功した。
独立reviewの固定source／test、manifestと限定再確認候補は
`/tmp/codex-agent-context/s22-slice5-review/`へ保存した。

### 隔離XDG・production TUI

保存先は`/tmp/henji-s22-slice5-resume-probe/evidence`。80×24の専用tmux上でproduction sourceの
serveと接続TUIを別processとし、TUIはcoreと異なる`/tmp`から起動した。
config／data／state／workspaceは隔離し、実config／実DBへ書いていない。

- rename、busy中の保存Session閲覧、元Sessionへ戻って明示cancelを確認した。表示変更でbash実行を
  closeせず、cancel後はnon-canonical／清算completeとなった。
- recall準備はproviderを呼ばず、次task完了後にpendingRecallが消費された。contextは実requestの
  ordinal／step／item数を表示した。newは表示元selectionとmaxSteps 4／timeout 30000msを引き継ぎ、
  保存resumeは同じSession／本文を復元した。Ctrl-Gのpickerも表示した。
- 別HTTP clientのslot置換で旧表示からsubmit操作が消え、同Sessionのresumeで操作が復帰した。
  idleの稼働設定を実画面で読み、noneのruntime IDへ再接続した。Ctrl-D後もcoreは生存した。
- 既存checkpoint保存経路で隔離DBへ試験checkpointを準備し、再起動後のTUIでcovered／retained turnと
  summaryを読み戻した。これは自動compactionの新規実行ではない。次taskへのcheckpoint適用は
  上記の実Worker／localhost Responses確認で成立した。
- 保存Bを先に閲覧した後、Ctrl-T pickerの同じBへRを送り、稼働slotへのresumeを確認した。
  `/resume latest`を繰り返して同じ稼働Sessionの設定を維持した。
- 既存module install経路で試験managed
  Definitionを隔離dataへinstallし、`serve --new
  --definition-revision`で起動した。activation
  metadataのselectorがない状態でも同じrevisionへの 接続TUI
  attachが成立し、contextに実resource／digestと未評価maxStepsを表示した。
  同coreへの`--agent default`はterminal取得前に実Definitionとの差と`--new`案内を返した。

外部providerはOpenRouter ResponsesのMiMo Flash auto。操作結線の未完了観測1task／1request、
修正後のcancel対象とrecall後taskの2task／2request、合計3task／3物理request。
以降のSSE／idle設定／none／checkpoint確認は外部providerゼロ。
credential値とAuthorizationは記録していない。前回の`/tmp`証拠はVM復帰後に存在しなかったため、
今回の確認を新しい保存先へ記録した。

独立reviewの限定再確認で採用P2四件すべての解消を確認し、変更範囲内の追加correctness指摘はなかった。
Slice 5をlocal完了とし、Slice 6へ進む。

構想・architecture・roadmap、commit／push／常用配置・公開は変更していない。
