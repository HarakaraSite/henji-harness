# Increment 154 — S17・S18・S19統合: TUIの文字幅・更新合流・行差分・同期出力

更新日: 2026-09-29

ステータス:
local実装、変更前後の実測、隔離tmuxのsource/compiled実経路確認、コード/testの通常・批判的reviewを完了。
実装reviewの採用P1二件を修正し、両限定re-reviewはBlocking 0／P1 0。
利用者の追加指示に基づきcommit/push・常用配置・配置後確認も完了。配置identityと結果は本書の配置節を参照する。

## 採用範囲と権限

利用者の「S17、S18、S19を対応したい、まず調査」、統合案作成、gpt-6-astraによる通常/批判的review、
続く「案を計画にし、計画作成後reviewerに通常/批判的review」の指示に基づく。
このincrementを三候補の要件・計画の正本とし、通常利用メモから移す。
利用者の追加指示「計画には、実測による確認も含めて」に基づき、変更前後比較とproduction TUIの
実画面確認を下記の手順・記録項目で行う計画とする。
続く「実装してください、実装後コードとテストのレビュー」の指示により、local実装、
計画の非破壊的実測・production TUI確認、実装後reviewは承認済み。
local実装指示時点ではcommit/push、常用配置・公開は含めなかった。
結果報告後の「commit／push・常用配置お願いします」によりcommit/push・常用配置と配置後確認は承認済み。
JSR公開はこの追加指示に含めない。 構想・architecture・roadmapは変更しない。

案の独立reviewはgpt-6-astraの通常/批判的ともBlocking 0、P1 0だった。
これは案のreviewであり、本計画や実装の受入結果へ読み替えない。

## 必要な利用動作と根拠

| 要件      | 必要な動作                                                                                                   | 根拠                                                                |
| --------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------- |
| A: 幅     | emoji・結合文字・CJKを含む本文/表/header/footer/editorの幅とcursorが揃い、clusterを途中でwrap/truncateしない | S18。現binaryで表の列ずれとeditor cursor位置を再現                  |
| B: 更新   | 入力・status・SSE更新を受付後に表示へ反映し、同じ表示更新で本文処理/layoutを重複しない                       | S17。現remote TUIは1文字2layout、snapshot3layout                    |
| C: 再利用 | 入力・busy更新で既存本文を再wrapせず、会話の一件更新で全履歴本文を再変換しない                               | S17。window約960 KBのredraw約86 ms、1万件復元約3.5秒という合成probe |
| D: 出力   | 通常更新は変化行とcursorだけを出力し、一つのframeを同期出力で包む。未出力frameの置換後も正しい画面になる     | S17/S19。現行は全面消去。同期markerの単純追加でwriter合流が外れる   |
| E: 操作   | PageUp/Down、resize、overlay、Session切替・再接続、detach後のCore継続が成立する                              | 現行production経路とIncrement 128/130/140/143/148/153               |

### 調査時の事実

sourceは`c8505c58`。常用binaryはhenji 0.7.0、source `8ccf835b…`。 120×40、約600 Bのassistant
messageを使う共有HTTP client/SSE/実remote TUIのローカルprobeで、
1文字は2layout/2frame要求、同一readの3文字は4layout/4frame要求、snapshotは3layout/3frame要求。
writer出力は各1frameまで合流しているが、その前のlayout/frame生成は合流していない。

renderer直接計測の各3回平均は次のとおり。合成履歴であり、長時間通常利用の遅延再現ではない。

| 履歴             | redraw | renderRestored（redraw込み） | editor＋status |
| ---------------- | -----: | ---------------------------: | -------------: |
| 1,000件×約600 B  | 5.6 ms |                       266 ms |         5.3 ms |
| 10,000件×約600 B | 2.7 ms |                     3,521 ms |        18.7 ms |
| 48件×約20,000 B  |  86 ms |                       583 ms |         170 ms |

frame/layoutのwindowは48entry/1 MiBだが、snapshotからは全messageを再投影する。
`restored_log`はentryを再生成し、`freezeEntry`→`safeTextToBytes`が本文を一文字ずつ再encodeする。
多くのrevisionは0へ戻り、entry IDはmessage index由来。旧案のID＋revision cacheはそのまま使えない。

tmux 3.5aのcursor position reportで家族emoji/肌色emojiは2cell、Henjiは8/4cell。 `👨‍👩‍👧X`の4cell
Markdown wrapは`👨‍`、`👩‍`、`👧X`へ分かれる。
隔離HOME/XDGの常用TUIを模擬Coreへ接続すると、表の罫線がずれ、editorのcursor_xは5に対応する内容で11だった。
現writerへ同じ処理内で10frameを渡すと出力1frame、同期markerで単純に包むと10frameになった。

調査・案・旧reviewのprobe証拠は`/tmp/henji-s17-s18-s19-investigation-20260929/`。
要件と計測要約は本書に保持し、temporary fileの存在を実装要件の前提にしない。
案のSHA-256は`f8635df4c15ffe78522c10e5dd73cf366a0e5b3d38ec8b1fb4507da12084f1ec`。

## 現行product経路と責務

通常henji/明示tui → `tui_cli` → `runRemoteTui` → shared HTTP client → Session SSE →
`reduceSessionStreamFrame` → snapshotのpresentation変換 → `TuiRenderer` → `layoutUi`/Markdown →
`CoalescingWriter` → Deno terminal。

CoreはSession・実行・pending・保存履歴を所有する。TUIはeditor・scroll・overlayと表示状態を所有する。
現行`renderSnapshot`はorientation、全履歴復元、pending
noticeを別々に描画し、callerがstatusも描画する。 busy spinnerも120 msごとに全frameを描画する。
loopの本文/thinking更新間隔100〜500 msは存続しているが、TUI内の重複計算を合流するものではない。
旧Controller/worker_tui_sessionではなく、このHTTP接続TUI経路を変更する。

変更後は次の一経路とする。

```text
入力・SSE・command結果 → 即時にclient/editor/runtime状態へ適用
                      → 最新状態と変更対象を保持し、表示更新を予約
                      → 会話entry投影の再利用 → entry layoutの再利用
                      → viewport/editor/overlay/footerを合成
                      → ScreenFrame（行・cursor・サイズ・表示対象）
                      → writerが未出力frameを合流
                      → 書込み完了済み画面との行差分＋同期出力
```

共通grapheme処理は投影後の表示文字列、layout、cursorの間で共有する。
表示計算と出力の完了状態は別に所有し、writerの比較基準をrendererへ重複して持たない。

## 実装契約

### 1. graphemeと表示座標

