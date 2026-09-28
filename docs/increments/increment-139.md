# Increment 139 — S22 Slice 1: 共通read modelとコアqueryの分離

更新日: 2026-09-28

ステータス: local実装・検証・独立review完了。
利用者の追加指示によりcommit・push・常用配置を実施中。結果は[合同配置記録](s22-deployment-2026-09-28.md)を参照する。

## 採用範囲と利用動作

人間が現行TUIを起動・保存Session再開し、本文、thinking、tool、selection、pending、checkpointを従来どおり確認できる。
その読取を、コアが生成する共通read modelへ移す。 後続のHTTP TUIと将来WebUIはこのdata-only
contractとreducerを利用する。

根拠は2026-09-27の利用者指示「実装を開始して、各スライスごとに、コードとテストの第三者レビュー」と、
修正・review済みの[詳細設計・8slice計画](../plans/s22-detailed-design-and-slices.md)。
[CLI・外部API設計](../plans/s22-cli-and-external-api.md)と
[設計review・修正結果](../research/s22-detailed-design-review-results.md)を併せて参照する。
実装開始時のsourceはcommit `c4da8f7956d5152f739c868c38f6ca25f1903388`。

8slice全体の実装指示は取得済みで、本incrementはSlice 1だけを管理する。
実装・確認・第三者reviewと指摘対応を各sliceで終えてから次へ進む。 Slice
2以降の範囲は採用時にそれぞれのincrementへ移す。 利用者の追加指定により、現在のSlice
1の実装・確認・第三者review指摘対応完了で一度停止する。 今回はSlice 2に進まない。

## 現行product経路と変更点

通常henjiのtui_cliがWorker Session factory、TuiPresentationAdapter、Controller、rendererを合成する。
factoryはHost／Session／historyとlazy navigationを所有し、coordinatorが実行、履歴保存、canonical
commit、清算を行う。 TUI adapterはcore eventを表示eventへ写し、同期queryをcore facadeへ渡す。
現行tool
IDはliveのturn単位採番と復元会話通算採番が異なるため、その表示用IDを共有identityにはしない。
request単位の最新本文は既存history v7が所有しており、read modelはそこから導出する。

- shared contract／codec、pure reducer、service query／観測portとcore projectionを導入する。
- factory compositionとSession所有はコア側に置き、TUIの表示はread modelから生成する。
- tool occurrenceとrequest textの識別をsnapshot／liveで揃え、確定本文との二重表示を防ぐ。
- editor、viewport、picker、入力履歴はUI-localのまま維持する。
  follow-up予約・自動送信のコア移管はSlice 4で行い、このsliceではUI-owned
  follow-upをcore受付済みpendingと広告しない。
- automatic compactionとcheckpointを維持する。未実装の手動compactionは追加しない。

新しいstorage owner、保存schema、migration、agent
loop、HTTP／serve／自動起動、WebUI本体はこのsliceに追加しない。
構想・architecture・roadmapの意味変更は別途承認対象であり、本incrementの実装指示で変更済みとは扱わない。

## 受入と確認方針

新規・保存Session再開で同じ表示と操作を確認する。
二turnを含むtoolのsnapshot／live照合、request本文の最新値置換、確定本文の二重追加がないことをfocused確認する。
検証は変更したproduct動作に対応するtest、type check、format、lint、diff checkと、隔離XDGのtmux
production TUIで行う。 full gateを途中確認へ使わない。

実provider確認案はOpenRouterのMiMo Flash（`xiaomi/mimo-v2.6-flash`）で二task、各最大3 model step、
物理request計6件程度の見込み。本文・thinking・toolと保存Session再開を確認する。
保存先は`/tmp/henji-s22-slice1-probe`と本increment。
対象・回数・保存先を提示し、2026-09-27に利用者が個別承認した。
実config・実DBを変更せず、隔離したconfigにcredentialを複製して確認する。値は出力・記録しない。
追加指示により、以降の実provider確認も包括承認済み。20前後など多くのstep・turnを伴う場合は事前報告する。

## 第三者reviewの条件

