# A28 — alternate screen・可視領域起点のTUI処理案

2026-10-06: 本調査を入力としてalternate screen継続・更新依存と可視範囲加工の改善を採用した。
採用範囲・実装・検証の正本は[Increment 198](../increments/increment-198.md)。以下は採用前の調査・比較である。

2026-10-06。対象source: `4683adb3`。利用者がalternate screenを軸に案を具体化するよう依頼した。
計画の具体化であり、product実装・配置の承認として扱わない。
[通常利用メモA28](../experience/normal-use-inbox.md)から参照する未採用候補の詳細である。
構想・architecture・roadmapは変更していない。

## 必要な動作と選定理由

利用者の目的は、操作を受け付け、処理の結果を表示する責務に対して最適な処理を選ぶこと。
メモリの数値、保持量、状態の個数、既存interfaceの維持を目的にしない。

- 保存Session全体をPageUp/Downで辿り、閲覧中もdraft編集・送信・予約・steering・cancelを操作できる。
- 新しい出力をfollowLatestで見られ、過去を閲覧中の表示位置は更新で勝手に移動しない。
- assistant回答のMarkdownを読みやすく示す。thinking/tool/assistant
  noteについて高度な整形要求はない。
- resizeで閲覧していた本文の位置を保ち、新しい幅で表示できる。
- Session切替・再接続・menu・detach/quitを現在の実経路で使える。

根拠は利用者の明示要件、現行操作経路、実測である。tmux既定2000行へ2500行を出したprobeでは、
先頭600行をterminal履歴から読めなかった。alternate screenはこの上限から閲覧を独立させられる。
Pi/Codexにもmain/alternateの両方式があるが、その採用だけでは総処理の優劣を決めない。
確定済みの過去turn本文を書き換える通常経路は確認できず、その想定を選定理由にしない。

この案は新しいmouse操作、検索、詳細画面、表示情報の削除を追加するものではない。
plain経路への整理では本文・元の改行・意味上の順序・承認済みlabel/配色を表示する。

## 現行は何を何度も処理しているか

保存履歴全体を毎更新再加工する実装ではない。次の三つを区別する。

1. `state.ts`の`historyWindow`は通常48件・1 MiBまでのentry範囲を選ぶ。全Sessionを行化しない。
2. `EntryLayoutCache`はその範囲内のentry全文の表示行を持ち、本文・版・種類・label・live・幅等が
   同じなら再利用する。本文更新、確定label変更、幅変更、cacheから外れたentryの再閲覧では作り直す。
3. `layoutUi`は`logRows`で対象entryの全表示行を結合してから、anchor/latestを解決し、
   最後に画面の高さでsliceする。cache hitでも全候補の巡回・行配列の結合・位置探索は行う。

変更されたthinking/assistantは、画面に数行しか出なくても本文全体をrendererへ渡す。
thinkingでは全文の文字segment、word-aware wrap、文字ごとのsourceIndices等を作る。
editor/footerだけの再描画でも同じ会話layout経路を通り、会話領域を覆うmenu中も先に会話をlayoutする。
再描画は約16 ms単位で合流するため、受信frame全てが一対一で描画されるという説明もしない。

production経路は以下である。

`Dataの意味上のentity → JSON/SSE → api/reducer → SnapshotConversationProjector`
`→ KeyedConversationStore → TuiRenderer → layoutUi/logRows → entry全文layout → slice → terminal frame`

Dataは既に幅非依存。幅・閲覧位置・画面行はTUIで決めている。
`SnapshotConversationProjector`は既に`dirtyEntityIds`から変更entryだけを更新し、`changedIds`を返す。
通常の`renderSnapshot`はその集合をrendererへ渡していないため、描画側は全windowのcache照合で変更を拾う。
この既存の変更情報を描画まで伝える経路が、更新と表示を接続する入口になる。

## Henjiの更新特性から見た処理監査

利用者の追加指示に従い、メモリ量の説明よりも、Henjiの更新経路に対して各加工が必要かを確認した。
現行のcache・位置保持・差分出力に役割があることは、現在の実装が最適である根拠にはしない。
以下はsourceと保存済み更新の確認であり、product sourceは変更していない。

### 更新の実態