`terminal_text.ts`に共有segmenterと分割・幅・前方/後方truncateを置き、必要なら小さなmoduleへ分ける。
segmentは表示文字列、cell幅、元のscalar開始/終了位置を持つ。
`Intl.Segmenter`をgrapheme分割に使い、幅判定は別に行う。 現runtime Deno
2.9.7で、観測済みemojiは単一segmentかつUnicode `RGI_Emoji`のv-mode
propertyで一致することを確認済み。 RGI emoji
clusterは2cell、通常文字は現行CJK幅処理を使い、結合文字・ZWJ・variation
selectorの付加をcellとして数えない。 外部dependencyや新しい端末設定を追加する前提にしない。

`assistant_layout.ts`のprose/code/thinking/table、`layout.ts`の一般行/overlay/editor/footer、
`startup_render.ts`のheaderを同じ処理へ切り替える。幅に収まるかの判定も切り出しもcluster単位とする。
表示escape後の文字を数え、元sourceとの対応を保持する。 span、source
anchor、editor保存位置はscalar座標を保つ。lineのsource位置へlabel・padding・SGRの幅を混ぜない。
editorのcluster内部scalar境界には独立cellがないため、表示cursorはそのclusterの開始cellへ写し、
保存cursorや編集キーのscalar単位は変更しない。通常のcluster終端cursorは直後のcellへ写す。

### 2. 会話投影

`snapshot_presentation.ts`を中心に、Session単位のretained conversation projectionを追加する。 source
scopeはCore epoch＋Session ID。messageはAPI message ID＋turnの組、toolはtoolOccurrenceId、
thinkingはrequestKey
identity＋thinkingKindを使う。順序はsnapshotのmessage順とthinking配置情報に従う。 既存のassistant
note、steering、tool完了表示、thinking配置、omitted noticeの表示意味を保持する。
一つのtool行は現行と同じくcall/resultを対応付け、result到着で同じ行を更新する。
実Coreの保存履歴でAPI message IDが別turnに再出現することを確認したため、
TUIのmessage表示IDとprojection cacheはともにAPI ID＋turnを使う。Core/API/schemaは変更しない。

SSEはすべて既存client reducerへ順番に適用する。その後で変更IDと順序/metadataの変更を表示側へ渡す。
複数更新はID集合と最新snapshotへ合流し、描画予約時に一度だけ投影する。
toolOccurrenceId→参照message/表示entryの対応を保持し、toolの更新・削除は依存するentryも再投影する。
messageのtool参照が変わった場合はその依存関係も更新する。
thinkingの配置変更、message削除やresyncでは順序とsource位置も照合する。

初回snapshotは一度投影する。同じscopeのresyncはidentity・順序・表示内容を照合し、同内容のentryを再利用する。
全ID列の照合と全本文の再変換を区別し、毎回全messageのtextをencode/JSON化しない。
同じIDでも表示内容が変わればlocal revisionを進める。表示内容が同じならentry
object/revisionを保持する。 本文byte長はentry生成時に求め、既存byte制限を同じ結果で効率化する。

`state.ts`に投影済みentryを受け取るactionを設ける。通常更新ではscroll/overlay/editorを保持し、
Session切替は現行のreset/preserve指定に従う。表示projectionを実行状態や受付判断の正本にはしない。
通常remote経路からの全履歴`restored_log`再生成を外す。残るcallerの有無をrgで確認し、
使われなくなるremote専用helperは同じ変更で除く。別の現行callerが使うpresentation eventは維持する。

### 3. entry layoutと操作位置

renderer所有のentry layout cacheを設け、`layoutUi`へ計算済みentry行を供給する。
純粋なlayout関数はterminal I/Oを行わない。 再利用条件はentryの内容revision・label/kind/live
phase、実効本文幅、renderer、表示に関わる設定。 cacheにはentry行とscalar/source/span対応、source
byte長を保存する。
entry間separator、startup行、overlay、viewport、editor/footerはその時点のstateから合成する。

cacheのlayout保管は既存history windowに合わせ、window外のwrap結果は保管対象から外す。
会話sourceや保存履歴は削除しない。PageUpで参照windowが変わった場合にそのentryを計算する。
幅変更はentry wrapを再計算し、高さ/editor/footer/scrollだけの変更は本文wrapを再利用する。
Session全体revisionやspinner更新で全entry cacheを無効化しない。

PageUp/Down・resizeは、直前の表示layoutからentry identityとsource位置を取得して操作する。
未描画の投影がある場合も、このanchorを取得してから最新投影へ対応付ける。
resize後は同じsource位置を含む/直前から始まる行へ合わせ、通常更新でviewをlatestへ勝手に戻さない。
事前layout・描画layoutは同じcacheを使い、同じentry本文を二度wrapしない。
連続Page操作では、初回は直前の表示layout、未表示のPage操作がある間は現在の論理UIのlayoutを参照する。
操作世代とframeが反映した操作世代を分け、古いwrite完了で後続の操作を表示済み扱いにしない。

### 4. 表示予約

`TuiRenderer`の同期`redraw()`呼出しを予約要求へ置き換える。 入力、status、orientation、projection
invalidation、scroll/overlay/resizeの変更を合流する。
schedulerが最新projectionを取り込み、layoutとScreenFrameを一回生成する。 即時のeditor/client
state更新、受付確認、cancel/steering/navigationのHTTP処理はこのtimerを待たない。

初回は次の実行機会へ予約し、以後は最後の描画開始から16 msを初期の合流間隔にする。
一つのtimerだけを保持し、同期処理内の複数setterや入力read全体をまとめる。 16
msは処理時間保証でもprovider更新上限でもない。 now/timerをfocused
testで注入できるようにし、test専用のproduction表示制限を加えない。 busyは既存120
msでspinner/elapsedを更新し、本文投影はdirtyにしない。

Session切替時はsubscription generationと表示scopeを対応させ、旧scopeの予約済み投影を使わない。
rendererはresize通知ごとに画面サイズの世代を進める。同じ寸法へ戻った場合も世代を進め、
resize通知の合流で最終寸法が同じになっても世代更新を残す。
この世代は幅・高さから導出せず、最新のScreenFrameへ引き継ぐ。entry wrapのcache条件には混ぜず、
同じ幅の本文行は再利用しながらwriterへ全面描画の必要性を伝える。
closeで予約timerを取消し、以後frameをenqueueしない。 遅延したlayout/出力のエラーも既存remote
TUIのterminal-failure通知・終了経路へ返し、
同期callerのtry/catchの外で処理が宙に浮かないようにする。

### 5. ScreenFrameとwriter

ScreenFrameはstyle適用済みの行配列、cursorのrow/cell、サイズ、Core epoch＋Session IDと、
resize通知で進める画面サイズの世代を持つ。
frame予算・可視範囲の処理を行配列生成時に終え、writerの比較基準と実出力の行列を一致させる。
行の短縮や省略はcluster/SGRを途中で切らず、最終行列に対するcursorを確定する。