実装agentと独立したread-only reviewerが、安定候補のコードとtestを確認する。 対象はSlice
1の変更、目的はproduct correctness、共通schema／core／UI整合、実経路の回帰と具体的testの妥当性。
初回上限は30分、新しい根拠・tool結果・中間結論が10分なければ停止。
通常のre-reviewは一回・変更箇所と既存finding解消だけを15分以内で確認する。
一般的hardening、仮想的matrix、test件数は評価対象にしない。
採否、最終検証と利用者への報告はcoordinating ownerが担当する。

## 実装・検証・review結果

### 安定候補とfocused確認

共通contract／codec／pure reducer、application serviceとquery／観測port、 core projection、TUI
bindingを導入した。startup・復元・navigation・selection・positionと
live本文／thinking／toolは共通read modelを使う。操作、turn
lifecycle、diagnostic、layoutは既存経路を利用する。 tool IDは既存journal appendのsemantic occurrence
IDを使い、追加flushや保存schema変更は行っていない。
runtimeはcoordinatorの実際の稼働・清算期間から取得し、idleでもactive Session slotを保持する。

新しいfocused testは実Worker、localhost Responses、read
tool、SQLite履歴を通して二executionを確認した。 同じprovider call IDを再利用しても別tool
occurrenceとなり、live rendererと保存Session再開のIDが一致する。
request本文の最新値置換、確定本文の一回表示、codec roundtrip、再開queryが追加provider
requestを発生させないことも成功。 CLI・testのtype
check、担当コードのformat／lint、testのformat／lint、`git diff --check`は成功した。 full
gateは実行していない。

独立reviewへ渡した候補patchのSHA256は
`ce6714f3989c076cf2b1040b355f02e2b9d37b9cc04e1d75baf76251ade927d1`。
対象17ファイルのmanifestとsnapshotは`/tmp/codex-agent-context/s22-slice1-review`に保存した。

### 隔離XDG・production TUI・実provider確認

2026-09-27、tmux専用socket `henji-s22-slice1`でsource production TUIを起動した。
workspace・config・data・state・cacheを`/tmp/henji-s22-slice1-probe`へ隔離。 OpenRouter
Responses／`xiaomi/mimo-v2.6-flash`／effort autoで、sample.txtをread toolで読むtaskを二つ実行した。

- 二taskともcompleted／canonicalで、各2 model step。物理requestは合計4件、HTTP 200が4件。
- 各taskのthinking、read成功、最終本文と識別文字列の一回表示、`ready`への復帰を確認。
- `/exit`後に`--continue`で同じSessionを再開し、二turnの本文・thinking・toolとselectionの復元を確認。
  再開で追加taskやprovider requestは発生していない。
- 保存Session IDは`a3e8ba12-d283-48a5-9aad-0872daf7dcb4`。 execution
  IDは`80b89fd7-3acc-43d5-97ab-f9b3287e4995`と`6de09d9c-f1b7-4ad6-bb79-0145ec8b4f8d`。

観測は`evidence/turn-1-progress.txt`、`turn-1-complete.txt`、`turn-2-complete.txt`、`resumed.txt`。
request単位のfactは`evidence/request-facts.json`、tool semantic履歴のreadbackは
`evidence/tool-semantic-readback.json`、runtime
outcomeは`evidence/execution-summary.json`に保存した。 raw
HTTP／SSEやcredential値・Authorizationは記録していない。 tmux
TUIは確認後に終了した。常用binaryの配置は行っていない。

### 第三者review

独立したread-only
reviewerが固定17ファイルのコードとtest、および関連caller・保存・表示経路をreviewした。
新testが実WorkerとSQLiteを通すことを確認し、既存の複数tool／Responses note／thinking確認を
application service＋binding経路へメモリ上だけで切り替えて、表示順とlive／restore一致を確認した。
source変更・full gate・実provider callはreviewerから行っていない。

P2の2件を採用した。Blocking／P1の報告はなかった。

1. `TuiApiBinding`のsnapshotが実行中はidle、submit完了後はactive／settlingのまま残る。
   明示refreshを呼ぶtestでは隠れていた。実Hostの開始・cancel・清算完了から順序付き観測を送り、
   snapshotへ反映する。testはbusyとsubmit完了の確認でrefreshを呼ばないよう修正。
