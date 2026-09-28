# Increment 144 — S22 Slice 6: catalog・credential・pathをCoreへ移す

更新日: 2026-09-28

ステータス: local実装・検証・独立review完了。
利用者の追加指示によりcommit・push・常用配置を実施中。結果は[合同配置記録](s22-deployment-2026-09-28.md)を参照する。

## 採用動作と根拠

接続TUIでprovider・model・effortを選び、CoreのSession selectionと次回defaultへ保存する。
専用の非表示入力でcredentialを登録し、presenceを更新する。Coreのworkspaceからパス候補を読み、
既存の引用・曖昧候補・不完全探索の操作を保持する。根拠は全8sliceの実装・独立review・少量の
実provider確認への利用者承認と[詳細設計](../plans/s22-detailed-design-and-slices.md)のSlice 6。

## 現行経路と変更範囲

旧TUIはlocal catalog、credential登録helperとworkspace path indexを構成している。
selectionはHostがSessionへ保存し、旧TUIがdefaultへ書く。remoteではCoreが同じcatalogとHost経路を
使い、public HTTPから読み書きする。credential値は専用register requestだけで渡し、command cache・
履歴・snapshot・diagnosticへ入れない。presenceだけの更新はWorkerを起動しない。 既存path
scannerをCoreが所有し、UIは一時候補のmatchingと挿入を行う。file内容の読込みと
requestへのfile-reference展開は既存Hostの経路を保持する。client cwdはCore workspaceへ影響しない。
新schema、互換read、manual compaction、一般hardening、未採用B6の修正は対象外。

## 分担と確認

backend implementerはCore・HTTP・共有API・credential helperと144 HTTP focusedを担当し、 TUI
implementerはremote picker・専用login・path補完と144 remote focusedを担当する。
共有contractとUIを分離して同時に実装できる具体的な利点があるため委譲する。他担当の変更は戻さない。
Rootは統合、最終検証、production操作、finding採否と結果記録を担当する。

focusedは実HTTPでcatalog、selection保存と次task使用、busy時のselection維持、credential非露出と lazy
presence更新、Core workspace由来の候補を確認する。type・fmt・lint・diff checkを使い、full gateを
途中で繰り返さない。隔離XDG・tmux上でproduction TUIの選択・login・候補挿入を確認し、 MiMo Flash
Responsesの最小taskで選択の実使用を確認する。回数と保存先は実行前に報告する。
安定sourceとtestを固定して独立reviewを30分以内で行い、必要なら変更と採用findingだけの
限定再確認を一回15分以内で行う。構想・architecture・roadmap、commit・push・常用配置は対象外。

## production観測

隔離保存先は`/tmp/henji-s22-slice6-probe/evidence`。production sourceのserveとTUIを別processとし、
TUIはCore workspaceと異なるdirectoryから80×24 tmuxで起動した。 実HTTPでcatalogとcredential
presence、空白入りfileを含むCore workspace pathを読み、
slotなしの読取でSession／Workerをactivateしないことを確認した。

専用login dialogで隔離OpenAI
profileへ試験credentialを登録し、masked表示、presenceのmissing→present、 lazy
startup／実効設定／空会話の保持を確認した。credential値は証拠fileに含まれない。 providerをOpenAI
Responsesへ変更してからOpenRouter Responsesへ戻し、14モデルの末尾選択表示、
検索qwen→文字削除→mimoの候補復元、Qwen modelとeffort highへの変更、MiMo Flash
autoへ戻す操作が成立した。 Coreのdefault-selectionも同じMiMo値を読み戻せた。この間の外部provider
callはゼロ。

空白入りpathは既存引用で挿入できた。曖昧な`./src/al`のdraft保持も成立したが、80桁statusで 「path
match ambiguous (2)」が切れて見えないことを観測し、通知を先に表示する修正を行った。
修正後は80×24実画面で曖昧候補、selectionとcredential savedの通知が見えた。
unique候補`./src/alpha`の引用挿入も再確認した。

選び直したOpenRouter Responses／MiMo Flash autoで次taskを送り、1task／1物理requestで
`S6_SELECTION_COMPLETE`を返し、completed／canonical／清算completeとしてsemantic履歴へ保存した。
`/login`の試験値は証拠にも履歴にも含まれない。TUI Ctrl-Dの後も同じCore／Sessionが生存した。
実config・実DB・常用binaryへ書いていない。

TUIの140〜144 focusedは16件通過し、担当3fileのtype・deno.v0 format・lint・diff checkも通過した。
最後にchoice pickerより前でCtrl-Dをdetachへ配送し、login中のCtrl-Dでcredentialを送らないfocusedと、
production pickerからTUIが終了してCoreが残る確認を行った。143のSession HTTP focusedも通過した。
backendの144実Worker／HTTP focusedも通過した。catalog、presence、lazy登録、
selectionとdefault保存、次taskの実requestへの適用、busy時のselection維持・登録拒否、
保存Sessionと次回defaultの再起動readbackをlocalhost Responsesで確認した。
最初の狭いtest実行権限によるWorker起動前failureと、stream releaseを二重に呼ぶfixtureを修正し、
trusted-local productionと同じ実行環境で成立を確認した。production sourceの修正は不要だった。

## 独立reviewと完了

初回reviewで2件のP2を採用した。別HTTP clientがactive profileを登録した後も、TUIのcached presenceが
live snapshotより優先されてmissing表示が残る問題と、Core全体のcredential登録を保存Session閲覧中に
開けない問題である。active selectionのpresenceはlive snapshotを優先し、loginはconnected・idleと
Coreが示すoperationで判定するよう修正した。selection変更はactive Sessionへの操作を保持した。

144 remote HTTP／SSE focusedは2件通過。隔離production TUIでも他clientの登録をSSEで受け、
missing→present表示へ更新された。実taskで保存済みのSessionを閲覧し、別のidle active Sessionが
存在する状態でlogin pickerが開き、Esc後もviewとactive slotを保持した。追加provider呼出しはゼロ。
証拠は`/tmp/henji-s22-slice6-probe/presence-client-probe/evidence2`と
`/tmp/henji-s22-slice6-probe/evidence/review-fix-summary.json`に保存した。 最初のblank
Sessionを保存済みと誤認したsetupは証拠に採用せず、setup記録へ明示した。

安定source／testのhashを固定した独立reviewと、採用2件だけの一回の限定再reviewを完了し、
両件の解消を確認した。type・deno.v0 format・lint・diff checkも通過した。 Slice
6はlocal完了。構想・architecture・roadmap変更、commit／push／常用配置は行っていない。