`TerminalPort`へframe受渡しmethodを追加し、DenoTerminalと現行fake実装/callerを一緒に更新する。
`write(bytes)`はterminal lifecycleの制御出力に使い続ける。 writer queue
itemをBytes/ScreenFrameで明示し、prefixによるfull-frame判定を廃止する。
queue末尾の未出力ScreenFrameだけを最新frameへ置換し、Bytesをまたいで合流しない。

writerはdequeue時に書込み完了済みScreenFrameとの差分を生成する。
初回・サイズ変更・Core/Session変更・画面サイズの世代変更は全面描画、
それ以外はstyle込みで変化した行と消えた行を更新する。
CUPで行位置を指定し、ELで以前の長い行/overlayの残りを消す。行間の改行でterminalをscrollさせない。
cursorだけが変わった場合はcursor更新、画面もcursorも同じなら出力を増やさない。

frameの開始/行更新/cursor/終了を一つの同期出力block（`ESC[?2026h`〜`ESC[?2026l`）にする。
書込み完了はその全bytesを渡し終えた時点とし、I/Oが部分writeを返す場合は残りを同じitem内で書く。
完了してから比較基準を進める。raw Bytesが画面を変える場合はその後のframe比較基準を破棄する。
通常frameの直前にrendererが別の差分や同期markerを作る経路は持たない。

Aのwrite中にB/Cが届けば未出力BをCへ置換し、A完了後にA→C差分を作る。
表示対象の切替は最終frameのscopeから、resizeはサイズと画面サイズの世代から判断する。
120×40のAのwrite中に120×20のB、120×40のCが来れば、Bが置換されてもCの世代はAと異なり、Cは全面描画する。
write完了で更新するのはそのframeの比較基準だけとし、後から届いたresize世代を巻き戻したり、
その世代に対する未解消の全面描画要求を完了扱いにしたりしない。
close後は既存restoreがqueueへ制御出力を追加し、flush完了後に終了する順序を保持する。

## 実装手順と変更対象

同じincrement内の五段階とし、各段階で変更箇所のfocused確認を行う。
単独の中間版を常用配置しない。defaultが統合・最終判断を担当する。
実装開始時に変更前sourceを固定し、下記の実測baselineを取得してから段階1へ進む。

| 段階 | 変更対象・作業                                                                         | その段階で確認するproduct動作                               |
| ---- | -------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| 1    | terminal_text、assistant_layout、layout、startup_renderのgrapheme処理                  | A: 本文/表/header/footer/editorの幅・wrap・cursor           |
| 2    | snapshot_presentation、state、remote_sessionの投影再利用、layout/rendererのentry cache | C/E: 更新内容・依存entry・scroll/resize対応、本文再処理削減 |
| 3    | tui_renderer/remote_sessionの表示予約へ切替                                            | B/C/E: 受付即時、一回の計算、Session切替とclose             |
| 4    | ScreenFrame生成、TerminalPort/DenoTerminal/writer、fake実装の切替                      | D/E: 差分・合流・同期block・制御出力と終了順序              |
| 5    | remote統合、source/compiled TUI、再計測、結果記録                                      | A〜E: 実経路で目的の操作を完了                              |

必要ならgrapheme/cache/writerを小moduleへ分ける。公開Core API/保存schemaは対象にしない。
`renderFrame`を使う純粋testはScreenFrameの行/cursorへ更新し、terminal描画testは実出力を確認する。
既存testの「毎回full frame」という方式前提をproduct要件として維持しない。
`scripts/benchmark_streaming_display.ts`の既存callerは現sourceで動くように更新するが、旧loop
probeの仕様は変えない。 今回のremote計測は別のfocused
probeへ整理し、raw詳細はprobe実行先だけへ保存する。

## 検証と受入

### focused確認の対応

| 確認                                                                                        | 要件・実際に変更する経路                             |
| ------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| 観測済み家族/肌色/国旗/heart、結合文字、CJKの幅とcluster保持、表/cursor                     | A。今回の実測と現行のCJK挙動                         |
| 同じreadのeditor/status、同じ予約内のSSE更新で一回のlayout/frame                            | B。現行2/3/4layoutを置換する経路                     |
| busy/editorで本文renderer再実行なし、一件更新で全本文再投影なし                             | C。現行window wrap/全履歴構築の重複                  |
| 同じIDの内容変更、tool参照元更新、snapshot/resyncの照合                                     | C/E。cacheによる実更新の見落としを防ぐ必要がある経路 |
| PageUp/Down、pending更新とresize、overlay終了、Session切替/再接続                           | E。deferred projectionとcacheが触る既存操作          |
| A write中のB/C置換、縮小→元のサイズへの復帰、行短縮・消去、cursor移動、同期blockとBytes順序 | D/E。新writerの通常出力、resize契約と既存restore     |

主な既存確認sourceは`increment_84_assistant_layout_test`、`tui_conversation_presentation_test`、
`tui_retained_terminal_test`、`increment_74_terminal_write_test`、remote TUIの140〜148/153関連test。
追加focused testは154のprojection/scheduler/frame出力へ絞り、同じ動作を重複したmatrixで増やさない。
最終changed-source type check、変更範囲のformat/lint、`git diff --check`を行う。 full
gateは本計画の受入条件へ追加せず、途中で`v0:test`/`v0:gate`を繰り返さない。

### tmuxのproduction経路

実装承認後、`/tmp/henji-i154-verification/`へ隔離XDG/workspaceと検証用Core・保存履歴を用意する。
既存production store APIで小さな保存履歴を作り、sourceと公式build scriptの候補compiled
binaryを確認する。
性能比較用には下記と同じ規模の合成保存履歴も用意し、実CoreからHTTP経由で読んだproduction TUIで
初回表示・入力・履歴閲覧を実測する。renderer直接probeの数値とは分けて記録する。
実configへselectionを書かず、既存Session/稼働中の利用者Coreは操作しない。

- 本文とMarkdown表に観測済みemoji/CJK/結合文字を含め、入力/pasteとcursor位置を確認する。
- PageUp/Down、F1/overlay終了、サイズ変更、Session切替、detach/再接続を操作して内容・位置を照合する。
  resizeは120×40→120×20→120×40も操作し、元サイズへ戻った画面に欠落・overlay残りがないことを確認する。
- 合成local SSEでbusy/spinner、本文/tool/metadataの連続更新を流し、同じproduction
  TUIの画面と出力を照合する。
  模擬Coreでの連続配信確認と、実Coreでの保存Session/操作確認の証拠は分けて記録する。
- writerへ差分を流した後のcapture-paneとcursorを読む。pure
  frameや出力文字列だけで実画面確認を代替しない。
  表の列位置、clusterを分断しないwrap、editor末尾のcursor座標を実画面と照合し、
  調査でずれた`👨‍👩‍👧X`のcursor_x（0-based 11→期待5）も記録する。