2. `--no-session`成功後のqueryがMemory handleを保存Session用復元へ渡し、`history_invalid`になる。
   例外を避けるだけではsettled non-canonicalのtoolがprojectionから落ちる。 Memory
   transcriptと成功executionのsemantic対応を使い、query・再描画を成立させる。
   testに観測済みのnone一task成功・refresh・tool保持確認を追加。

finding対応後、変更箇所と既存findingの解消を一回・15分以内のre-reviewで確認する。
reviewerが別途観測したnone第二taskのadmission失敗は、差分由来を確認できておらずfindingから除外した。
今回の修正へ広げず、未採用の通常利用観測として分けて管理する。

### 指摘対応・re-review・最終確認

- Hostが開始・cancel要求・finallyのchild／process cleanup完了後に`runtime_state`を通知し、
  binding／共通reducerが同じSessionのruntimeへ反映するよう修正した。 明示refreshを呼ばない実Worker
  testでrunning／idleを確認し、第三者re-reviewでもF1解消を確認した。
- noneでは保存Session用復元を呼ばず、Memory transcriptとexecution／semantic tool
  occurrenceを対応させた。
  一task成功後のquery／refresh／表示用tool結果が成立し、第三者re-reviewで例外解消を確認した。
- 同re-reviewで、Memory transcriptのuser数からturnを数えると同turn
  steering後のtool参照が落ちる残件を再現した。
  user数の推測をやめ、既存`indexSessionHistoryPrefix`のturn境界を参照する局所修正を加えた。
  「read→steering消費→read→final」の実Worker testで、refresh後も全messageがturn 1となり、 表示用tool
  IDが2件とも残ることを確認した。
- 組み込みreviewerの追加起動がagent thread上限で拒否されたため、同じF2残件・2ファイルだけを
  別CLIのgpt-6-sol／read-only reviewerへ渡した。上限5分、元のre-reviewの15分枠内で終了し、
  既存F2残件の解消を静的確認した。source変更・provider
  call・test再実行・新しい範囲の探索は行っていない。
  結果は`/tmp/codex-agent-context/s22-slice1-rereview/f2-closure/cli-review-result.txt`。
  最後の2ファイル修正patch SHA256は
  `3876009b1fcd5aabd720492d35d3d7b78dc881b08760eb826957cc77b51cf8f5`。

最終focused testは新しい3件がすべて成功。
変更したprovider観測・表示・起動経路の既存regression確認としてIncrement
137／138の関連5件も成功した。 全体`v0:check`は成功し、最後の局所修正も新test経由のtype checkが成功。
最終17ファイルのformat／lintと`git diff --check`は成功。full gateは実行していない。 採用したreview
findingに残件はなく、Blocking／P1の報告はない。

修正後のproduction TUIでは、同じ隔離XDGで`--no-session`を起動し、MiMo Flashのread
taskを一つ追加した。 2 model step／2 HTTP
200、completed／non_canonical。thinking・read・最終本文・readyを確認し、 成功後の`/model`
pickerから同じmodelを選択してselection表示更新とtool本文保持を確認した。
証拠は`evidence/turn-3-complete.txt`と`evidence/none-model-selection.txt`。
本sliceの実provider確認は合計3 task／6 model step／6 HTTP request、すべてHTTP 200。
確認用TUIは終了済み。

最終局所修正の同turn steering経路はlocalhost Responsesを使う実Worker testで確認した。
そのsteeringを含むcaseの実provider・tmux再実行は行っていない。
通常の保存Session／none一taskのproduction確認と、該当修正の実Worker確認を組み合わせて受入とした。
B6（none第二task admission）の原因調査・修正は未採用で、本sliceの成果に含めない。

Slice 1を完了し、利用者の指示どおりここで停止する。Slice 2は未着手。 HTTP serve・接続TUI・独立core
lifetimeは後続sliceの範囲であり、現在はin-processの共通read modelまで。
commit／push／常用binary配置・公開、構想／architecture／roadmapの意味変更は行っていない。
