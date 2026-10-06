# A28 — 通常利用時のメモリ・処理調査の記録

状態: 完了（2026-10-06、利用者指示「A28も完了でいい」）。
本書は通常利用メモから移設した観測・比較・検討の履歴であり、新しい実装計画ではない。
完了判断の正本は[Increment 199](increment-199.md)。TUIの採用結果は
[Increment 198](increment-198.md)、前段の改善は194・195・196を参照する。

## 完了前の通常利用メモ（当時の記載）

以下はA28の原記録を保存したもの。「現行」「未採用」「本候補に残す」等は各観測・検討時点の記載である。
移設時に新しい調査・計測は行っていない。native内訳等の未確認事項を確認済みとはせず、
追加調査を完了の必須作業として残さない。再検討が必要になった場合は改めて採否を決める。

- 利用者判断（2026-10-05）:
  DBは十分小さいが、メモリにはチューニングの余地がありそうなので候補として記録する。
- 実測（同日13:25 JST、Session `2bc2699f`、idle）:
  対象Sessionを開いているCoreとTUIの`/proc/<pid>/smaps_rollup`を読み、共有pageを按分するPSSで Core
  179.3 MiB、TUI 89.8 MiB、合計269.1 MiBだった。RSS合計は325.6 MiB。
  CoreはAgent・Data等のWorkerを含むprocessで、Session単独のメモリ使用量ではない。
  この一時点の値からleakや削減可能量は断定していない。
- DBとの比較（同時点、SQLite read-only集計）: workspace共有DBは15 Sessionを含み、本体57.4 MiB、WAL
  4.3 MiB、SHM込み合計61.7 MiB。 `2bc2699f`は4 turn・182 message・1,258
  semantic記録で、関連データ量は約5.3 MiB。
  Session分は関連rowの文字列/BLOBと参照先contentsの重複を除いた本文bytesの合計。共有設定・本文を含み、
  index・row/page
  overheadは含まないため、Session専用の物理占有量ではない。checkpointは未保存だった。
- 候補・未確認:
  起動時の固定費、CoreとTUIそれぞれが保持する会話・表示data、履歴量に伴う増分を実測し、
  機能と通常操作を維持したまま削減できる箇所を選ぶ。全体の内訳・削減可能量は未確定。
  A3のcontext管理とは関連し得るが、providerへ送るcontext量とprocessの常駐メモリ量を同一視しない。
- 追加実測（同日、同じCore/TUI・Session）: 15:31の実行中はPSSでCore 284.9 MiB、TUI 325.3
  MiB、合計610.2 MiB。 15:42のidleではCore 309.3 MiB、TUI 284.1 MiB、合計593.4 MiBだった。
  turnの停止後も大部分が残るが、PSS/RSSだけで生存heapとallocatorの保持pageは区別できない。
- 現行sourceと会話dataの確認:
  CoreのConversationWriterとTUIのSessionClientStateは、現在の会話entityを全件保持する。
  TUIは表示用Mapも持ち、画面外のtool引数・結果もsnapshotに含む。
  一方、EntryLayoutCacheの折返し結果は現在のhistory windowだけを保持し、範囲外を削除する。
  `2bc2699f`の会話snapshotは611 entity、JSON換算で約1.9 MiBであり、 このサイズだけではTUIの約284
  MiBを説明しきれない。
- TUI待機loopの再現済み保持問題は[Increment 194](../increments/increment-194.md)へ採用し、
  観測と修正要件を移設した。
- Coreの保存会話復元で累積本文を一括保持する問題は
  [Increment 195](../increments/increment-195.md)へ採用し、調査証拠と修正要件を移設した。
  本候補にはCore全体等の残る調査・チューニングを残す。
- 保存Sessionの最新request・request件数取得で不要な履歴本文を展開する問題は
  [Increment 196](../increments/increment-196.md)へ採用し、追加調査の根拠・比較と修正要件を移設した。
- 残る観測・候補: 196の同条件の隔離compiled確認で、100回参照後も約384 MiBのCore process
  PSSが残った。 native memory全体の所有・未使用領域の分解や、長時間のAgent実行の内訳は未確認。
- 類似問題reviewのcontext読取・終了後artifact更新・recall/診断読取の候補は
  [Increment 199](../increments/increment-199.md)の計画対象へ移設した。 Data
  Worker全体の処理調査と合わせて採用・実装・検証し、利用者による完了承認を得た。結果は199を参照する。
- 保持内訳の確認と限界（196採用前、195のsourceを使った調査）:
  実DBコピーを100回参照後に各isolateでGCすると、生存heapUsedはCore 5.6、Data 9.4、API 4.5 MiBで、
  GC後もprocess PSSは約704 MiBで、glibcの未使用malloc領域を約201 MiB確認した。
  probe内だけでmalloc_trimするとPSSは約520 MiBへ下がり、解放済みallocator領域の残存を実証した。
  ただしnative memory全体の所有・未使用領域を完全には分解していない。
  Worker終了後にもprocess側へ残る領域があり、ここから永続保持のleakとは断定しない。
  このnative内訳のprobeはDeno source環境でのみ行った。compiled binaryのnative内訳解析は未実施。
  常用環境への削減量保証として扱わない。GCとmalloc_trimは内訳を調べるprobe操作だけである。
- native内訳の調査証拠はgit管理外の`.tools/a28-core-followup/`に置いた。
  `findings.json`、各isolateの記録、`baseline-natural-http-result.json`、
  `baseline-natural-closure-result.json`を参照する。追加候補は個別採用前に実装しない。