- 確認用TUI/Core/tmuxを終了し、操作と観測を本incrementの結果欄へ記録する。

外部provider callの予定は0回。表示/描画の今回の動作はlocal sourceとSSEで確認する。
実providerが必要になった場合は既存の承認境界を確認し、対象・回数・保存先を提示して扱う。 恒常的なraw
frame/SSE log収集は追加しない。

### 変更前後の実測手順

実測は段階5の必須作業とし、focused testの成功だけで完了にはしない。
保存先は`/tmp/henji-i154-verification/measurements/`とし、baseline/candidateを分ける。

1. 実装開始時の変更前sourceと、実装後の候補sourceを固定する。各source/build identity、Deno/tmux版、
   terminalサイズ、履歴の生成条件、操作列、計測開始/終了位置を記録する。
   source同士、同じ公式build手順のcompiled
   binary同士を比較し、旧常用binaryとの差を本改修の効果へ混ぜない。
2. 調査と同じ120×40、1,000/10,000件×約600 B、48件×約20,000 Bを用いる。
   同じ機械・履歴・操作列で変更前後を計測し、初回読込みとcache成立後の操作を分ける。
   調査と比較する処理時間は各3回の個別値と平均・範囲を残す。結果が揺れて比較できない場合だけ原因を調べて再計測する。
3. 下表の操作を、HTTP client/SSEからrenderer/writerまで通るfocused probeと、隔離tmuxのproduction
   TUIで確認する。
   probeは処理内訳と合流回数、実Core/保存SessionのTUIは実I/Oを含む操作結果・時間を確認する。
   合成履歴や模擬SSEによる結果にはその条件を明記する。
4. 計測counter/timestampは検証用probeに置くか検証時だけ有効にし、通常利用に恒常的なraw収集を追加しない。
   処理時間と「入力/SSE受付→対象状態を反映したframeのwriter書込み完了」時間を分ける。
   frameが置換された場合は対象状態を含む最終frameまで測る。書込み完了時刻を端末上の可視化時刻とは扱わず、
   capture-pane/cursorによる実画面照合を別に行う。

| 操作・条件                                     | 記録する実測値・観測                                                                 | 対応する確認                                         |
| ---------------------------------------------- | ------------------------------------------------------------------------------------ | ---------------------------------------------------- |
| 初回読込み・同じscopeの再接続/resync           | 読込み/投影/layout/書込みの時間、投影entry/本文byte量、最終画面                      | C/E。初回の負担と同内容再利用を区別                  |
| 一文字入力、同一readの三文字/paste、status更新 | 入力→書込み完了時間、layout/frame生成回数、本文投影/wrap回数、出力bytes、cursor      | A/B/C。現行2/4layoutとの比較と本文再処理削減         |
| busy/spinner更新                               | layout/frame回数、本文投影/wrap回数、変化行数、出力bytes                             | B/C/D。本文を再処理せずstatus行を更新                |
| 本文一件・tool/metadataの連続SSE更新           | 更新→書込み完了時間、変更/依存entry処理量、生成frameと実出力frame数、bytes、最終内容 | B/C/D。全本文再投影と未出力frame重複の削減           |
| PageUp/Down・幅/高さ変更・縮小→元サイズ復帰    | 操作→書込み完了時間、wrap回数、表示source位置、復帰後の実画面                        | C/D/E。cache再利用、anchor維持、resize描画欠落の解消 |
| 行短縮・overlay終了・cursor移動                | 実出力行/bytes、同期blockの対応、capture-paneとcursor                                | A/D/E。残り文字の消去、行差分と同期出力の成立        |

### 実測結果と完了条件

本incrementへ、操作ごとの変更前/変更後/差分、実行条件、画面観測と証拠pathを記録する。
性能測定用の一時counterを使った場合は、その有効範囲も記録する。
機械依存の固定ms閾値を推測で設けず、本文処理量・重複回数・出力bytesの削減と操作時間を一緒に評価する。

A〜Eがfocused確認とtmuxの操作で成立し、入力/busyが全本文再処理をせず、一件更新で全本文を再投影せず、
通常frameが変化行のみになることを実行証拠とともに示して完了とする。
実測で目的の削減が成立しない、操作遅延が悪化する、表示/操作が壊れる場合は原因を特定し、
対象範囲の修正後に該当操作を再実測して結果を残す。解消できない点は未完了として報告する。
初回処理や変更entryが重いことをcache成功の結果へ隠さず、性能の残る負担を記録する。
Ghosttyでのちらつき、SSH体感、Increment 132 Cの長時間通常利用遅延は現時点で未再現であり、
この改修の完了をその全解消へ読み替えない。通常利用の観測として後から照合する。

## 計画reviewと停止条件

計画作成後、通常/批判的reviewを別のreviewerへ独立して依頼する。
対象は本計画と必要な現source、現在段階は実装未着手。通常は要件/責務/整合性/実現可能性/回帰、
批判的は更新/出力順序・投影依存関係・位置変換を既存通常利用経路から確認する。
Blocking/P1を中心にし、根拠・source-to-impact・test追加以外のproduct correctnessを採用条件とする。
各初回30分上限、10分新しい根拠/結果/中間結論がなければ中断。test/gate/provider/外部書込みを依頼しない。

採用した指摘は計画内で解消し、変更箇所と既存findingだけ一回15分以内でre-reviewする。
Why/What/Whetherの変更、Core/schema/S20/編集キー単位への範囲拡大が必要なら利用者へ戻す。
計画review完了は実装承認として扱わない。

## 対象外

WebUI、Core API/保存schema、Worker/loop/provider cadence、terminal scrollback方式変更、S20、
editorの移動/削除単位変更、一般hardening、互換migration、常用配置・公開。
構想・architecture・roadmapの意味変更は別承認。

## 計画review結果

2026-09-29、独立したreviewer二名が、凍結計画を通常/批判的にread-onlyで確認した。
初回の対象SHA-256は`a68c8348e262ea3ea796de6def585e1f114b37fdf667e34800aad64c76b51dfa`。
旧案reviewの結果や相手の判定は共有していない。各初回30分上限、Blocking/P1限定。

| review | Blocking | P1 | 判断                   |
| ------ | -------: | -: | ---------------------- |
| 通常   |        0 |  0 | 計画として次へ進める   |
| 批判的 |        0 |  1 | resize契約の修正が必要 |

