# Increment 198 — alternate screenの更新依存と可視範囲加工

状態: local実装・検証完了、commit・常用配置中（2026-10-06）。利用者はalternate
screenの継続採用とA28で確認した改善の実装を指示した。 独立reviewと最終候補の隔離production
TUI確認を完了した。追加指示「コミット・常用配置して」によりsource
commit・公式build・常用配置を行う。 利用者の通常利用確認・完了承認は未実施。実provider
call、構想・architecture・roadmapの反映は今回の指示に含めない。

## 必要な動作と根拠

目的はHenjiの更新経路に対して、操作受付・結果表示に不要な仕事をなくすこと。
メモリの固定値、既存の型や処理の維持を成功条件にしない。

- 全保存会話のPageUp/Down、過去閲覧中の位置とdraft維持、latestへの復帰を使える。
- 幅・高さ変更で本文位置を新しい画面へ解決できる。連続Page操作は出力前でも累積する。
- assistant回答のMarkdown可読性と情報・順序・承認済み配色を維持する。
- thinking/tool/assistant noteはplainで表示し、独自word-aware/Markdown加工を要件にしない。
- editor/footer/menu更新は影響する領域だけを更新し、隠れている本文は描画加工しない。
- Session切替・再接続・送信・予約/steering・cancel・detach/quitの実経路を維持する。

根拠: 利用者の本会話の指示と、[A28処理監査](../research/a28-alternate-screen-viewport-plan.md)。
採用内容はこのincrementを正本とし、A28の未採用候補と区別する。

## 現行経路と採用範囲

Dataのcurrent-value upsert → JSON/SSE → reducerのdirty ID → projectorの表示entry → rendererという
経路を確認した。変更IDが描画へ伝わらず、entry全文layout・候補全行結合・sliceと、同本文の表示属性変更に
よる一括cache失効が起きる。Page/resizeも候補全行配列に依存する。

採用する経路は、sourceを順番に反映 → 本文/表示属性/構造変更を蓄積 → geometry/本文位置を解決 →
必要な範囲を加工 → terminalへ合流・差分出力、である。Core/Dataの幅非依存contractは維持する。
append/replace通知へのwire変更は今回の必須条件にせず、現upsertでも不変prefix・本文結果を再利用する。

本文範囲取得とnavigationを分離する。plainはcell境界の索引から必要な文字列を得る。
Markdownは幅非依存の文脈/blockと幅依存結果を分け、大きなblockでも可視範囲を要求して加工する。
行頭/本文anchorはUTF-16 offsetとgrapheme境界を使い、全文字sourceIndicesを作らない。
labelの表示は本文の幅・解析と分け、label長によって本文全行を狭める構造を廃止する。

alternate screenのPage位置解決とMarkdownを同じ範囲取得経路で扱い、必要範囲の画面行と差分出力を使う。
端末自動折返しのprobeは成立したが、それだけを理由にraw全文/領域再出力へ切り替えない。
画面行出力を残す理由は可視行の局所更新とMarkdownとの合成であり、現行全文行生成APIの維持ではない。

## 実装・検証計画

1. 本文documentの境界/必要範囲の行取得、plain/Markdown分離、不変prefix再利用を実装する。
2. 可視範囲選択とPage/resizeを本文anchor・操作世代へ置換し、48件/byte
   windowと`allLog`依存を撤去する。
3. 変更IDを描画まで伝え、本文・表示属性・構造・geometry・editor/footer/menuの依存を分ける。
4. 旧全文layout/cacheと、そのためだけの走査・中間配列・test helperを撤去する。
5. focused確認で長い単一entry、2000行超のPage、追記・同本文metadata・不可視更新、Markdown
   table/code、 Unicode、resize、連続Page、領域更新、scope切替を実際の動作に対応させて確認する。
   source走査・生成範囲・再利用・出力・入力応答を観測し、固定PSSを合否条件にしない。
6. type check・format・lint・diff check。full gateの反復は行わない。
7. 隔離HOME/XDG・専用tmuxのcompiled production Core/TUIで保存会話・編集・Page・resize・menu・
   Session切替・detachを確認する。実providerは使わず、既存保存会話とlocal probeを使う。

## 担当と承認境界

implementerは本文document/Markdown加工と該当focused確認を担当し、defaultはsource更新・renderer・
navigation/geometryの統合、最終検証・finding採否・報告を担当する。
構想・architecture・roadmapに必要な変更は結果と意味上の変更案を本書へ置き、正本変更の承認を別に得る。
既存実data・稼働Core/TUIを操作しない。

## 実装結果

- `BodyDocument`が幅非依存のsource line/Markdown blockを持ち、wrap境界とUTF-16
  anchorを必要時に測る。
  plainは機械的cell境界のみ。Markdownの文脈・table列幅読取と、最終行文字列/style生成を区別した。
- `ConversationViewport`が本文位置から必要な範囲を選び、最終行はviewport内だけ生成する。
  source位置・geometryのみのPage経路と、最終描画経路を分けた。48件/byte window、`allLog`、
  全候補行の結合/slice、旧assistant/thinking全文renderer・entry全文cacheを撤去した。
- `changedIds`をprojector/local noticeからrendererへ伝達し、合流前の複数通知を失わない。
  同本文metadataでは本文UTF-8の再encodeを省き、labelと本文の幅・加工・styleを分けた。
- 最終行/ANSIは可視範囲の不変結果を再利用する。Page移動後に全既描画行/全幅の最終文字列を残すcacheは
  使わず、document側のgeometry索引は再利用する。editor/footer変更と不可視更新は会話viewを再利用する。
  menuに覆われた本文は最終行を生成しない。