- TUI更新時の割当調査（2026-10-05、Session `e4e0c7ce`、未採用）: 利用者がTUIの約155
  MiBの消費に疑問を示したため、稼働中と同じsource `da251e56`のbinaryを
  隔離HOME／XDGとコピーDBで確認した。実provider callは0回で、稼働processのGC・再起動は行っていない。
  production TUIのPSSは空Sessionで48.2 MiB、同じ保存会話を開いた直後で78.7 MiBだった。
  会話snapshotは260 entity／627,699 bytes、表示用本文は169,055 bytesである。
  保存semanticをproduction normalizerでAPI deltaへ変換した2,552更新／12,743,789 bytesを 10
  ms間隔で再生すると、別のproduction TUIのPSSは68.5から184.6 MiBへ増えた。
  再生ではCore役がPythonで、上記起動比較とは共有file page等の条件が異なるため、各run内で比較する。
  同じ再生の診断binaryでは、累積JS割当が約4.5 GiBに対し、GC後の生存JS heapは約10.5 MiB、
  確保済みphysical heapは約77.8 MiBだった。累積割当は常駐量ではない。
  割当追跡とsourceから、更新のたびに累積thinking全文を文字分解し、折返し・source index配列を
  作り直す経路が有力な改善候補である。`layoutLogEntry` → `thinkingBodyRenderer` →
  `wrapCellsWithSource`で、変わらない本文部分の再処理と重複した文字分解を減らす方向を候補とする。
  診断binaryは計測処理・GC公開・FFIを含み、関数別counterは重複と計測負荷がある。
  元の更新間隔・batchingも再現しておらず、実processのheap内訳や修正後の削減量は未確認である。
  実TUIは同じPIDのまま23:52 JSTにはPSS94.7 MiBへ下がった。
  証拠はgit管理外の`.tools/a28-tui-investigation/findings.json`と参照先へ保存した。 product
  sourceは変更しておらず、更新時割当の削減は個別採用後に実装する。
- TUI割当の因果比較（2026-10-06、同じ保存会話、未採用）:
  利用者が診断プログラムの追加と調査を承認したため、`scripts/diagnostics/a28_tui_memory.py`、
  `a28_tui_observer.ts`、`a28_thinking_allocation.ts`を追加した。 `da251e56`のarchived
  sourceだけに計測処理を加え、通常版とthinking折返しを空の表示行へ置き換えた
  診断版を、同じ2,552更新・10 ms間隔・110列×36行・隔離HOME／XDGで比較した。
  起動順を入れ替えて各2回測定し、両版とも会話260 entity・cursor
  2,552と最終snapshotのSHA-256が一致した。 通常版はPSSピーク167.1–167.7 MiB、終了10秒後167.1–167.7
  MiB、30秒後100.3–101.1 MiB。 折返しを省いた版はピーク102.9–103.1 MiB、10秒後103.0–103.2
  MiB、30秒後84.0–85.8 MiBだった。 強制GCはこの通常待機の測定後にだけ行った。GC後の生存JS
  heapは通常10.43、診断10.11 MiBで、 30秒後に残るPSS差約15–16 MiBは主にanonymous
  pageの差だが、その所有・長期残存は未特定である。 計測なしの元production
  binary一回でも、ピーク170.0、10秒後169.7、30秒後103.4 MiBとなった。
  計測版の再生中の累積JS割当は通常約4.4 GiBから診断約0.9 GiBへ減り、thinking layout回数は
  約1,300回でほぼ同じだった。割当の削減とprocess PSSピークの削減が同条件で対応した。
  実本文の単体測定は幅90 cell・200回batchの平均をfresh process二回で比較し、約3.9 KBのthinkingで
  一回あたり約2.1 MiB、約27 KBのthinkingで約15.8 MiBを割り当てた。 出力として保持されるJS
  heap増分はそれぞれ約43 KB、361 KBで、本文の数百倍になる割当の大部分は短命だった。 約3.9
  KBの本文では、行ごとの文字分解だけで約0.70 MiB、行幅の計算だけで約0.67 MiBを割り当てる。
  これらは別batchで測った部分処理であり、全体への寄与率や単純な合算値として扱わない。
  単発counterには計測自体等の割当が混ざるため、単発のraw値で倍率を判断しない。
  今回は大きな増加の多くが30秒以内に下がることと、折返し経路がピークを増やすことを確認した。
  診断版はthinking表示を省くためproduct修正ではなく、表示を維持した最適化の削減量はまだ未確認。
  候補は同じ本文の重複した文字分解・幅計算・位置配列生成を減らすこと。
  生存heapだけで常駐量全体を説明せず、30秒を超える残存量も保証しない。
  証拠はgit管理外の`.tools/a28-tui-causal/summary.json`と参照先に保存した。
  稼働中のTUI・Coreと実DBは操作せず、provider call、task投入、product runtime変更、配置は0回である。