Dataはentity ID・version・orderを持つcurrent-valueのupsertを送り、TUI reducerは変更IDを得る。
本文更新もcomplete/toolIds変更も同じupsertで届き、現wireにはappend範囲や本文専用revisionはない。
Coreの他のmetadata更新が届くframeもある。受信・状態反映の順序と画面の更新頻度は分けられる。

既存の保存semanticから生成した2,552更新（`.tools/a28-tui-investigation/frames.jsonl`）を、
同じIDの直前の値と比較した。原実行の送信timingを復元したものではない。

| 本文種類  | 初出 | 既存本文への追記 | 同じ本文 | 本文置換 |
| --------- | ---: | ---------------: | -------: | -------: |
| thinking  |   69 |            2,045 |        3 |        0 |
| assistant |   29 |                0 |       72 |        0 |
| user      |    3 |                0 |        0 |        0 |

同じthinking本文の3更新はcomplete変更、同じassistant本文のうち36更新はtoolIds変更だった。 406
frameではmessage/thinking本文に変更がなかった。ただしtool・notice・footer等まで不変という意味ではない。
この一つの履歴に本文置換やassistant追記がないことを、新しい受信制限や全更新append扱いの根拠にしない。

### 必要な仕事と、現実装が余分に行っている仕事

| 観点                  | 必要な仕事                                                 | 確認した余分な仕事とsource経路                                                                                                                                                                    |
| --------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 変更の表示への接続    | 変更ID・本文/表示属性/順序の変化を、影響する領域へつなぐ   | projectorが返す`changedIds`を`remote_session.ts:renderSnapshot`が捨て、`setKeyedConversationStore`から毎回同じ全window layoutを要求する                                                           |
| 追記中の本文          | 変更部分と、文脈・境界に影響する部分を最新sourceへ合わせる | `EntryLayoutCache.get`のentry revision/text不一致から`layoutLogEntry`へ進み、変わらないprefixも全文parse/wrapする。可視範囲外でもwindow内なら加工する                                             |
| 表示属性の変更        | complete・label/色・回答/note分類を反映する                | body cacheにentry revision・live・labelを一括で入れる。thinkingの同本文`~`→`>`では幅も本文も変わらず、rendererはphaseを使わないのに全文wrapが失効する                                             |
| plainの中間データ     | 必要な本文範囲・cell境界・style/行頭位置                   | `wrapCellsWithSource`が全文segmentとtokenごとのsegment/位置配列を作り、幅計算でも同じ文字を再度分解する。thinkingは各行の`sourceIndices[0]`だけを消費する                                         |
| Markdownの位置とstyle | 必要な構文文脈、本文range、表示するstyle                   | `inlineSpans`/`clipSpans`がscalar配列と文字ごとのsource indexを使い、`layoutLogEntry`でも全文をsplitしscalar行頭を数え、最後に可視行の文字列をstyle化する。各段階の文字座標変換が重複する         |
| Pageとresize          | 本文anchorから必要な前後範囲を選び、新幅で位置を解決する   | `allLog`の生成・結合・線形検索へnavigationを結びつけている。window境界のPageは次windowをlayoutし、連続Pageの未表示状態でも`layoutSnapshot`を再度使う。幅変更はwindow内の全entry cacheを失効させる |
| 入力・時計・menu      | 変化した領域と、領域サイズ変化による会話範囲を更新する     | editor入力/120 ms spinner/opaque menuでも`layoutUi → logRows`を通り、可視会話を再style化してからterminalで差分比較する。出力差分は前段の加工を省かない                                            |

source: `v0/api/reducer.ts`、`v0/tui/snapshot_presentation.ts`、`remote_session.ts`、
`entry_layout_cache.ts`、`assistant_layout.ts`、`terminal_text.ts`、`layout.ts`、`tui_renderer.ts`。

labelの文字数を引いた`bodyWidth`を本文全行に使う一方、label prefixは最初の行だけへ付けている。
この配置は後続行まで本文幅を狭め、assistant→noteのlabel変更を本文全体のreflowへ波及させる。
情報・相関・配色の表示は必要だが、この配置を独自の整形要件として固定する根拠はない。
labelの表示と本文領域の決定を分けて再選定する。note分類への切替そのものは表示加工の意味が変わるため、
単なる配色変更と同じに扱わない。

