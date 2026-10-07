# Increment 147 — none Sessionの継続taskと会話表示

現在の状態: **完了（2026-10-07、利用者判断による一律整理）**。

以下の状態・未実施・承認待ちの記載は当時の記録であり、本incrementの現在の残作業として扱わない。
この完了判断は過去の作業を閉じるもので、当時未実施だった実装・検証・配置等を実施済みに変更するものではない。

更新日: 2026-09-28

ステータス: 実装・検証・独立review・commit・push・常用配置完了。
利用者の追加指示による配置結果は[合同配置記録](s22-deployment-2026-09-28.md)を参照する。

## 採用動作と根拠

利用者はS22全体reviewのP1（既知B6）を修正し、その周辺についてBlocking・P1・P2を含む追加reviewを
指示した。none Sessionで親taskを成功完了した後も、同じruntime Sessionの次taskと受付済みfollow-upを
開始・完了できることが目的である。canonical Sessionを保存しない一方、execution evidenceとruntime
contextを維持する。成功後の継続で以前の会話に残るtool結果・thinkingも引き続き表示する。
根拠は[S22詳細設計](../plans/s22-detailed-design-and-slices.md)のnone runtime継続・成功後follow-up
自動開始と、全体reviewの実行証拠 `/tmp/henji-s22-overall-review-none-probe/result.json`。

## 現行経路・原因・修正範囲

CLIのnone起動／session.open none → CoreService → ApplicationTaskService → Host.admit → SQLite
beginExecution。親成功でHostのmemory authorityがstateRevisionを進める一方、non-canonical
settlementは`detached:<sessionCorrelation>`のheadを更新しない。次task／follow-upは新memory
revisionと 旧detached headの照合でadmissionFailedになる。原因はS22以前から存在する。

noneの継続状態は稼働中のHostが所有するため、非canonical executionの内部headを
`detached:<executionId>`へ分離する。executionごとのbase revisionを保存し、実Session相関は既存の
sessionCorrelationで維持する。persistentのcanonical head・schema・清算結果・保存契約は変更しない。
実データの削除、migration、compatibility、fallbackは追加しない。

追加reviewで確認したP2は同じnone継続経路の表示欠落である。Host transcriptに以前の成功turnが残って
いても、API projectionがnon-canonical
evidenceを最新executionだけに絞り、過去turnのtool参照とthinkingを
落としていた。noneについて現在transcriptの完了prefixに残る成功root executionもvisibleに含め、toolと
thinkingのprojectionに同じ集合を使う。persistentと失敗attemptの既存表示は変更しない。

Rootが局所修正・focused test・統合確認・finding採否・記録を担当する。追加独立reviewは利用者の
明示指示に基づき、修正後のimmutable sourceと周辺経路を渡す。初回三十分、十分間進展なし停止。
採用findingの限定再reviewは一回十五分以内とする。

## 確認計画

実Core／HTTP／Host／Workerとlocalhost Responsesを使い、noneの親task成功、受付済みfollow-up完了、
同Sessionのordinary task継続、会話context・runtime identity・non-canonical evidenceの維持とcanonical
Session無保存を確認する。観測されたtool／thinking表示欠落も同じ三taskで確認する。
既存141・142・139と履歴のfocused確認で、cancel・persistent・reconciliationへの影響を確認する。
type・project format・lint・diff checkを行い、full gateは実行しない。

隔離tmux production TUIでnoneのfollow-up／継続taskを確認する。実providerは既存包括承認の範囲で
対象・見込み量・保存先を提示してから最小確認を行う。表示修正は保存済み実evidenceの現在projectionと
最終compiled
TUIでも確認する。常用binary配置、commit／push／公開、構想・architecture・roadmapの変更は 対象外。

## 全体reviewで確認したP1と修正

修正前probeではnone親taskがcompleted/non_canonical・清算完了となり、受付済みfollow-upが
startRejected/admissionFailed、次ordinary taskもrejected/admissionFailedとなった。localhost
request一件、 外部providerゼロ。既存141はnone cancelと別noneの成功一task、143はnone
open／attach、142の成功follow-upは persistentであり、同none Sessionの成功後継続を通らなかった。

facade beginExecutionとprototype insertExecutionAdmissionの両方でdetached
headをexecutionIdへ分離した。
最初のfocusedではfacadeのみ変更した候補がprototypeのsession照合で拒否され、両境界の同じkeyを揃えた。
canonical branchとSession相関は変更していない。

## 周辺reviewで確認したP2と修正

初回独立reviewは三十四fileの周辺source／test／要件を固定して確認し、旧P1の解消、Blockingゼロ・P1ゼロ・
P2一件を報告した。入力は `/tmp/codex-agent-context/i147-nearby-review`。