親はP1を採用した。最終frameのサイズだけでは、write中の縮小→元サイズ復帰を検知できず、
欠けた物理画面を同内容として描画省略する経路がある。
表示予約、ScreenFrame、writer比較条件にresize世代を追加し、元サイズへの復帰と旧write完了で
未解消の全面描画要求が消えないよう計画を修正した。対応確認もD/Eのfocused確認へ含めた。
批判的reviewerが、変更箇所とこのfindingの解消だけを一回15分以内でre-reviewした。
再review対象SHA-256は`b4b2a64146171bc3712c93636908bcc0a31db7a5ca5bf91aa6490cc66f7911b8`。
同寸法復帰/通知合流での世代保持、ScreenFrameへの引継ぎ、世代変更時の全面描画、
旧write完了による後続要求の消失防止、縮小→元サイズ復帰のfocused確認を照合し、P1解消と判断した。
残存Blocking 0、P1 0。親も計画上の解消を確認し、計画として次へ進めると判断した。
当該re-review直後の文書変更は、この結果とステータスの記録だけだった。
その後、利用者の追加指示により、既存の実測方針を上記の比較手順・操作別記録項目・完了条件へ具体化した。
この実測手順の追記は親が既存要件A〜Eと照合したもので、上記reviewer判定の対象には含まれない。

通常reviewでは、隔離保存Sessionをproduction
storeの`allocateWorker → commit → readWorker`で作る経路と、 公式build
scriptの`--output`を確認し、検証手順を実行可能と判断した。
両reviewerが受付状態/表示投影の分離、identity/tool/thinking依存、cache/source/cursor、
scroll/resize、writer/lifecycleを確認した。計画review時点では実装後の性能・実画面・production操作は未確認で、
test/gate/build/tmux/provider実行もしていない。実装後の結果は次節を参照する。
review詳細は`/tmp/codex-agent-context/i154-plan-review-20260929/`へ保存した。

## 実装・検証結果（2026-09-29）

A〜Eのlocal実装と受入確認を完了した。通常remote TUIはSSE/client/editorを即時更新し、
一つの表示予約内で最新snapshotを投影、layoutを合成、ScreenFrameを出力する。
本文の再利用と行差分がproduction経路で成立した。外部provider callは0回。
構想・architecture・roadmap、Core/API/保存schema、provider cadenceは変更していない。

### 最終実装

- `terminal_text.ts`の共有grapheme幅・segment・truncateをMarkdown、一般行、header/footer/editorへ適用した。
  source/cursorのscalar座標を保持し、観測済みemojiを2cellとして扱う。
  ASCII本文は同じ結果を返す直接処理で、文字ごとのICU呼出しを避ける。
- `SnapshotConversationProjector`が同scopeのmessage/tool/thinkingを照合してentryを再利用する。
  新規・変更entryだけ本文byte長と表示revisionを更新する。全ID列の照合は残るが、全本文の再encodeは外した。
  remote専用の旧全履歴converterはproductionから除き、残る既存testの比較helperへ移した。
- renderer所有の`EntryLayoutCache`を現history
  windowへ限定し、editor/status/高さ変更で本文wrapを再利用する。
  幅変更と新たに参照するentryは必要なwrapを行う。表示完了layout・Page操作世代・resize世代を区別する。
- schedulerは最初を次の実行機会、以後を最後の描画開始から16 msとして最新状態を合流する。 Session
  resetは予約前に適用し、予約後のoverlayを消さない。表示失敗は既存terminal-failure終了経路へ返す。
- writerはBytesとScreenFrameを区別し、未出力frameを置換する。実書込み完了済みframeとの差分を
  CUP/ELで出力し、cursorと同期markerを同じblockに含める。部分writeを完了してから比較基準を更新する。
  サイズ・scope・resize世代変更は全面描画する。

### 対象sourceと実行条件

比較元は実装開始前のcommit `c8505c58347beb87c7d3b9e840b5c1677e8ac206`を隔離checkoutで固定した。
候補は同commit＋今回のlocal変更。Deno 2.9.7、V8 15.0.245.2-rusty、TypeScript 6.0.3、 tmux
3.5a、x86_64-unknown-linux-gnu、通常サイズ120×40。
双方とも`HOME=/home/agent deno run -A --config deno.v0.json scripts/build_henji.ts --output …`の
公式手順でhenji
0.7.0をbuildし、source同士・compiled同士を比較した。旧常用binaryは比較に混ぜていない。

| identity | baseline                                                           | 最終candidate                                                      |
| -------- | ------------------------------------------------------------------ | ------------------------------------------------------------------ |
| build    | `49fbffd0c7d3707a2413cba4000455800ac8b0016f04d26abd4de10ae974317a` | `f773b0719d194617b5c6bc11667e1d9256f156d9a978fc1cfcb75cd876662c36` |
| runtime  | `c92e6b3485b4f6774f5d7a2e6d49efaf690ec4e91ad54ea1fe689715d40a5d66` | `f264e59a3639e2e13ec34d484fdc34f49539d5c50f68443498198fe24add0c62` |

コード/test/scriptの33ファイルを凍結し、限定re-reviewと最終実測後も一致を確認した。 aggregate
SHA-256は`b2afc4966cae801f424b5b3dae8549638015beb687aa998337f9991a8d1c5189`。 定義はsorted
path＋NUL＋各source bytesの連結に対するhashであり、commit/build hashとは別である。

### focused test・静的確認

| 確認したproduct動作                                                   | 実行結果                                              |
| --------------------------------------------------------------------- | ----------------------------------------------------- |
| A: grapheme・Markdown幅・cursor                                       | 154 grapheme 5件＋既存84の12件が成功                  |
| B/C/E: projection再利用、ID＋turn、連続Page操作、遅延write            | 最終154 projection 4件＋scheduler 7件が成功           |
| D: 差分・同期出力・部分write・置換・resize世代・Bytes順序             | 154 writer 8件＋既存74の4件が成功                     |
| C/E: retained terminal・conversation表示                              | 既存26件＋21件が成功                                  |
| E: remote 140/141/142/143/144/146/153のSession・pending・catalog・CLI | 24件を確認。初回失敗の3件は対象修正後に再確認して成功 |
| converterの移設で触る既存129/139/99/tool preview                      | 27件が成功                                            |

新規154 testは計24件で、件数を受入条件にしていない。
remote初回失敗のうち140/142は描画予約後の初回表示を待つfixtureへ変更した。
143はresume直後に開いた/contextを遅延resetが消す実装問題で、resetを同期適用して修正した。
関連testの修正は実操作の成立を確認するものとして通常reviewへ含めた。
変更範囲33ファイルのformat/lint、必要なtype check、公式compiled build、`git diff --check`が成功。
全suite・`v0:gate`は計画の受入条件ではなく、今回実行していない。

### renderer直接計測

次表はcache成立後、操作と明示flushを含むCPU処理時間の各3回平均、単位ms。
合成assistant履歴のlegacy直接`renderRestored` APIであり、現在のremote projector経路とは区別する。
実端末I/Oを含めない。

| 履歴           |       redraw | renderRestored＋redraw | editor＋status |
| -------------- | -----------: | ---------------------: | -------------: |
| 1,000件×600 B  |  3.157→0.128 |          272.835→4.848 |   15.871→0.167 |
| 10,000件×600 B |  3.442→0.096 |        3441.653→40.489 |   21.031→0.138 |
| 48件×20,000 B  | 81.803→0.116 |          580.321→0.681 |  167.093→0.154 |

