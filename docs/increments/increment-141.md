# Increment 141 — S22 Slice 3: submit・cancel・途中実行の再接続

更新日: 2026-09-28

ステータス: local実装・検証・独立review完了。
利用者の追加指示によりcommit・push・常用配置を実施中。結果は[合同配置記録](s22-deployment-2026-09-28.md)を参照する。

## 採用動作と根拠

接続TUIからtaskを送信し、実行途中にTUIだけを閉じても、coreが実行・Host-owned
process・保存・清算を続ける。
同じSessionへ再接続すると、途中本文、thinking、tool相関、結果とcommit／清算状態を読む。
別のtaskでは明示cancelを送り、その清算結果を確認する。 第三者HTTP
clientもTUI・terminal・内部descriptorなしで同じ操作を完了できる。

根拠はS22全8sliceのlocal実装と各sliceの独立コード／test
reviewへの既存承認、および利用者の「続けて」。
[詳細設計のSlice 3](../plans/s22-detailed-design-and-slices.md#slice-3--submitcancel途中実行の再接続)、
同文書の操作契約・SSE・lifecycle、[CLI・外部API利用設計](../plans/s22-cli-and-external-api.md)を採用する。
前提は[Increment 140](increment-140.md)の未commit実装であり、これを保持する。

## 現行経路と変更境界

`serve`からcore service、application service、lazy Worker Session、Worker Host facade、
coordinatorの`submit`へ進み、durable admission、Worker実行、canonical／history保存、
子実行・process清算を一つのcompletion Promiseで返している。
Session状態と会話は既存query／SQLiteから共通projectionを作り、HTTPとTUIへ配送する。
接続TUIは現在閲覧だけであり、terminal・editor・購読だけを所有している。

coordinatorのadmissionとcompletionを分離し、既存executionIdを受付結果へ渡す。
`submit`のcompletionとlocal `run`の終了契約は維持する。 core
serviceがcompletionと受付照合を所有し、HTTP abortやTUI detachからcancelしない。
共有APIへtask.submit／execution.cancel／execution.read／command.readを追加する。
SSEは同じsnapshot／semantic履歴・途中本文stateから進捗と結果を配送する。
受付responseは相関とdraft処理に使い、conversationへ二重追加しない。

follow-up／steering、selection／Session command、credential／catalog、auto-launch／core stop、
通常henjiの入口切替は後続slice。新しいloop、保存schema、migration、構想／architecture／roadmapの変更は追加しない。
既存B6の`--no-session`第二task問題は未採用であり、自動的に修正を広げない。
commit／push／常用配置・公開は未承認。

## 実装・確認方針

backendはcoordinatorから共有API／HTTPまで、TUIはdraft・入力・表示・detachを担当する。
統合、計画外判断、review指摘の採否、最終検証はcoordinating ownerが担当する。

focused確認は受付が完了前に返ること、同commandIdの照合、UI detach後の継続／snapshot復元、
明示cancelと清算、draft版の保持、response／eventの非二重適用に対応させる。
既存実Workerと有効なlocalhost provider streamを使い、type check、format、lint、diff checkを行う。
full gateは要求しない。

隔離XDGのtmux上でsource／compiledのproduction経路を確認する。
実provider確認は既存の包括承認内で少量を行い、対象・見込み量・保存先を実行前に報告する。
第三者HTTPからも受付、snapshot／SSE、cancel、execution／command readを確認し、
確認操作と観測を本incrementへ記録する。

独立read-only reviewerへ安定候補のコード／testを固定して渡す。
評価は明示動作、実経路のcorrectness、sourceから利用者への具体的regression。
初回30分上限、10分間新しい根拠・tool結果・中間結論がなければ中断する。
re-reviewは一回、変更箇所と既存finding解消に限り15分以内。
一般hardening、未観測matrix、test件数やtestがないこと自体はfindingにしない。

## 結果

durable admissionから受付execution IDを返し、Coreがcompletionとprocess清算を所有する経路を実装した。
接続TUIは版付きdraft、元command IDによる受付照合、対象executionのcancelとdetachを扱う。
snapshot／SSEから途中本文・thinking・tool・最新結果を再構成し、清算状態を別表示する。

隔離XDG・80×24 tmuxのsourceとcompiled productionで各二taskを実行した。 OpenRouter Responses
xiaomi/mimo-v2.6-flash autoの物理requestは合計六回。 両方でbash実行中にCtrl-Dでdetachし、同じCore
epoch／execution／toolへ再接続してcanonical完了とprocess清算を確認した。
別taskはsourceで第三者HTTP、compiledでEscapeからcancelし、non-canonical／清算完了と再接続後の結果表示を確認した。
compiledでは受付202をproxyで502へ変え、元command.readで照合でき、taskが二重にならないことも確認した。
client cwdはCore workspaceと異なる/tmp。/exit後もCoreは継続した。

独立reviewの二件は、完成済みtool-call
response本文の欠落と、第2request本文が第1toolより先に表示される問題だった。 semantic
model_result本文を保持し、provider requestの実順でcurrent行を並べる修正を行った。
実Workerとlocalhost
providerによるfocused確認は、説明本文付きtool、途中本文、cancel後の保持、None完了本文の一回表示を確認する。
さらに実80×24 source TUIで、送信502／command404時にdraftは残るが案内が見えないことを観測し、
受付未確認・拒否案内を優先表示した。修正後の実画面で案内とdraftを確認した。この追加probeのprovider呼出しはゼロ。
限定re-reviewは修正箇所と既存findingに一回行い、二件解消・新findingなし。

runtime既存focused13件、読取／CLI回帰5件、HTTP focused1件、TUI focused9件が通過した。
安定候補へのv0:check一回と修正後の対象check／lint／fmt／diff checkも通過。full
gateは実行していない。 最終compiled build
`328e32bed26acd88bd1016a5792e5f829454379f6e8fbae667b27bbe644aa9e1`でも、
両probeの保存Sessionをproviderゼロで読み戻し、本文・tool・cancel結果・thinking・detachを確認した。
新Core lifetimeでのprocess清算はunknownとして表示し、過去の完了を現在processの確認と混同しない。

証拠は`/tmp/henji-s22-slice3-probe/evidence`、案内実測は
`/tmp/henji-s22-slice3-notice-470bVm/evidence/source-notice-screen.txt`。
immutable最終差分・hashは`/tmp/codex-agent-context/s22-slice3/review/final-manifest.json`。
自分の確認Core・proxy・tmuxは停止済み。credential／Authorizationは記録していない。
常用binaryへの配置、commit／push、公開は行っていない。B6は未採用のままであり、今回の修正に含めていない。