- TUIの局所構造の無駄確認（2026-10-06、利用者指定、未採用）:
  独立reviewerがproductionの入口・Core起動境界・HTTP/SSE・reducer・projection・表示cache・terminal・入力を
  read-onlyで確認した。現在HEAD `4683adb`と測定source `da251e56`の対象runtime差分は配色変更のみ。
  correctnessの必須修正findingはなく、既知thinking以外に数十MiB以上の不要な生存dataがある証拠は得ていない。
  - 共通CLIのstatic importが非選択の履歴CLI・node:sqlite・Core・provider・Worker側moduleを評価する。
    `henji_cli.ts`と`tui_cli.main`の入口を同じ診断binary内で切り替え、空会話・同じCore接続を各2回測定した。
    専用入口で起動直後約8.0–8.8 MiB、30秒後約3.2–4.1 MiB、GC後の生存JS heap約2.52 MiBが減った。
    全runのsnapshotは一致した。最小方向は選択commandの遅延importで、通常local Core起動は維持する。
    証拠は`.tools/a28-tui-entrypoint/summary.json`。この結果を既存48.2
    MiBのコピーCore比較から差し引かない。
  - 全SSE frameでposition・projection・startupを再生成し、startupとpositionを複数回deep cloneする。
    今回の2,552更新は全件conversation更新でcontrol changeは0件だった。
    orientation設定を初回だけにする同一binaryの診断比較を各2回行うと、累積JS割当は約3%減り、
    PSSピーク168.6–169.1から164.9–166.3 MiB、30秒後101.2–101.4から99.3–99.7 MiBとなった。
    会話snapshotと最終tmux画面のSHA-256は一致したが、thinking layout回数も少し変わるため全差分を
    cloneに厳密帰属させない。変更なしの場合の比較であり、metadata・lifecycle変更を扱うproduct修正ではない。
    元情報が変わった場合だけ再設定する候補。証拠は`.tools/a28-tui-orientation/summary.json`。
  - 未使用tool result本文122,518 bytes・progress89,945 bytesもTUIが受信・保持する。
    `/recall`はexecution IDでCoreへ別要求するため、この保持本文のconsumerではない。
    TUI内部projectionだけで未使用payloadを省く候補だが、今回の量だけで150 MiBを説明しない。
  - 起動と`/view`でGET snapshotをID照合に使い、直後SSE snapshotで正式stateを作る二重取得がある。
    activation付きattachのGETは設定照合に使うため同列に削除しない。寄与量は未測定。
  - opaque overlay表示でも先に会話をlayoutし、その後表示を置き換えるため、見えない会話更新も折返す。
    受信・会話stateは維持し、閉じた時の最新表示・resize／scroll
    anchorを維持して折返しを遅延する候補。 実利用時の寄与量は未測定。 表示Mapを全文の二重copy、API
    reducerを毎回の全会話copyとして数えない。history window外のlayout cacheは
    削除され、terminalの直近frameには差分描画のconsumerがある。更新履歴の無制限な蓄積は確認されなかった。
    review全文はgit管理外の`.tools/review-a28-tui-structure/report.md`に保存した。
    比較用`a28_tui_entrypoint.py`・`a28_tui_orientation.py`を診断programとして追加した。
    product修正・配置は行っていない。未使用payload・二重取得・hidden
    layout等は効果を測って採用判断する。
- 操作・結果表示の責務からのTUI設計reviewとPi比較（2026-10-06、未採用）:
  利用者は局所費用の一覧ではなく、現在の操作受付・結果表示の責務に対する構造の適切さを問うと明示した。
  同じ独立reviewerが操作・必要状態・owner・更新単位から再評価し、Pi実装も比較した。
  推奨候補はCore/DataとTUIの境界を維持し、既存HTTP/SSEをTUI内の単一read modelへ直接適用すること。
  現在の共通会話read model
  replicaから別の表示row/orderを同期する段階と、汎用presentation更新を整理する。 canonical
  domainの再構成や本文の物理二重copyを問題とする案ではなく、必要な表示状態のownerと同期経路を
  明確にする設計判断である。cursor/cut・scope・最小ID/position索引・order・execution
  notice・steering照合・ control metadataを維持し、draft/receipt/menu/viewport等のlocal interaction
  stateと合成する。 全wire
  deltaは順番に適用し、表示処理だけを合流する。全保存履歴の既存表示source、entry/source anchor、
  操作世代、window cache、terminal差分出力も維持する。巨大controllerへ統合する提案ではない。
  server側のTUI専用read model/別APIはcontractと投影同期を増やし、現機能に対する利益が未測定のため
  現時点では推奨しない。現full replicaを維持する局所整理案は移行途中として比較対象に残す。
  Piは`_refs/README.md`のsnapshot
  `c10bfb0d79dbbc998539a0a3e6c6a736a4e6db06`、1.0.0のsourceを確認した。
  通常interactiveはAgentSession eventから対象componentを更新するが、streaming Assistant
  contentは全文を clear/rebuildする。experimental remoteはConversationView
  replicaからcomponentへ投影し、publicationごとに
  transcriptを全invalidateする。Piを差分本文だけの処理や可視範囲だけのlayoutの例として扱わない。
  現Piは既定alt screenだが、通常のchat表示はcompaction-aware active context、remoteの旧entry
  pagingはTODO。
  Henjiの全保存履歴scrollと同条件ではなく、Piのtool結果本文には展開表示のconsumerがある。
  参考候補はoperation facade/表示read modelの分離、stable
  identityごとの更新、本文cache、editor/footer合成。
  履歴範囲縮小、in-process化、全invalidate、新replication frameworkの一括導入は採用しない。
  組替えのメモリ・入力応答改善量は未測定で、thinking全文処理の費用も別に残る。
  review全文はgit管理外の`.tools/review-a28-tui-structure/responsibility-report.md`へ保存した。
  これは設計候補の記録であり、product実装・architecture正本変更の承認ではない。

- TUI表示要件の利用者補足（2026-10-06）:
  当初要求したのはassistant出力のMarkdownを見やすくすることで、thinkingの折返しは要求していないと明示した。
  Increment 84はassistant Markdown、後のIncrement 123はthinkingの段落・読みやすさを扱う記録であり、
  現thinking rendererはassistant用のword-aware wrap/source index生成を共有している。
  既存実装・test・incrementの具体的な折返し方式を、利用者が要求した必須処理として維持しない。
  Markdown整形、thinkingの本文・改行表示、アプリ内のword-aware wrap/文字単位の位置配列生成を区別し、
  今回の検討でthinkingにassistant相当の整形費用を課すことを所与にしない。
  続く補足では、thinking・tool・assistant noteについて何も要求していないと明示した。
  これらの既存表示・整形を利用者の明示要件として扱わず、assistant回答のMarkdown
  readabilityと区別する。 この補足は既存表示の削除やproduct修正の指示とは扱わない。
- Pi測定後の利用者判断（2026-10-06）:
  CoreはPiより複雑と考えており、Coreの消費には大きな違和感はない。一方、操作受付・結果表示を担う
  TUI単独の100 MiB超には納得できないと明示した。PiのAgent+TUIの消費量をHenji TUI単独の
  妥当性の根拠にしない。今後のTUI評価は現在の操作・表示機能を維持した必要状態と更新処理の費用に基づける。