初回wrapをこの表のcache成立後の値へ読み替えない。
実装途中、ASCIIをすべてIntl.Segmenterへ渡した候補は48件×20 KBのcold描画に 2,399.6／2,335.2／2,054.7
msを要した。ASCII直接処理へ修正後は244.6／174.9／160.6 msだった。
初回の本文処理は残る。通常remoteの最終候補は次の別probeで確認した。

### HTTP/SSEからwriterまでの比較

同じshared HTTP client・実`runRemoteTui`、local HTTP/SSE、1,000件×約600 Bのassistant履歴、
記録用writerで各3回を比較した。時刻は入力/SSE注入からその状態のframeのwriter完了までで、
dispatch/queueを含み、物理端末の可視化時刻ではない。layout CPU時間は別に保存した。
probeだけで既存methodを計数し、通常利用のraw収集は追加していない。

| 操作               | layout回数 | 投影entry数 | 本文wrap数 | 出力bytes | 注入→writer完了 ms（平均 [最小–最大]） |
| ------------------ | ---------: | ----------: | ---------: | --------: | -------------------------------------- |
| 一文字入力         |        2→1 |         0→0 |       96→0 |   3723→36 | 11.6 [9.3–15.7]→3.2 [3.1–3.3]          |
| 同一read三文字     |        4→1 |         0→0 |      192→0 |   3726→39 | 17.3 [16.0–18.1]→3.9 [3.5–4.0]         |
| 同scope resync     |        3→1 |      1000→0 |      144→0 |    3726→0 | 294.0 [292.6–296.6]→18.5 [17.3–20.6]   |
| 本文一件更新       |        3→1 |      1000→1 |      144→1 | 3675→1809 | 296.8 [280.1–305.2]→8.6 [8.0–9.2]      |
| 同一本文三連続更新 |        9→1 |      3000→1 |      432→1 |  11010→85 | 838.3 [830.8–842.7]→6.6 [6.2–7.0]      |
| tool call          |        3→1 |      1000→2 |      142→1 | 3580→1831 | 287.3 [282.5–292.1]→7.8 [7.1–8.6]      |
| tool result        |        3→1 |      1001→1 |      141→0 |   3580→69 | 281.0 [277.4–285.0]→7.0 [6.3–7.8]      |
| metadata           |        2→1 |         0→0 |       94→0 |   3585→90 | 10.5 [9.5–11.8]→3.9 [3.6–4.3]          |

三連続更新は三つの別messageではなく同じmessageの更新で、candidateは最終内容だけを一度投影した。 tool
callの二entryは更新messageとtool行、resultは同じtool行の更新である。
同内容resyncは一度照合/layoutし、writerの同内容完了通知はあるが実出力0 bytes。
一件更新でviewportの位置が変わる場合は複数行差分になるので、出力行数を一行へ制限していない。

260 msのbusy probeはbaseline 2／2／3回、candidate 2／2／2回のlayout/frame、
本文wrapは94／94／141回から全回0へ減った。出力は7,186／7,186／10,779 bytesから各224 bytes。
周期の位相差をrequest latencyとは扱わない。初回は1000 entryの投影が双方で必要で、
本文wrapは96→48回、layoutは3→1回。全面描画のCUP/EL/同期markerにより初回出力は3743→4104 bytesとなる。

### 操作・resizeの比較

同じHTTP remote経路と記録用writerで各3回。resizeだけはprobeのconsoleSize/resize通知で注入した。
実入力decodeを通るEscは既存の単独Esc判定待ちを含む。

| 操作      | 本文wrap数 | 出力bytes | 注入→writer完了 ms（平均） |
| --------- | ---------: | --------: | -------------------------: |
| cursor左  |       96→0 |   3725→23 |                    9.3→3.6 |
| PageUp    |      144→0 | 3792→2701 |                   15.1→5.2 |
| 幅120→80  |     144→48 | 2557→2918 |                  17.2→15.5 |
| 高さ40→20 |      144→0 | 1291→1472 |                   13.7→3.6 |
| 高さ20→40 |      144→0 | 2557→2918 |                   15.5→3.6 |
| 幅80→120  |     144→48 | 3792→4153 |                  13.6→14.7 |
| F1 help   |       96→0 | 1239→1443 |                   15.4→4.7 |
| Esc終了   |      144→0 | 3792→3996 |                  67.8→54.8 |
| PageDown  |      144→0 | 3725→2608 |                   13.1→3.8 |

幅変更は48entryの再wrapと全面描画が必要である。幅80→120の平均は13.6→14.7 msで、
同期marker/CUP/ELの固定出力負担を伴う。初回・resize・広いoverlay変更では出力bytesが増える場合がある。
高さだけの変更・元サイズ復帰は本文wrap 0のまま、resize世代により画面全体を更新する。
cursorだけの移動は23 bytes（CUP＋同期marker）の出力となる。

### 実Core・保存Session・tmuxの比較と操作

隔離XDG/workspace内でproduction storeの`allocateWorker → commit → readWorker`を使い、 schema
6の合法なuser/assistant対の保存履歴を作成した。turnExecutions/turnModelsは空、
最終assistantにはMarkdown表とemoji/CJK/結合文字を含めた。実CoreからHTTPで読込み、
source/compiled×3履歴×各3回を変更前後で比較した。 次表は外部launch/入力注入から20
ms間隔のcapture観測までで、起動gate・Core・HTTP・PTYを含む。
writer完了時間や物理画面の可視化時刻とは区別する。

| 実行形式・履歴     | 初回表示 ms（平均 [最小–最大]）             | 一文字入力 ms（平均 [最小–最大]）    |
| ------------------ | ------------------------------------------- | ------------------------------------ |
| source・1,000件    | 482.2 [465.9–512.5]→164.6 [163.7–165.3]     | 54.7 [54.5–55.0]→17.8 [9.5–34.0]     |
| source・10,000件   | 4379.5 [3961.7–5187.0]→939.9 [491.4–1833.0] | 57.1 [55.7–58.6]→27.7 [9.6–37.3]     |
| source・48件       | 1542.6 [1445.5–1698.7]→465.9 [378.1–617.4]  | 823.5 [813.2–843.0]→35.5 [34.6–36.8] |
| compiled・1,000件  | 520.7 [465.1–630.1]→211.6 [165.2–304.3]     | 55.0 [54.8–55.3]→27.1 [9.3–36.6]     |
| compiled・10,000件 | 4497.4 [3983.8–5464.0]→998.3 [493.0–2007.3] | 54.9 [54.8–55.0]→26.6 [9.7–35.8]     |
| compiled・48件     | 1543.9 [1452.8–1693.6]→459.0 [377.7–619.3]  | 822.1 [812.2–841.1]→35.8 [35.4–36.2] |