`mapConversationEntity → freezeUiLogEntry`は表示同値の比較より先に候補本文をUTF-8 encodeし、
変更ありではrevisionを付け直して再度encodeする。本文を変えないmetadata更新でも本文サイズの計算をする。
この処理はcurrent upsertを受ける投影経路の付随仕事であり、表示用byte
window等のconsumerを含めて見直す。 API
entityと表示recordを持つことを、文字列の物理二重copyだと数えたり、store一個化を目的にしたりはしない。

### 改定案へ反映する判断

- body、表示属性、構造、geometryの依存を分ける。表示属性が変わっても本文と有効幅が同じならbody結果を
  再利用できる。note分類・table列幅等、実際に加工方式やgeometryが変わる時だけその範囲を更新する。
- 累積全文upsertを受ける現在のcontractでも、変更IDと直前のsource/加工結果を使って、画面外本文の加工と
  不変prefixの行生成を省く。全文比較が必要ならその走査は残り、追記検出が無料だとはしない。
  発生元でappend/replace/metadata範囲を通知する候補は、この走査を省けるかという別の判断につなぐ。
- geometry・本文範囲選択を先に行い、描画用の加工は必要範囲に限る。Markdownの構文・table列幅のための
  source読取は別の仕事として扱い、そこから未表示の全行生成を導かない。
- Page/resizeは本文位置と操作世代から範囲を解決する。全行配列をnavigationの正本にしない。
  新幅での位置計算は必要だが、旧windowの全entry全文をwrapし直すことは必要条件ではない。
- cache・ANSI付き文字列・style range・行出力・terminal自動折返しは、consumerと更新時の総仕事で選ぶ。
  メモリ値や既存部品の維持を理由に選ばず、plainの独自word-aware処理を要件にしない。

この監査で現行の更新→全文加工→可視sliceへの依存は見直すべきと判断した。
新経路の位置解決、cache粒度、出力方式の総処理はまだ比較しておらず、案の最適性を測定済みとはしない。

## 新しい処理経路と状態の責務

`source更新 → 変更情報を蓄積 → 必要な画面領域と本文範囲を解決 → 必要な表示加工 → 領域出力`

確定するのはこの仕事の順序と必要な操作である。全種類を`DisplayRow[]`へ変換すること、
既存の`ScreenFrame.rows`へ合成すること、plainの折返し文字列をアプリで作ることは必要条件にしない。
幅依存の位置計算と、出力用の文字列をどう作るかを分ける。

| 状態・処理                                       | ownerとconsumer                   | 役割                                                   |
| ------------------------------------------------ | --------------------------------- | ------------------------------------------------------ |
| 保存会話・entity本文・意味順序                   | Data、API clientの受信source      | 会話の正本と現在値。terminal幅を入れない               |
| 表示record・ID/order/隣接索引・local notice      | TUI document、navigation/layout   | 表示対象と順序を解決。本文文字列の参照を使える         |
| 論理行/block索引・解析文脈                       | TUI document、navigation/Markdown | 必要な位置へ到達し、同じ文脈解析を繰り返さない         |
| 本文位置anchor・followLatest・draft/menu/control | TUI interaction                   | 人間の操作位置と状態を保持                             |
| 幅依存checkpoint・行/blockのlayout cache         | TUI layout、navigation            | 位置解決・加工済み範囲を再利用。表現は再利用利益で選ぶ |
| 次の描画結果とterminalへ実表示済みの結果         | renderer/terminal                 | 出力の合流・差分と、人間が見た位置の記録               |

同じ目的の全文cloneや別publicationを追加しない。受信sourceと表示recordを無理に一つの型へまとめることも
目標にしない。例えばtoolの表示previewと保存resultには別consumerがある。
初回snapshotは既存の全entity受信・意味投影を使えるが、全entryのMarkdown解析・幅計算は開始しない。
索引とcacheは再処理を省く利益で保持する。固定の低容量上限を新しい目標にしない。

## 本文範囲の選択と閲覧位置

表示領域と本文位置を先に決め、画面を埋める位置まで必要な範囲を取得する。
`render(entry全文, width) -> 全行配列 -> slice`を範囲取得の前提にしない。
TUI内部のsource位置はJS文字列を直接sliceできるUTF-16 offsetを使い、grapheme境界へ合わせる。
editorのcursor座標まで同時に変更する必要はない。source位置は公開APIへ加えない。

位置表現の候補は以下である。描画データまでこの型から一意に決めない。