実MiMoのcompleted.jsonでは、親Bashのassistant／tool
messageがtranscriptに残る一方、toolOccurrenceIdsが
なくconversation.toolsも空だった。画面でもfollow-up時のthinkingが次ordinary task後に消えた。
visibleExecutionIds → buildToolOccurrences／thinkingForVisibleExecutions →
snapshot_presentationという source-to-impactを確認し、会話表示のP2として採用した。provider
contextとexecution evidenceは保持され、 task自体は成功するためP1とはしなかった。

api_projection.tsのvisible集合に、noneの現在transcriptに保持された成功root turnを追加した。 新147
testには実read toolと三taskのthinkingを加え、親tool結果・tool
messageのoccurrence参照と過去thinkingが 第三task後も残ることを確認した。採用P2の限定再review入力は
`/tmp/codex-agent-context/i147-nearby-rereview`。変更二fileと、初回からbyte一致したP1のhistory二fileを固定した。

## 確認結果

新147
testはnone親のreadと回答をholdしてfollow-upを受付し、親成功後のfollow-up、rename後の第三ordinary
taskを実Core／HTTP／Host／Workerで完了した。同Session／contextを維持し、三executionがcompleted・
non_canonicalとなり、canonical保存一覧は空、execution evidence三件は読めた。親の実tool結果と参照、
三taskのthinkingと回答がsnapshotに残ることも確認した。

P2修正後の147・141・142・139のfocused四件が通過した。P1修正時の94のfacade focused三件も通過した。
既存のnone cancel、persistent follow-up、canonical
commit／reopen、non-canonical清算・context保存・restart
reconciliationを確認した。source／新testのtype・project format・lint・diff checkも通過した。 full
gateは実行していない。

P1修正候補の公式binaryはbuild `19e73bdcca8c4e64040f6801fd0996cdbf84824efdb7319ac810fc87733ea997`、
runtime SHAは `c2f4fa758df4c7cb7ec0590a1238523c61d4230b257d276830ffa02d14aa4bb3`。
repository外の空白を含むpathから隔離tmuxで通常CLI --no-sessionを起動した。実providerはOpenRouter
Responses／xiaomi/mimo-v2.6-flash／auto。親Bash sleep中にAlt-Enter
follow-upを受付し、Ctrl-Dでdetachして `tui`で同じnone
Sessionへ再接続した。親・follow-upが完了した後、renameと第三ordinary taskも同Sessionで
完了した。全三taskがcompleted／non_canonical、清算complete、計四物理request（二・一・一）となった。
UI終了後のCore保持と明示stopを確認し、確認用Core・tmuxは停止済み。

P2修正後の最終公式binaryはbuild `08bedf002e577195f34e1e28101b58976fe942183b6d22009feb61272d3e10b6`、
runtime SHAは `5d5a1ad83ffa4bd5ad6a21e5669b3f9bcf27adbaeac843ee7264881b937dadda`。
保存済み実MiMoのtranscript／execution evidenceを現在のproduction projectionで再投影し、親Bash結果と
三taskのthinkingの保持を確認した。そのsnapshotをcontrolled localhost Core HTTP／SSEから最終binaryへ
供給し、隔離tmuxの実TUIでも親Bash結果と以前のfollow-up thinkingの表示を確認した。
この最終表示確認は保存証拠の再利用であり、新しいlive Worker／provider実行ではない。追加provider
callはゼロ。 確認用Core／tmuxは停止済み。

証拠は `/tmp/henji-i147-probe/evidence`
のproduction-summary.json、completed.json、executions.json、screen、
各executionのreadback／request-factsとexecution-readback-summary.json、fixed-recorded-projection-summary.json、
fixed-recorded-snapshot.json、fixed-display-summary.json、fixed-display.txt。

## Review結果と未確認事項

初回近傍reviewの旧P1と採用P2は解消した。一回の限定再reviewは変更二fileと関連callerを確認し、
今回の差分に未解決Blocking・P1・P2なしと報告した。persistentの対象判定維持と、本文／toolの重複追加が
ないことも確認した。reviewerとrootの最終四file hash確認が一致した。結果は
`/tmp/codex-agent-context/i147-nearby-rereview/review-result.md`。保存証拠のcredential値一致はゼロ。
commit／push／常用配置・公開は未実施。 noneのmodel変更後admissionと、同none
Sessionのcancel後再利用は周辺sourceで確認したが、今回の実provider
probeでは個別に実行していない。既存141のnone
cancelは通過した。これらを独立severityや追加closure項目には しない。一般hardening、未観測provider
variant、permission／状態matrixのreviewは行っていない。