10,000件のcandidate初回はsource 1,833.0→491.4→495.2 ms、compiled 2,007.3→494.6→493.0 msで、
初回のCore/ファイル/cache負担が残る。平均だけで隠していない。
ASCII一文字のPTY出力は1,000件3010、10,000件3015、48件3648 bytesから、いずれも36 bytesへ減った。
家族emoji＋Xのcursorはbaseline全18回の`11,35`からcandidate全18回の`5,35`へ一致した（0-based）。

最終candidateの18回すべてで入力/paste/clear/emoji、PageUp/Down、F1/overlay終了、
120×40→120×20→120×40の復帰、detach後のCore継続を確認した。
追加の実Core操作ではsource/compiled双方でCtrl-T
picker、保存Sessionの/view切替と復帰、detach/再attachが成立し、 Core epochとactive
Sessionは変わらなかった。実Coreのresume HTTP操作はこのtmux確認には含めず、 既存143のresume/context
focused確認とreviewで扱った。 実config/default-selectionには書かず、確認用Core/TUI/tmuxは終了した。

### local連続SSEを受けるproduction TUIの実画面

source/compiled双方のTUIを隔離tmuxでlocal模擬HTTP/SSEへ接続し、capture-paneとPTY出力を確認した。
この証拠は上記の実Core/保存Session確認とは分ける。provider callは0回。

- Markdown表の家族emoji、結合文字、CJKの列位置が揃い、入力`👨‍👩‍👧X`のcursorは`5,35`となった。
- PageUp後の120×40→80×40→120×40で、本文sourceの先頭`line-019`を保持した。
- busyのworking/elapsed/spinnerが更新され、3連続本文更新は最終`final body 2`を表示した。 tool
  callのpending行はresultで完了行となり、metadataのemoji/CJKも表示された。
- 本文を`short`へ短縮後、旧本文やtool noteの残りがなく、完了tool行は現行仕様どおり残った。 revision
  gap後の再subscription/resyncで内容を保持し、F1→Escでoverlayを閉じた。
- 全stageの実出力で同期marker開始/終了が対応した。spinner三frameは計324 bytes・6 CUPで、
  各frameはworking行とcursorだけを更新した。busy中のtool/metadata観測には独立周期のspinner出力も含む。

### コード・test reviewと修正

独立した通常/批判的reviewerへコードとtestの凍結diffを渡し、要件A〜E・実利用経路・
変更によるregressionに限定してBlocking/P1を確認した。各初回30分上限、限定re-review各一回15分上限。
一般hardening・full gate・外部provider実行は依頼していない。

| review | 初回Blocking | 初回P1 | 限定re-review Blocking | 限定re-review P1 |
| ------ | -----------: | -----: | ---------------------: | ---------------: |
| 通常   |            0 |      2 |                      0 |                0 |
| 批判的 |            0 |      1 |                      0 |                0 |

採用した異なるP1は二件。

1. 実Coreの合法な保存履歴ではAPI message IDが別turnに再出現し、API IDだけのTUI projectionで
   1,000件の履歴が2entryへ欠落した。表示IDとcacheキーをともにAPI ID＋turnへ修正した。
   順序・ID一意性・同scope resyncの再利用をfocused testで確認し、同じ実Core履歴を全18回再測定した。
2. 未描画のPageUpが連続すると、表示済み行と更新済みwindowの組合せで途中の履歴を飛ばした。
   両reviewerが独立に再現した。Page操作世代を持ち、未表示操作は現在の論理layoutを使うよう修正した。
   古いwrite完了はそのframeの世代だけを記録する。同read・遅いwriteのPageUp/Downを確認し、
   通常reviewの100entry再現は合流/個別とも`e36`・window `[4,52)`、
   批判的reviewの200entry再現は双方`m112`・window `[104,152)`へ一致した。

親が明示要件・sourceから利用者影響・product correctnessを照合して採用し、
修正後のfocused確認、source manifest照合、最終build・実Core/tmux・SSE計測を完了した。
両reviewerの限定re-reviewは修正行と関連testを確認し、残存Blocking 0／P1 0と判断した。
review中のfull-width行のELに関する仮説はtmux実出力で否定され、findingとして採用していない。

### 記録先と確認の限界

3回の個別値・平均・最小/最大、本文byte処理量、frame生成/実出力回数、cursor、identityは
[実測結果snapshot](increment-154-measurements.json)へ保持した。raw SSE/PTYは常設収集していない。
詳細probe、test/build log、画面capture、検証用binaryは`/tmp/henji-i154-verification/`、 review
diff/manifest/contextは`/tmp/codex-agent-context/i154-code-review-20260929/`に保存した。
最終値の正本となるartifactは以下。中間の修正前計測は最終値へ混ぜていない。

- renderer: `measurements/baseline/probe.json`、`measurements/candidate/final-probe.json`
- HTTP/SSE: `baseline/continuous-1〜3.json`、`candidate/final-continuous-1〜3.json`
- 操作比較: `baseline/navigation-1〜3.json`、`candidate/navigation-1〜3.json`
- 実Core/tmux: `baseline/production/summary.json`、`candidate/production-final/summary.json`
- Session操作: `candidate/navigation-screen/summary.json`、連続SSE実画面:
  `candidate/stream-screen/summary.json`

合成履歴/local SSE/tmuxでA〜Eを確認した結果である。Ghosttyのちらつき、SSH体感、 Increment 132
Cの長時間通常利用遅延は未再現のまま。本incrementの結果をそれらの全解消とは扱わない。
local実装結果の報告時点ではcommit/push・常用配置・公開は未実施だった。
その後の追加指示に基づく配置結果は次節を参照する。

## commit・push・常用配置（2026-09-29）

利用者の追加指示に基づき、レビュー済みコード/test/script 33ファイル、個別incrementの計画/結果/実測、
採用候補の移動とhandoffをcommitし、origin/mainへpushする。既存の未採用S26メモはlocalに保持する。
commitを固定したclean checkoutから公式buildし、受入済み候補とruntime
digestを照合して常用binaryを原子的に置換する。
旧binaryは検証先へ保持し、既存Coreは停止・移行しない。
配置binaryそのものを隔離XDG/workspace/tmuxで確認し、配置結果を後続の文書commitへ記録・pushする。
追加のprovider call、全suite/full gate、JSR公開、構想/architecture/roadmapの変更は含めない。
実装・test・計画/結果・実測snapshot・採用候補移動・handoffの37ファイルを commit
`f429759cb91a7674cbadc0a71a11caca1b84493b`へまとめ、`origin/main`へpushした。
既存S26メモの行・本文だけを作業ツリーへ保持し、今回のcommitには含めていない。
配置記録はこの実装commitに続く文書commitへまとめてpushする。