```ts
type SourcePoint =
  | { kind: 'text'; offsetUtf16: number }
  | { kind: 'table'; rowStartUtf16: number; column: number; cellOffsetUtf16: number }
  | { kind: 'decoration'; side: 'before' | 'after' };

type SourceAnchor = { entryId: string; point: SourcePoint };
```

- followLatest: 末尾から画面を満たす本文範囲を解決する。全entryの高さは求めない。
- anchored: 表示した先頭の本文位置から、画面の必要な高さまで範囲を選ぶ。
- PageUp/Down: 最初の操作は実表示済みの先頭anchorから会話領域の高さ分だけ前後へ移動する。
  出力前に次のPage操作が来た時は、更新済みの論理anchorから累積する。未表示の本文更新を
  操作の起点にせず、操作による移動と出力完了の世代を区別する。既存の全行layout保持は必要条件ではない。
- resize: 本文anchorを新しい幅の表示位置へ解決する。古い画面行番号を新幅へ転用しない。
- 表ではrow番号・幅依存の折返し行番号だけをanchorにしない。元のrow/cellの本文位置を使う。
- label・separator等の生成行は近接するentryとの関係で扱い、entry全文への文字位置配列を作らない。
- 表示中entryが消える経路は現行にもあるため、近接する残存entryへ位置を合わせる。
  現行のkeyed経路は後続の残存entryを先に探し、なければ前方へ探す。この操作結果と必要な索引を確認する。
- footerの閲覧位置は現在もentry/全entry数であり、全表示行数を計算する必要はない。

末尾から読むことは、行頭からの折返しと異なる境界を勝手に作ることではない。
初めて開く長い論理行では、正しい折返し開始位置を求める前方走査が必要になる場合がある。
その時も位置計算のためだけに全文字objectや全表示文字列を作らず、境界位置やcheckpointを再利用できる。
同じ幅で変わっていないprefixを更新のたびに再走査しない。Page移動時も必要な隣接entryで停止する。
短い確定entryや再閲覧するblockの行cacheに再処理を省く利益がある場合は使える。
禁止するのは要求のたびに未使用全文を加工することや、必要範囲を得るために全候補行を結合することであり、
行配列という表現自体を禁止することではない。

### terminal幅・高さが変わる場合

1. 新しいcolumns/rowsを受け、editorの占有高さと会話/menu/footerの領域を先に求める。
2. 過去閲覧では本文anchorを保ち、新幅でその本文位置を含む表示行/範囲の開始点を解決する。
   旧行番号や旧行頭offsetを新幅の行頭として使わない。followLatestでは末尾から新しい可視範囲を選ぶ。
   出力前のPage移動が残っている場合は、その論理anchorを新geometryへ解決する。
3. 幅非依存のsource・Markdown構文情報は再利用する。旧幅のcheckpoint/行cacheは新幅の計算に流用せず、
   幅とsource版が一致する結果だけ使う。必要範囲の位置解決とMarkdown layoutを新幅で行う。
4. 新しいgeometryで会話・入力・footer等を描き直す。terminal自動折返し案でも、
   terminal内部のresize/reflowだけで正しいsource範囲や閲覧位置が復元されるとはしない。
   出力は直列化し、出力前の旧geometryの描画を新しい結果へ合流する。

resizeで全文履歴や長いentryの全表示行を再生成することは必要条件ではない。
初めて使う幅で長い論理行の境界を求める走査、Markdown tableの列幅/layout変更は残る可能性があり、
その読取と描画範囲を分けて比較する。高さだけの変化では、同じ幅での位置索引を再利用できる。

## plainとMarkdownの加工

thinking/tool/assistant note等は、本文・元の改行・意味上の順序・label/配色をplainで示す。
独自のword-aware折返し、Markdown解析、文字ごとのsourceIndicesを要件にしない。
Page/resizeには画面位置と本文位置の対応が必要だが、それだけで出力用の折返し行文字列生成を必須にしない。

plainの描画は次の二案を比較する。alternate screenの選択は、どちらかの選択を意味しない。