- Pi実CLI・実providerのメモリ測定（2026-10-06、利用者が実行を明示承認）:
  この環境にinstalled済みの`pi` 1.0.2をsource改変なしで起動した。実体はNode CLIで、Node v24.21.0。
  source reviewで参照したPi 1.0.0 snapshotとはversionが異なる。
  `openai-codex / gpt-6.1-sol`、thinking medium、110×36のtmux fullscreen、新規Sessionで説明依頼を1
  turn送信。 HOME/XDG/agent/session/workspaceを隔離し、tools・extensions・skills・context
  discoveryを無効化した。 `--offline`はstartup
  networkのみ止める設定で、応答は実providerから取得した。
  `/proc/<pid>/smaps_rollup`を約200ms間隔で568回測定し、child
  processも対象にしたが観測はPi単一process。 AgentとTUIを同じprocessに含む。強制GC・heap
  instrumentationは行っていない。 空画面の起動10秒後はPSS 86.4 MiB / RSS 117.7
  MiB。実応答中peakと完了直後はPSS 124.7 MiB / RSS 156.5 MiB。 完了後10・30・60秒もPSS 124.7 MiB /
  RSS 156.5 MiBで変化しなかった。 PSS内訳は空画面でanonymous 66.6 / file 19.7 MiB、完了後anonymous
  102.1 / file 22.7 MiB。 応答は43.9秒、stopReason `stop`、表示本文1,301文字・3,357 UTF-8
  bytes、表示thinking本文0文字。 usageはinput 563 / output 943（reasoning 68）/ total 1,506
  tokens。tool実行はなく、追加turnは送っていない。 物理HTTP
  request数・provider内部retryはinstrumentしていない。 小さな本文の応答後に100
  MiB超が残る現象はNode版Piでも観測したが、PSSのみではlive object、
  GC後の再利用領域、native割当を区別できず、Henjiの構造が最適であることの根拠にはならない。
  PiのAgent+TUI・新規短履歴とHenjiのTUI単独・長い既存履歴は同条件ではなく、性能順位は判断しない。
  診断programは`scripts/diagnostics/a28_pi_memory.py`、数値・時系列・画面・通常Sessionはgit管理外の
  `.tools/a28-pi-live/`へ保存。隔離credential copyは測定後に除去し、測定用Piも終了した。

- TUI評価の目的についての利用者補足（2026-10-06）: メモリ削減が目的ではなく、最適な処理の結果100
  MiB超が必要なら許容する、と明示した。
  現状は不要な処理が多く、それにメモリを使っているように見える、という疑問を検証する。
  各処理の操作/表示上の役割、必要な再実行、状態所有、処理量・応答・整合性から評価する。
  PSS・割当・保持量は結果指標の一つであり、100 MiB未満、thin client、単一store、paging、native化を
  それ自体の達成目標にしない。用途のあるcache・index・履歴保持は、操作を効率よく成立させるなら肯定する。