- Pageはlogicalな本文位置へ累積し、latest選択も操作世代を進める。resize後は同じsource点を新幅で解決し、
  古いgeometryの出力receiptを新しい表示位置の基準へ戻さない。startupも要求した幅・高さで生成する。
- assistant/thinkingのlabelは独立行にした。本文全行の幅からlabel長を差し引く配置を廃止し、
  本文へ端末幅を使う。thinking/tool/noteにMarkdownや単語単位折返しを適用しない。

## Reviewと追加修正

read-only reviewerにHenjiの更新特性・操作責務・生成範囲・source/Page/resizeの独立確認を依頼した。
初回20分・新証拠10分なしで中断、再reviewは既存finding解消範囲15分とした。 次のP2
findingを採用した。一般hardeningや仮想provider matrixは対象にしていない。

1. 幅不足時にMarkdownの語全体を1行へ消費し、後続文字をPageできない。fallbackを1
   graphemeの進行へ変更し、 prefixが本文と領域を超えない配置へ修正した。
2. 末尾追記で不変な可視19行も作り直す。source/文脈/行境界に基づくrow identityで不変行を再利用した。
3. 未出力Pageの位置計算だけで中間40行を生成する。geometry/sourceのみで累積し、生成はflush時に行う経路へ変更した。
   またviewportを埋めた後の隣接移動と境界bool判定で、画面外entry全文の最終行geometryを測る経路を廃止する。
4. plainの全block再生成と、open fenceへの追記で不変code行を再分類する処理が残る。 prefix
   block・fence継続文脈を利用し、影響suffixだけを更新する経路へ変更した。

これらは保持量の目標から採用したものではなく、表示または操作のconsumerがない再生成の指摘である。
再reviewでは4件の解消を確認し、新しいBlocker/P1はなかった。対応focused 20件と、
fence・table・list＋Unicodeの逐次追記を新規documentと比較するprobeはpassした。
最終行生成と操作世代の範囲をreview対象とし、総CPU・入力遅延・常駐メモリの最適性までは主張しない。

追加のauthor確認では、本文置換時に旧entryのbyte数を引き継がないよう、同本文の場合だけbyte数を再利用した。
狭い表の縦表示でも、反復する列名prefixの幅と本文に使う幅を共通に計算し、本文のgraphemeに場所を確保した。
列名全文はheaderの本文として表示される。

## 検証結果

最終focused 104件、remote送信・予約/steering・cancel/reconnect・detach・streaming・tool previewの
focused 32件、production modelと保存本文ceilingの既存確認1件はpassした。
変更source/test/診断20ファイルのtype check・format・lint、およびdiff checkはpassした。
旧全文layout/word-aware
thinkingを固定する期待値は、本文保持・操作・承認された表示の確認へ置き換えた。 full
gateは実行していない。

公式compileをsource HEAD `4683adb3`＋local変更で行った。最終候補のbuild IDは
`b384b6c6840222a72c95252dcb1c92fc0d32dacb726b8b1311bdac50c6528191`。 compiled
productionの隔離確認は次を実施した。

- 新規隔離HOME/XDG・専用tmux・local HTTP provider（実provider 0）: Markdown
  table/code/heading/emphasis、thinking/note/tool順序と既定配色、editor/help/provider picker、
  2,300行の保存回答、過去Page/draft/resize/latest復帰、`/new`切替、saved Session再接続、 local
  HTTP400表示、通常entryと明示TUI、detach。 provider応答をthinking追記とMarkdownの多数SSE
  chunkにも分け、累積更新の実経路を確認した。 証拠:
  `.tools/increment-198/local-tmux-result.json`とcapture。
- 実DBの保存済みコピーを新しい隔離stateへSQLite backup（実DB・稼働Core/TUIは変更なし）:
  `2bc2699f`の611 entity復元、Page/Esc、draft、detach/reconnectの会話同一。 connected/standalone
  history出力502,314 bytesのSHA256一致。submitted task 0、実provider 0。 証拠:
  `.tools/increment-198/saved-tmux-result.json`。
- semantic由来の保存2,552更新をcurrent reducer/projector/rendererへ再生（90x30、各通知でflush）:
  orderと表示source本文は保存snapshotと一致した。execution version/outcomeとsemanticOccurrenceIdは
  replay入力とsnapshotに元から差があり、全API snapshot同一のprobeとは扱わない。
  最終候補では行文字列生成6,810行・246,630 UTF-16単位、editor/footer100更新の本文行生成0だった。
  不変行の再利用を追加する前の同increment候補では44,179行・2,478,521 UTF-16単位だった。
  この比較は候補内の処理量であり、配置済み旧binaryとの比較や100MiBの原因解明とは扱わない。
  再生は`scripts/diagnostics/a28_tui_processing.ts`で再実行できる。 証拠:
  `.tools/increment-198/processing-result.json`。

固定PSSを合否条件にせず、必要なsource読取・geometry索引までviewport行数比例とは主張しない。
長い初回論理行の末尾位置や新幅のanchorの解決、Markdown文脈・table列幅の読取は残る。

## 正本変更案と承認境界

architectureの責務・component境界に変更はない（Core/Dataは幅非依存、表示幅/操作はTUI owner）。
本文位置起点の描画経路を記述へ反映する場合は、本incrementの結果を入力に意味上の変更を提示して別承認を得る。
構想・architecture・roadmapへは未反映。198のsource
commit・公式build・常用配置は追加指示で承認済み。push・公開・実provider callは行わない。