| 手段候補                                   | アプリとterminalの仕事                                                | 比較する負担                                                                  |
| ------------------------------------------ | --------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| 本文範囲を領域へ出し、terminalが自動折返し | アプリは必要なsource境界・cell位置を求め、選んだ範囲とstyleを出力する | 行文字列の生成を省ける一方、領域の消去・置換や再出力bytesが増える可能性がある |
| 必要範囲だけアプリで画面行を作る           | 同じ位置解決から必要な行文字列を作り、変わった行を出力する            | 行生成・比較の仕事を要する一方、局所更新の出力を減らせる可能性がある          |

どちらもcell幅・graphemeの読取は必要範囲と再利用可能な境界を起点に行い、全文segment配列を前提にしない。
表示文字の投影と位置計算を一致させ、欠落・重複なく前後閲覧できるようにする。
terminal案でも長いentry全文を毎回scroll regionへ流して末尾を残す実装は採らない。
会話領域へ出す範囲を先に絞る仕事は残る。横幅全部を使う自動折返しに対し、既存のlabel後の字下げを
そのまま必須条件にしない。情報・意味関係・配色を保つ表示を選び、独自の段組み要求を推測で追加しない。

隔離tmux 3.5a・80x12のprobeでは、alternate screenの会話領域1–8行へ未折返しのASCII/CJK本文を
出し、terminalによる折返しと9行目の固定入力・11行目の固定statusを同時に確認した。
会話領域だけを消去して短い本文へ置換しても入力/statusは残った。証拠は
`.tools/a28-terminal-native-wrap/summary.json`、`wrapped.txt`、`replaced.txt`。
これは領域描画が成立する確認であり、Page/resizeの閲覧位置復元・複雑なUnicodeの位置一致・総処理の優位は未確認である。
続くresize probeでは80列から40列へ変更後、同じ未折返しsourceを新geometryへ明示的に描き直し、
ASCII/CJKが40列で折り返され、固定入力/statusが残ることを確認した。
`.tools/a28-terminal-native-wrap/resize/summary.json`、`before.txt`、`after.txt`を参照する。
この確認は本文先頭からの再描画であり、過去閲覧anchorの復元やPageの正しさを実証するものではない。

assistant回答のMarkdownは、幅非依存の構文情報と幅依存layoutを分離する。
対象は見出し・list・table・quote・inline強調・fenced code等の読みやすさである。
新しいMarkdown機能の追加は今回の目的にせず、parser/libraryの選択は必要範囲の取得、
読みやすさ、再解析の仕事で判断する。現行の独自parser維持を前提にしない。

- 初めて必要となったentryは論理行/block範囲とfence等の文脈を求める。初回にentry全文を読む場合はある。
- 本文更新時、使われる解析結果について最後に解析したsourceとの変更範囲を求める。 full
  upsertではnative文字列比較の走査が残り得ることを認め、表示行生成とは別に測る。
  画面外entryでは解析を遅延し、後で見る時に最新sourceへ追いつく。
- appendと確認できた場合も、末尾の未確定行と文法上影響を受けるblockから更新する。 table
  delimiterやfence等の意味変化を無視して最後の一行だけ更新しない。
- replaceは影響開始位置より前の有効な文脈から再解析する。fence変更でentryの残りを読む必要がある場合も、
  他entryや未表示の画面行まで無条件に再加工しない。
- tableの自然列幅は同じtable全体のcellを参照する必要がある。元cell範囲・自然幅等をcacheして再利用し、
  表示外の全cellの折返し行や着色spanを毎回作らない。表示されるtable行と必要な列幅変更を加工する。
- code/listの長い単一blockも、全blockの表示行配列を返してsliceする実装に戻さない。
- inline styleと元本文の対応は必要区間のrangeで持ち、文字一つずつのmapを保持しない。
- toolIdsが確定してassistant
  noteへ変わる時は表示種類を切り替える。過去の確定本文の改稿とは区別する。

「生成する画面行が可視範囲に対応する」ことと「必要なsource読取も常に可視行数に比例する」ことは別である。
実際に見えるblockの文脈・列幅・正しい折返しに必要な読取は省かず、必要性と再利用を観測する。

## 更新を描画領域へつなぐ

`changedIds`・表示種類変更・構造変更・scope resetをrendererへ渡す。約16 msの描画合流は利用できる。
合流前の複数updateの変更ID/dirty領域は集合として蓄積し、最後のframeの集合で上書きしない。
flush時に処理する変更を取り出し、その後に届いた変更は次回分として保持する。
描画結果のscopeと本文anchorは、そのterminal write完了時に実表示済みの情報として更新する。
この記録で、まだ出力されていない後続のPage操作の論理anchorを上書きしない。