clean checkoutのレビュー済み33ファイルは凍結manifestと一致し、公式buildで作成したbinaryを
`/home/agent/.local/bin/henji`へ原子的に配置した。henji 0.7.0、sourceは上記commit、dirtyなし。

- build ID: `48021ea3205d7da54033af1106de36a4846b0a3c4a9d49a5f08db390e830a3d5`。
- runtime SHA-256:
  `f264e59a3639e2e13ec34d484fdc34f49539d5c50f68443498198fe24add0c62`。実装受入済みcandidateと一致した。
- binary SHA-256:
  `19276503f7df666b231f08793ce180e62f042e2e4fbc310dd4f833fc9cf138a9`。配置前候補と常用先のhash/version/source/buildが一致した。
- 旧binary: `/tmp/henji-i154-deploy-20260929/henji.previous`へ保持した。
  SHA-256は`b09e0361edbaa28a3dc4fd8a03ece5fb965970f51b609d9c97d8c0df9b159fac`。

配置binaryそのものを隔離XDG/workspace/tmuxで通常起動し、Core/Sessionヘッダ、ASCII draft、
`👨‍👩‍👧X`のcursor `5,35`、F1→Esc、120×40→120×20→120×40の復帰、detach後のCore保持、 Core
IDで同じCore/Sessionへ再接続を確認した。追加の48件×約20 KBの保存Sessionで PageUp/Down、emoji
cursor、overlay終了、detach後のCore継続も確認した。 確認用Core/TUI/tmuxは終了し、provider
request・execution admissionは追加していない。

配置前から稼働していた旧Core二つは停止・移行せず、配置後も同じPID/start
time・epoch・Sessionでidleかつ応答可能だった。
新規起動には新binaryが使われる。既存Coreへの明示再接続URLは以下。

- `/home/agent`: `http://127.0.0.1:41115`（PID32600、epoch `8ed7e3d8…`）。
- repository workspace: `http://127.0.0.1:34001`（PID62516、epoch `e8ad305c…`）。

証拠は`/tmp/henji-i154-deploy-20260929/`の`build.log`、`deployment.json`、`version.txt`、
`preexisting-endpoints.json`、`smoke/summary.json`、隔離Core snapshotとtmux画面へ保存した。
全suite/full gateの再実行、JSR公開、実config/credentialの変更、既存dataの削除は行っていない。

## 採用元の記録

以下は2026-09-26の通常利用メモのS17〜S19を移した旧観測である。
再検討条件は当時の候補条件であり、本計画の実装承認条件へ追加しない。

### S17 — 描画更新の合流と行差分描画（F01）

- 観測（2026-09-26、参照実装調査
  [`pi-opencode-henji-screen-display-comparison.md`](../research/pi-opencode-henji-screen-display-comparison.md)）:
  HenjiのTUIはpresentation
  eventごとに`\x1b[2J\x1b[H`＋全frameを書き直す（`tui_renderer.ts`の`redraw()`）。
  Piは行単位差分（`previousLines`比較）と16 msのrender合流、OpenCodeはcommitted frameとのcell差分と
  fps capで更新量を抑える。Increment 132で本文・thinkingの行追従は成立したが、画面全体の描画方式は
  変更範囲外とした。
- 観測（2026-09-26、現行実装の実測）: frameは可視画面分だけで履歴に比例しないが、1 redrawごとに
  内部window全体（`HISTORY_WINDOW_ENTRIES` 48／`HISTORY_WINDOW_BYTES` 1 MiB）を再wrap・markdown span
  生成し直す。実測はentry約600 Bで2.0〜2.4 ms/回、window上限近く（961 KB）の長大entryで約77 ms/回。
  redraw回数自体は`LIVE_UPDATE_MIN_INTERVAL_MS = 100`／`MAX = 500`で間引き済み（最大約10回/s）。
- 観測（2026-09-26、code fact）: 不要な再描画・layout計算の重複がある。 (a) busy中はspinner
  intervalで120 msごとに無条件`redraw()`（変化はspinner glyphと経過秒のみ）。 (b) 1
  keystrokeは`setEditorSnapshot`＋`setSlashCommandCandidates`（＋`setPendingMetadata`）で2〜3回。
  (c) `tool_call`／`tool_progress`／`tool_result`はeventごとにredraw。 (d)
  `scrollPage`（window境界の`up`）と`resize`は`layoutSnapshot`を2回呼び、`redraw`内でもう1回計算する
  （heavy window実測77 msならPageUp一回で最大3回分）。`CoalescingWriter`は書き込みの合流のみで、
  layout・frame組み立ての重複は残る。
- 候補: (1) redraw要求を短時間で合流して1 frameにまとめる、(2) 前frameと行単位で比較し変化行だけを
  書き換える、(3) entry revision単位でlayout結果を再利用しwindow全体の再wrapを避ける。実terminalでの
  flicker、長大entry時の描画遅延、長時間利用時の入力遅延（Increment 132要件C、未再現）に効く。
- 再検討条件: tmux実測で全面書き直しのflicker・描画量・入力遅延が観測されたとき、または要件Cが
  再現したとき。採用時は計測根拠をincrementへ記録する。
- 関連: [`increment-132.md`](increment-132.md)、`v0/tui/tui_renderer.ts`、
  `v0/tui/terminal.ts`（`CoalescingWriter`）。

### S18 — 文字幅のgrapheme cluster対応（F01）

- 観測（2026-09-26、参照実装調査のcode fact）: 現行`cellWidth`（`v0/tui/terminal_text.ts`）は code
  point単位で、実測で`👨‍👩‍👧`を8 cell、`👋🏽`を4 cellと数える（実terminalの表示は概ね2 cell）。
  折り返し・truncate・列位置がずれる。Piは`Intl.Segmenter`のgrapheme単位幅（regression test付き）、
  OpenCodeは`widthMethod`切替で扱う。
- 候補: grapheme cluster単位の幅計算へ`cellWidth`を置き換える。CJK幅2の現行挙動は維持する。
- 再検討条件: 絵文字を含むassistant本文で列ずれが観測されたとき、または折り返し・表の幅精度を
  上げるincrementに含めるとき。
- 関連: `v0/tui/terminal_text.ts`、`v0/tui/layout.ts`、比較文書。

### S19 — synchronized outputによるframe描画の安定化（F01）

- 観測（2026-09-26、参照実装調査）: Piのfull renderはsynchronized output（`\x1b[?2026h`）でframeを
  包む。Henjiの全面書き直しはframeが途中まで露出する余地がある。
- 候補: `redraw()`のframe出力をsynchronized outputで包む。S17と同一incrementで扱う可能性が高い。
- 再検討条件: S17を採用するとき、または全面書き直しのちらつきが観測されたとき。
- 関連: `v0/tui/tui_renderer.ts`、比較文書。