- TUI改定の検討案（2026-10-06、未採用、実装指示とは別）:
  利用者は改定案の検討を求め、表示処理の軽量化と状態・同期構造の整理は両方行うべきと指摘した。
  さらに、現構造を可能な限り維持する判断を捨て、常に最適な処理から考えるよう明示した。
  旧component、既存HTTP/SSE、Deno、現screen方式、履歴全文のTUI常駐は選定の前提にしない。
  ただし、採用済みの利用者操作と保存dataの意味を、実装都合やメモリ目標だけで省かない。

  出発点は「入力を編集する→Coreへ操作を送る→受付・進捗・結果を表示する」である。
  TUIに必要な正本はlocal draft/cursor、接続・表示対象、未確認の受付、viewport/menuであり、
  実行・予約・設定・保存履歴はCore/Dataが所有する。TUIがCore状態の別の正本を再構成しない。
  明示された表示要件はassistant回答のMarkdown readability。thinking/tool/assistant
  noteの高度整形は要件にしない。

  推奨候補は「更新元が変更の意味を通知→表示read
  model/index/cache→変更部分のlayout→可視frame→terminal」。
  store数の削減を目標とせず、各表現にconsumerがあり再処理を省けるなら複数の表現を肯定する。
  表示用recordはID、位置、種類、本文/活動preview、確定状態、必要なnotice関連情報のみとし、
  receipt照合・予約・cancel・設定menu等のconsumerが必要なcontrol情報を添える。 generic
  ConversationEntityから別の表示Map/orderへ同期する仕事は、発生元で必要な意味を公開する案と比較する。
  clientの再照合・再同期を省ける配置を選び、serverに別replicaや投影同期を増やして総処理が増すなら採らない。
  本文の物理二重copyがあるという理由ではなく、状態ownerと同期・処理段階が不要に重なるためである。
  transport、input、operation/receipt、view
  state、layoutを各moduleへ分け、巨大controllerにまとめない。

  display分類は回答Markdownとplain textを分ける。thinking/tool/assistant noteはplain表示を提案し、
  段落・元の改行・順序・活動状態を表示する。これは提案する既定であり、利用者が要求した追加機能ではない。
  回答本文とtool併存をDataのtoolIds等のsemantic関連から判定し、toolIdsが後から確定する更新も扱う。
  plain表示のscreen方式にアプリ内の物理行計算が必要なら、幅を一回走査し、各行の先頭元位置だけを作る。
  単語境界の再配置、Markdown
  span処理、全文字sourceIndices、文字/segment/tokenの重複配列をplain経路へ持ち込まない。
  append更新と判定できた場合は既存行を再利用し末尾の未確定行以降を更新する。任意replaceをappendと決めつけない。
  幅変更・本文途中の変更は必要箇所を再計算する。metadata/editor/timer更新で本文を再処理しない。
  回答Markdownのtable/list/code等は必要なlayoutとして扱い、変更のないentry/blockの結果を再利用する。
  画面を覆うmenu中は裏の会話stateだけ更新し、閉じる時に最新内容をlayoutする。

  表示用projectionの配置は比較対象とする。TUI内でwire入力から直接作る案ならAPI側の処理追加はないが、
  generic
  payloadの通信・decodeは残る。Core/API側で純粋な表示用projectionを提供する案なら不要payloadを
  通信・TUI保持から外せるが、notice/cursor/receipt等もconsumerを追ってcontractを設計する必要がある。
  new
  APIを避けること自体を理由に後者を棄却しない。Dataの履歴正本を追加複製しないprojectionとして設計する。
  今回のunused payloadは約212 KBで、この整理だけで数十MiB減るとは見積もらない。

  runtimeは必要処理を成立させる手段として評価する。不要なimport/evaluationは外すが、
  native比較はruntimeの具体的な処理/操作上の問題が残る場合に検討し、固定PSSだけを理由に必須にしない。
  単一Henji executable/別processの起動方式を変更しないことや言語を揃えることを目的にしない。 native
  TUIは低い固定費を期待する候補であり、今回のPi Node測定からその数値を推定しない。
  Deno案ではcommandの遅延importを行い、非選択Core/provider/history CLIの評価をTUIへ持ち込まない。
  既存probeで専用入口の減少は30秒後約3–4 MiBで、これだけを100 MiB超の対策にはしない。

  terminal委譲も候補とする。native auto-wrapとscrolling
  regionを使い、入力欄固定と更新中の本文表示を試す。
  全画面であることを不採用理由にしない。現在の行単位frame差分・PageUp/resizeのsource anchorを
  そのまま適用できると仮定せず、必要な画面位置管理と再描画量を比較する。
  行単位layout案でもplain経路を上記の最小処理へ変える。両screen案は同じ消費者機能で比較し、
  現行screen方式を残すためにwrap計算を必要要件へ格上げしない。
  全履歴のTUI常駐とCoreからのwindow取得も比較対象になり得るが、今回の本文169 KBだけを理由に
  新しいpaging contractを増やさない。履歴の表示可能範囲を短縮する案にはしない。

  検証は各部品の都合ではなく、入力編集・送信・予約/steering・cancel・履歴移動・resize・menu・
  Session切替・再接続・detach/quitが成立することから選ぶ。tool併存本文、thinkingの途中更新と確定、
  実際のMarkdown table/list/codeの表示も確認する。旧word-aware thinking
  testを新要件として固定しない。
  同じ保存会話と2,552更新の再生で空画面/会話表示直後/更新peak/自然待機10・30・60秒のPSS、
  累積割当、入力応答、最終の本文・順序・表示を比較する。強制GCで減った値を通常利用の成果にしない。
  100
  MiB未満を改善目標にしない。最適な処理の結果必要なメモリ量は許容し、不要な処理の有無を評価する。
  full replicaの削除・native化・terminal委譲の削減量は未測定であり、組み合わせの最終値を保証しない。
  採用後はTUI Surfaceの変更を隔離tmux上のproduction経路で確認する。
  構想・architecture・roadmapの正本反映やproduction修正は今回行っていない。

- 最適な処理を基準にした独立設計reviewの結果（2026-10-06、未採用）:
  利用者が既存構造維持のbiasを再指摘したため、同じreviewerへ目的・必要操作・状態・処理からの
  新しい独立設計reviewを依頼した。初回約10分、続く目的補足に対するbounded re-reviewを実施した。
  前回の「既存APIを維持できる最小変更」をB案推奨の理由にした判断は撤回した。
  メモリ削減を目的にしたwindow取得の既定推奨と固定RAMによるnative優先も撤回した。
  必要なcache・索引・全履歴source保持は、再取得・再解析・操作待ちを減らすなら適切と評価する。

  採用判断に向けた推奨候補は、Dataの更新境界が幅非依存の表示情報と変更の意味を公開し、
  TUIがlocal操作stateと再利用に有効なread model/cacheから必要部分を描く構造である。 単一storeやthin
  client自体を正解とせず、同じ仕事の再実行を外すことを目的とする。
  server側に別の会話replicaや追加投影同期を作って総処理が増えるならこの配置を採らない。
  client側の直接投影も、consumerの仕事を効率よく成立させる対案として評価する。

  具体的な見直し根拠は、thinkingで先頭しか使わない全文字sourceIndicesを生成すること、
  plain情報のword-aware/Markdown処理、変化のないorientation再設定、opaque
  overlay下の本文layoutである。 累積本文のfull entity
  upsert再送も、更新元が旧値と新値を持つため、append/replace/metadata通知へ変える候補。
  `normalizer.ts`の更新境界→`conversation_writer.ts`のJSON encode→Coreのencoded public frame→
  TUIのJSON.parseという実経路を確認した。appendを確認できる時にだけ通知し、置換はreplaceとして通知する。
  TUIが累積全文をdecodeしてから追記判定する仕事を発生元で省く。原観測も累積全文ならserverの比較は残り得る。
  新contractの総処理・操作応答・割当は未測定で、12.7 MBのwire量が169 KBになるとは見積もらない。

  推奨はplain表示経路と変更通知/状態同期を同じ改定で見直すこと。Markdownはassistant回答に適用し、
  note分類の後確定も意味情報として扱う。terminal委譲/アプリ行layoutは必要な操作の総処理で選ぶ。
  native比較や範囲取得を、100 MiB超だけを理由に新しい必須作業へ加えない。 これは設計判断とsource
  reviewであり、新方式の最適性・PSS削減量を実測した結果ではない。
  reportはgit管理外の`.tools/review-a28-tui-structure/first-principles-report.md`。 product
  source、正本architecture、稼働Sessionの変更や実provider callは行っていない。