| きっかけ                       | 加工する仕事                                                      |
| ------------------------------ | ----------------------------------------------------------------- |
| 画面外本文の更新               | source反映・解析/cacheのdirty化。描画用の本文加工なし             |
| 画面内本文の更新               | 表示範囲に関係する変更block/行と位置解決。変わらない結果を再利用  |
| latestで新しい内容が追加       | 新しい末尾から画面を解決。過去全entryの高さは求めない             |
| 過去閲覧中の追加               | 本文anchorを保ち、追加件数等の必要な案内を更新                    |
| editor編集・cursor移動         | editor。行数が変わり会話領域の高さが変わる時だけ会話viewを解決    |
| spinner・経過時間・status      | footer/control。会話のparse/wrapは呼ばない                        |
| 会話領域を覆うmenu中の会話更新 | sourceとdirty情報。会話加工は閉じて再表示する時                   |
| PageUp/Down                    | 必要な前後範囲。連続操作を累積し、未加工範囲は必要時に読んでcache |
| resize                         | 新しいgeometryと可視範囲。幅非依存の解析情報を再利用              |
| Session切替・scope reset       | 対象sourceとanchorを切替え、対象の可視画面を生成                  |

editor/menu/footer/conversationのdirtyを分け、入力や時計のたびに一括会話layoutへ戻らない。
出力は選んだ描画方式に合わせて、画面行の差分または領域の描画操作として合流する。
現在の`ScreenFrame.rows`はprewrap済みの行を前提とし、`CoalescingWriter`へraw writeを差し込むと
frame差分のbaselineを失う。terminal自動折返し案で既存APIを無変更で使えるとはしない。
非同期出力の直列化、古い描画の合流、scope/geometryの切替、置換時の古い本文消去、
出力完了に対応する実表示anchorはどちらの方式でも扱う。
画面高のframeには差分出力・操作位置というconsumerがあるため、保持自体を無駄とは判断しない。
この役割を担える領域結果で足りるなら、全種類を行文字列へ変換するために現行frame契約を残す必要はない。

## 置換対象と実装の順序案

1. 実装採用前に、共通の本文範囲選択からplainの二方式を小さな診断経路で比較する。
   保存会話の長い更新entry・Page・resize・入力/footer更新を同じ条件で扱い、
   索引走査・加工/割当・terminal出力量・入力応答と欠落のない表示を確認して選ぶ。 今回のterminal
   mechanics probeだけで選定完了にしない。
2. document/範囲選択/解析と描画の境界を作り、plainとMarkdownが必要範囲で止まることを確認する。
   `conversation_renderer.ts`、`assistant_layout.ts`、`terminal_text.ts`の全文配列interfaceを見直す。
   新しいmoduleは必要な責務で分け、汎用TUI frameworkは作らない。
3. `layoutUi/logRows`をgeometry決定→必要範囲取得の順に置換する。cacheは有効な行/blockや
   checkpointを範囲取得に使い、未使用全文の生成や全候補行の結合を要求しない。 label・turn境界・local
   noticeも隣接sourceから解決する。
4. `state.ts`の48件/1 MiBのlayout対象window、`UiLayout.allLog/logStart/totalLogRows`と
   `scrollPage`の全行依存を廃止し、本文anchor・範囲索引・操作世代でPage/resizeを動かす。
   保存会話の全sourceが保持されることと、全sourceを表示加工することを分ける。
5. `snapshot_presentation.ts`/`remote_session.ts`から変更ID等を渡し、`tui_renderer.ts`の領域dirty・
   合流・実表示結果を接続する。terminalの出力契約も選んだ方式に合わせて見直す。
   独立した操作系を同じ変更で作り直さない。
6. 使用されなくなった全文加工経路・navigation用全行配列と、そのためだけの走査・保存先・ fixture
   helperを撤去する。再利用利益のある行cacheまで一律撤去しない。 旧pathへ戻るproduction
   adapterや二つの履歴描画経路は残さない。

この順序はlocal作業の分割であり、途中の二重実装をproduction完成形にしない。
各段階で同じproduct動作へつながるfocused確認を行い、安定候補で実TUIを確認する。