- 可視領域に応じた加工についての利用者質問と現経路確認（2026-10-06）:
  利用者は、端末の表示行・幅に収まる領域へ表示される時だけ加工すればよいのではないか、と問うた。
  現`layoutUi`はeditor/footer等を除いたlogHeightを決める一方、`logRows`が履歴候補windowのentryを
  cache利用またはentry全文layoutで行へ展開してから、`slice(logStart, logStart + logHeight)`で可視行を選ぶ。
  履歴候補windowは既定48 entry/1 MiBであり、実画面の可視行とは異なる。全保存履歴を毎回layoutしている
  わけではなく、変更しないentryにはcacheがある。しかし候補内の長い変更entryは可視部分以外も全文layoutする。
  改定候補は本文/状態の更新と可視layoutを分離し、画面外ではlayoutをdirtyにするだけで加工を遅延すること。
  表示anchorから画面に必要な行/blockを加工し、既存cacheを再利用する。先読みは操作を速くする利益で選ぶ。
  行位置の索引やMarkdownの文脈解析が必要な場合は独立した必要処理として扱う。部分表示するtableの列幅等も
  依存情報を読むことはあるが、全履歴や画面外本文の折返し・span・画面行を毎更新生成する理由にはしない。
  sourceは`v0/tui/layout.ts`のlogRows/layoutUi、`entry_layout_cache.ts`、`state.ts`のhistoryWindow。

- 可視領域を起点にした改定案（2026-10-06、利用者が案の再検討を指示、未採用）:
  以下を描画候補の一つとする。後述のterminal履歴案と比較して選ぶ。
  先のstore/公開view中心の案は、この描画経路を満たす手段として再評価する。
  目的は現在の操作受付・結果表示に必要な処理を最適に行うこと。100
  MiB未満や保持量削減を目標にしない。
  方針は「更新を本文sourceへ反映→閲覧位置と実表示領域を決定→必要な行/blockだけ加工→frameを描く」。
  全候補entryを折り返してから可視行をsliceする現順序は置き換える。

  1. 本文と表示加工を分離する。
     TUIは表示に必要な本文・ID・順序・種類・版・確定状態と操作に必要なcontrolを保持する。
     受信時は関連recordと索引の更新、加工済み結果の必要な無効化だけを行う。受信のたびにrendererを呼ばない。
     draft/cursor/menu/receiptと会話sourceは別の状態として扱う。全履歴sourceを保持することは許容する。
     各索引・派生表現はconsumerと再処理を省く役割で選び、単一storeの数合わせを目的にしない。

  2. 閲覧位置を先に決める。 latestまたはentry
     ID＋元本文位置を持ち、editor/footer/menuを差し引いた実際の行数と幅を求める。
     位置解決には本文中の改行/block境界、必要時に作った折返し開始位置/checkpointを使う。
     viewportのために全履歴の高さや全文字位置配列を先に作らない。必要な初回走査/文脈解析は索引として再利用する。
     latestは末尾から画面を埋める範囲を求め、anchor閲覧はその位置から必要行を求める。

  3. 行生成を要求駆動にする。
     rendererの`render(entry全体, width) -> 全行配列`というinterfaceを置き換え、
     source位置から行を生成するcursor/iteratorが必要な行数で停止する形にする。
     thinking/tool/assistant noteは元本文・改行のplain経路とし、必要なセル幅/行先頭位置だけを扱う。
     word-aware整形、Markdown spans、per-character sourceIndicesをこの経路へ持ち込まない。
     assistant回答だけにMarkdown解析/layoutを適用し、表示に関係するblockと文脈だけを処理する。
     表の列幅、fence等の状態に必要な範囲外参照は認めるが、未表示部分の画面行/着色spanを全て生成しない。
     単一entryが長くても、画面を埋めるためにentry全文の表示行配列を作る形に戻さない。

  4. 表示と変更の交差で仕事を選ぶ。
     表示外entryの更新はsourceと索引/dirty情報だけ更新し、見る時に加工する。
     表示中entryのappendは、確認できた未確定tail/block以降を更新し、確定済み部分を再利用する。
     途中replaceや後確定のnote分類は影響する文脈/blockを無効化する。任意Markdownを末尾一行更新と仮定しない。
     同じentryでも画面外部分まで毎回再加工しない。位置計算の必要性と表示行生成を分ける。
     editor/timer/control変更は該当regionを更新する。順序変更時も本文位置anchorを維持して必要なviewを解決する。
     opaque menu中は会話sourceを更新するだけで、会話layoutはmenuを閉じるまで遅延する。

  5. cacheと履歴操作を新しい処理単位へ合わせる。 entry単位の全文layout
     cacheから、解析文脈、block、折返しcheckpoint、加工済み行を分けた再利用へ変える。
     有効性は本文の実変更範囲、幅、表示種類/文脈で判断する。変更のないrecord/blockを再加工しない。
     PageUp/Downは全`allLog`配列ではなく、表示済みの元本文位置と必要な前後の行cursorから移動する。
     resizeは元本文anchorから新しい幅の画面を作り直し、未閲覧履歴を全再layoutしない。
     位置案内はentry/本文位置から作る案を含め、総表示行数を出すための全履歴事前layoutを前提にしない。
     次pageの先読みやcache保持は操作応答を改善する利益で採否を決め、低い保持量だけで削らない。

  6. Core/Dataとtransportはこの経路に必要な意味を供給する。
     現Dataは既に幅非依存の本文・意味関係・順序・状態を作り、幅計算はTUIが行っている。
     本案でも幅・閲覧位置・画面行はTUI側で扱う。幅非依存化が今回初めて必要になるという説明は訂正する。
     更新元でappend/replace/metadataを確定して通知する案は、累積全文再送/decodeとTUI側の再判定を省く候補。
     clientへ必要な情報を直接渡す公開view案は総処理で比較し、別replicaや二重publicationを増やすためには採らない。
     新API、paging、native化は可視領域起点の描画を成立させる必須前提にはしない。 terminal
     auto-wrapもdrawingの候補に残し、必要な位置管理・再出力との総処理で選ぶ。

  変更対象は本文source/更新の境界、閲覧位置・行cursor、Markdown/plain
  renderer、cache、frame合成である。
  `AssistantContentRenderer`、`EntryLayoutCache`、`layoutUi/logRows`、`scrollPage/allLog`の現在interfaceは
  前提にしない。役立つID/order、本文source、terminal差分出力、操作/receipt経路は役割を確認して使う。
  実装採用後の検証は、画面外で長い本文が更新されても閲覧中の表示と入力を維持すること、
  その本文を開いた時に最新内容を表示すること、長い単一entryのPage/resize、可視Markdown
  table/list/code、 menu開閉、途中更新/確定とnote分類、Session切替/reconnectを実経路で確認する。
  sourceの最終本文・順序の一致に加え、加工範囲・走査量・cache再利用・入力応答・出力・PSSを観測する。
  『加工済み行が可視範囲に対応する』ことと、『必要文脈の読取も常に可視行数に比例する』ことを混同しない。
  product source変更、正本architecture反映、provider call、配置はこの検討では行っていない。

- terminalへ表示履歴を任せる案との比較（2026-10-06、未採用）:
  利用者は、PageUp/Downもtmux等の履歴bufferへ任せる案を提示した。ただし根拠のある決定ではなく、
  鵜呑みにせず、必要な操作と総処理のメリット・デメリットから選定するよう明示した。
  現行機能や表示方式の維持も、利用者案への追随も選定目的にしない。

  - 成立性の実測: 隔離HOME/XDG、独立socket、configなしのtmux
    3.5aで80x12画面を使い、1–10行を出力領域、
    11–12行を固定入力/status領域とした。26件の出力で17行のhistoryができ、最初のrecordを
    historyから読め、固定入力/statusも残った。固定入力欄があることだけでは本案を否定できない。
    通常時の`a`はprobeへ届き、copy mode中の`b`は届かず、終了後の`c`は届いた（受信`ac`）。 copy
    modeが履歴閲覧とキー受付を担うことは[公式manual](https://man.openbsd.org/tmux.1)とも一致する。
    証拠は`.tools/a28-terminal-history/summary.json`、`history.txt`、`visible.txt`。
    probe専用serverは終了済み。Henji常用process、利用者のtmux設定、providerは触っていない。
    確認範囲はtmuxの基本動作であり、他terminalやHenji全操作の互換性・性能を実証したものではない。

  - terminal履歴へ任せる利点:
    確定した表示を一度出力し、その保存・閲覧・検索・copyをterminal側に集約できる。
    Henji側の過去画面行、履歴移動のための行索引、再閲覧時のlayoutを省ける。 plain本文のsoft
    wrapもterminalへ任せられる。terminal自身の履歴保持は必要だが、
    重複する表示処理を省けるなら有効であり、単なる別processへのメモリ移動という理由で退けない。

  - 操作・結果表示上の代価: 同一paneのcopy
    mode中は通常キーがアプリへ届かないため、履歴を見ながらdraftを編集・送信する
    現行操作はそのまま成立しない。別pane等で共存させる案はあるが、pane/focus/キー経路を増やす。
    この同時操作を必須とするかは、現実装に存在することだけでは決めない。
    また、生成中から確定までの実経路は同じrecordを更新する。`keyed_conversation_store.ts`ではassistantの
    toolIdsによりnote分類が変わり、tool開始表示をresult表示へ置換する。これは未確定表示の更新であり、
    完了した過去turnの確定本文が後から書き換わる根拠ではない。通常のcursor制御は画面座標を対象とし、
    未確定のままscrollbackへ送った旧表示をIDで置換する機能にはならない。
    本案では結果を別行へ追記するか、未確定表示を画面内に留めて確定後に履歴へ送る必要がある。
    これは単なる描画内部変更ではなく、途中表示と確定表示の関係を選び直す判断である。
    assistant回答のMarkdown table列幅・list/codeの明示改行は出力時のlayoutとなる。 terminalのsoft
    wrapだけでMarkdownの意味から新幅へ再layoutできるとは扱わない。
    古い表示をそのまま読むか、必要時に再表示するかを選ぶ。毎resizeで全履歴を再出力すれば利益が減る。
    Session切替・再接続ではterminalの出力履歴とCoreの保存会話を区別する必要があり、
    切替先を読み出して表示する処理は残る。bufferの上限もある
    （[tmux 3.5a公式仕様](https://raw.githubusercontent.com/tmux/tmux/3.5a/tmux.1)の`history-limit`）。
    scrollback自体を保存会話の正本にする案ではない。

  - 組合せ案の評価:
    「確定履歴はterminal、未確定内容と入力/menuは小さい可視領域」という案も成立候補とする。
    確定時の加工・出力は一回追加されるが、過去全体を毎更新加工する必要はない。
    一方、長い未確定本文の画面外部分を生成中にも読むなら、別の閲覧経路または早期履歴出力が必要になる。
    履歴へ送った部分の後変更も解決が必要であり、二方式を足すだけでは最適にならない。

  - 参照実装確認前の暫定選定（後述の確認で第一候補の優先を撤回）:
    最新本文を読めること、入力・制御を受け付けること、assistant回答のMarkdownを読みやすく示すことを
    同じ経路で成立させる候補として、可視領域起点の描画を暫定第一候補とする。
    画面外を毎更新加工することや全文layout配列は前提にせず、変更する範囲と閲覧範囲の交差だけを処理する。
    terminal履歴案は確定済みの追記型出力では処理をさらに省けるが、上記の操作・表示選択まで含む別案である。
    履歴閲覧中の入力を切り分け、過去表示の再layout/置換を不要とする使い方なら、terminal履歴案が優位になる。
    その操作変更を未承認のまま「最適」と確定せず、かつ現行操作を全て維持すべきという推測も採用しない。
    総性能の優劣は未測定。比較する場合は同じ操作と結果で、加工範囲・走査量・出力・入力応答を測り、
    メモリだけで選ばない。Piのmain-screen実装も全文`render(width)`と`previousLines`保持を行い、
    width変更でscrollback消去＋全再出力するため、terminalへ完全委譲した実例としては扱わない
    （`_refs/pi/packages/tui/src/tui-main-screen.ts`、参照版1.0.0）。

  - 「過去の記録が書き換わるか」の追加確認:
    完了した過去turnの確定本文を書き換える通常経路は、確認したsourceには見つからない。
    前の比較では、生成中に画面から流れた未確定表示と、確定済みの過去記録を区別できていなかった。
    `normalizer.ts`のassistant_progress→model_result、thinkingのcomplete更新、tool_call→tool_resultは
    途中から確定までの更新である。model_resultはdeclaredCallsも同時に処理し、writerは同一publication内の
    entity更新をcoalesceするため、note分類を確定後の過去本文変更の一般例として扱わない。
    終了後のhook/context/provider観測保存経路も確認したが、`history_adapter.ts`では確定済み本文の
    改稿に投影していない。これは全APIの不変保証を証明したものではなく、通常経路のsource確認である。
    確定済み表示を追記するterminal履歴案は、この点で自然な候補である。
    比較上の争点を、未確定表示をいつ履歴へ送るか、履歴閲覧と入力の共存、過去Markdownのresize、
    Session切替・再表示へ絞る。「確定履歴が後から変わる」という理由では本案を不利に扱わない。

  - Pi・Codexのterminal履歴方式の確認と判断更新:
    利用者は、PiとCodexにもterminalへ履歴を任せる方式があり、別方式も存在すると指摘した。
    Pi参照版1.0.0には`TuiMainScreen`と`TuiAltScreen`がある。main
    screenは履歴閲覧をterminalに任せつつ、
    componentの全文render、表示行保持・差分比較をアプリが行う。width変更や表示外の旧行変更は
    scrollback消去＋全再出力で扱う。履歴委譲の成立例であるが、毎更新の加工を最適化した例とは区別する。
    Codexのinstalled CLI 0.160.0のhelpは`--no-alt-screen`をinline mode＋scrollback保持と説明する。
    [公式CLI文書](https://developers.openai.com/codex/cli/reference/)にも同flagがある。
    実装参照はOpenAI公式repositoryの固定commit
    `3f1ccb7ceb814e54314826f68d61c892e2f5a48e`を取得した。 installed
    binaryと同一sourceであることは確認していない。保存先は`.tools/a28-codex-reference/`。
    `insert_history.rs`は確定表示を入力viewportの上のscroll
    regionへ書き、通常のdrawはviewportを描く。 `app/native_history.rs`は未完了dynamic
    toolに関係する出力を待たせ、streamの未出力部分を確定sourceへ
    統合する。`app/resize_reflow.rs`は幅変更時に保持したHistoryCell
    sourceからscrollbackを再構成する。
    `transcript_mode.rs`はTerminal/Ownedを区別し、Ownedでは保持sourceをdraw経路で表示する。
    このsourceにはpre-wrapとterminal wrapの選択もあり、「terminalに履歴を任せる」と
    「Markdown/折返し等の表示加工も全てterminalに任せる」は別の判断である。

    生成中の更新・入力欄・幅変更があることだけでterminal履歴方式を不利とし、可視領域方式を
    第一候補とした判断は撤回する。実装を確認する前に現行操作との距離を強く評価しすぎた。
    「確定履歴はterminal、更新中の表示と入力/menuはTUI」は実装のある構成として有力候補にする。
    このTUI側の更新中表示にも、不要な全文加工を避ける可視領域起点の処理を適用できる。
    ただし二つの完全な履歴描画経路を併設することは既定にしない。Pi/Codexの採用だけで性能優位とも断定しない。
    比較する仕事は、通常更新で新しく確定した内容と動く領域だけを加工する方式と、
    閲覧位置に応じてsourceから必要な行を生成する方式である。resize/replayの仕事はその操作時に比較する。
    tmux copy mode中の入力制約は確認済みだが、terminal委譲方式全体の共通制約へ一般化しない。
    provider call・Codex対話起動・product実装は行っていない。文書diff check済み。

  - 過去Session再表示とtmux既定2000行の確認:
    利用者が、過去Sessionを呼び出した時にtmuxの既定2000行制限がどう影響するか質問した。 隔離tmux
    3.5a（configなし、80x12、出力1–10行、固定入力/status 11–12行）へ、
    保存会話の再表示を模した2500件の番号付き1行出力を行った。history-limitは2000、実historyは1891行、
    captureで読める本文は601–2500の1900件で、1–600は残らなかった。historyが常にぴったり2000行
    残るわけではない。probe専用serverは終了済み。証拠は
    `.tools/a28-terminal-history/session-replay-limit/summary.json`、`retained.txt`。
    この制限はterminalへ出力した表示行にかかり、Coreの保存会話を削除するものではない。
    terminalのPageUpだけでは、脱落した行をCoreから自動取得できない。
    全文を加工・出力しても先頭が読めなくなるため、全Session再出力を無条件の最短経路にしない。
    全履歴を辿る動作が必要なら、terminal側の上限との役割分担と、保存会話を指定位置から読む経路を
    選ぶ必要がある。alternate
    screenの可視領域起点閲覧はterminalの履歴上限に依存しない点で利点がある。

  - alternate
    screenの更新依存・可視範囲加工を[Increment 198](../increments/increment-198.md)へ採用した。
    利用者は2026-10-06にalternate screen継続と上記改善の実装を指示した。
    採用要件・計画・実装・検証結果の正本は198。前段の比較・処理監査の根拠は
    [調査文書](../research/a28-alternate-screen-viewport-plan.md)を参照する。
    Core全体のnative内訳等、198の対象外の候補は本A28に残る。