Core/Data/APIはこの描画変更の必須変更対象ではない。累積全文の送信・JSON
decodeは本案だけでは消えない。
更新元のappend/replace/metadata通知・表示consumer向けの意味viewは、その総処理を省く別の候補として
A28に残す。後で採る場合も幅依存layoutや別の表示DBをDataへ追加するためには使わない。
runtime/native化・entrypoint変更・保存会話形式変更・既存data削除も本案の前提にしない。

## 動作確認と観測

各確認は次の実際の動作へ対応させる。旧interfaceを使うこと自体をtestの合格条件にしない。

| 動作                  | focused確認と実経路確認                                                                       |
| --------------------- | --------------------------------------------------------------------------------------------- |
| 保存Session全体の閲覧 | 2000表示行を超える会話と長い単一entryをPage往復し、先頭・末尾を読める                         |
| 閲覧中の更新と入力    | 過去閲覧中に末尾が更新されても位置とdraftを維持し、latestへ戻ると最新内容が見える             |
| visible/hidden更新    | 同じ長い本文を可視・不可視にして、加工した範囲と表示結果を比較する                            |
| Markdownの読みやすさ  | 見出し/list/table/codeと長いtable/code内のPage、resize、後確定のnote分類を確認する            |
| editor/footer/menu    | 文字入力・複数行化・経過時間・menu開閉で入力応答と領域更新を確認する                          |
| sourceと画面の切替    | Session切替・再接続・pending render中のPage/resizeで対象と位置を確認する                      |
| 同じ本文位置の往復    | forward/backward/latestの表示境界が一致し、文字が落ちたり重複したりしない。連続Pageが累積する |

処理の観測はsource走査量、解析範囲、生成行数、cache再利用、入力から表示までの応答、CPU/割当、
terminal出力、PSSを分ける。初回解析・再閲覧・本文更新・resizeを混ぜた単一数値で判定しない。
全entry全文を加工してからsliceする経路の有無を、長い単一entryでも確かめる。
spinner更新で会話parser/範囲選択を呼ぶ必要がないことを観測する。

既存の保存会話・2552更新のreplay・診断programを使って変更前後を同じ条件で比較できる。 recorded
SSEを流す診断serverはTUIの更新処理確認用であり、実Coreのoperation確認の代替にはしない。
隔離HOME/XDG・コピーDBのcompiled Core/TUIをtmuxで動かし、保存会話・編集・Page・resize・menu・
Session切替・detachを確認する。実provider callは本計画では必須にせず、新しく行う場合は別途承認対象。
検証結果は採用したincrementへ記録する。現時点ではplanだけで、実装test・production確認は未実施。

## 今回の案の限定reviewと改定

利用者の再指摘を受け、既存のTUI構造レビュアーが計画と関係sourceをread-onlyで確認した。
可視範囲起点とdirty領域の分離は妥当とし、次の三点を修正した。

- 位置索引が必要という理由からplainの行文字列生成・既存frame形式の維持を必須にした前提を外した。
- 行cacheの一律撤去を外し、consumerと再利用利益で採否を決めるようにした。
- Pageの起点を常に最後の実表示位置とする記述を修正し、出力前の連続操作を論理anchorへ累積させた。

これは現行コードを全て捨てる判断でも、新しい方式を優位とする判断でもない。
必要な位置管理と、選べる加工・描画・cache表現を分けて総処理で判断する改定である。 product
sourceは変更していない。

## 未確認事項と正本への影響

- plainの二方式の総仕事と、現在の行差分契約を置き換える利益はまだ比較できていない。
  独自のplain折返しをユーザー要件として扱わず、位置計算と本文範囲選択は両案で確認する。
- 長い論理行・大きいtableの初回位置解決の時間と、checkpointの再利用粒度は実装時に測る。
- full upsertのsource比較・decodeの残余costは分離して測る。描画改善から総PSS削減量を推測しない。
- thinking/noteのword-aware/Markdown整形を要求とする旧testは利用者の明示要件と再照合する。
  本文欠落、順序・相関・承認済み配色を確認するtestは残す。
- architectureのSurface記述は、具体的なrenderer/cachingの説明とassistant回答/noteの加工範囲が
  最終案と合うか確認が必要。採用後、変更対象と意味を利用者へ提示して別承認を得る。
  roadmapへの採用・実装状態反映も同じく別承認対象。現在の正本は編集していない。
