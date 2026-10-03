# 通常利用 increment 3 — 履歴からの復帰と画面の視覚的境界

ステータス: 完了。local実装、focused verification、authoritative gateに加え、production TUIでの
人間による通常利用確認とユーザー受入を2026-09-07に完了した。

## この文書の位置付け

この文書は通常利用increment 3の対象、決定、実装順、確認方法の正本である。実装後の事実は
`docs/increments/increment-3-results.md`へ記録する。現在地と次の行動は`.handoff/handoff.md`だけに置き、
`docs/roadmap.md`へこのincrementの作業履歴を追加しない。

ユーザーは、通常利用increment 2で観測した次の三点をincrement 3までに改善する範囲として確定した。

1. compact startup行の`F1 help`表示を削除する。
2. conversationの過去表示から、迷わず最新追尾へ戻れるようにする。
3. turn、入力欄、footerの視覚的境界を明確にする。

対応するroadmap機能はF01、F05、F10である。

## 根拠となる通常利用の観測

- increment 2で通常footerの`F1 help`は削除したが、production TUIのcompact startup行には
  `trusted-local · credentials checked only when sending · F1 help`が残っている。
- PageUp（利用者のterminalでは`fn`+上矢印）でviewportを`anchored`にした後、Escは`input ignored`となり、
  `latest()`へ戻る人間向けの操作がない。
- PageDownで最下部を表示しても`followLatest`へ戻らない。
- 過去表示中に新しい指示を送ると、指示と後続出力はviewportより下へ追加され、画面上では見えなくなった
  ように感じる。
- conversation、入力欄、一行footerの表示密度が高く、turnと各bandの境界を読み取りにくい。
- current repositoryを含む`cwd`はfooterへ表示されるようになったが、一行にstatus、Session、agent、cwdを
  収めているため、情報のまとまりが分かりにくい。

根拠の正本は`docs/experience/normal-use-inbox.md`に蓄積した通常利用の観測と、現行の
`v0/tui/state.ts`、`v0/tui/layout.ts`、`v0/tui/render.ts`、`v0/tui/controller.ts`である。

## このincrementで成立させるproduct動作

### 1. compact startup

1. production TUIのcompact startup二行目を
   `trusted-local · credentials checked only when sending`とし、`F1 help`を表示しない。
2. F1 key、`/help`、既存startup help overlayは残す。help機能そのものを削除しない。

### 2. 現在Sessionのconversation viewport

1. 最新追尾中にPageUpを押し、現在のlogが一画面を超えている場合は、現在と同じHost-owned
   `anchored` viewportで過去表示へ入る。未送信draftとcursorは変更しない。
2. 一画面以内で過去に移動できるlogがない場合、PageUpで見かけだけの過去表示へ入らず
   `followLatest`を維持する。
3. 通常viewportの過去表示中は、footer一行目の先頭へ
   `history rows <先頭>-<末尾>/<全体> · Esc latest`を必ず表示する。Session/turnやstatus detailより優先し、
   それらが長くても過去表示中であることと復帰操作を隠さない。新しいlog entryが下へ追加された場合は、
   既存の`new below <N>`も同じ行の幅が許す範囲で表示する。
4. PageDownで次pageがまだ過去にある場合は従来どおり移動する。次のPageDownで最新pageへ到達する場合は
   anchorを残さず`followLatest`へ戻し、`newBelowCount`を0にする。
5. 過去表示中にEscを押すと、draftを変更せず`followLatest`へ戻る。最新追尾中のidle Escに新しい機能は
   与えない。
6. 過去表示中に通常の非空taskを送信し、pending laneへのadmissionが成功した場合は、turn開始前に
   `followLatest`へ戻す。送信した`user>`とその後のtool/assistant出力を直ちに見える状態にする。
7. 空入力、unknown slash command、admission失敗ではviewportを暗黙に移動しない。busy中のcancel、steering、
   follow-upのkey semanticsは変更しない。
8. この過去表示は現在Sessionのretained conversation viewportであり、保存済みcausal historyを表示する
   既存の内部history modal/projectionとは統合しない。`/history`、vi mode、mouse操作は追加しない。
9. startup helpやsession picker等のoverlay表示中は、Escがoverlayを閉じる既存semanticsを優先し、footerに
   `Esc latest`を表示しない。overlayを閉じて通常viewportへ戻った後、anchorが残っていればhistory位置と
   `Esc latest`を再表示する。

### 3. turn、入力欄、footerのlayout

1. retained TUIのlog projectionで、最初以外の各`user>` turnの前へ空白行を一行置く。
2. 各turnの`user>`と、そのturnで最初に続く`tool>`または`assistant>`の間へ空白行を一行置く。
   streaming更新やtool resultへの置換で空白行を重複させない。
3. 上記の空白行は`UiLogEntry`やcanonical transcriptへ保存せず、`layoutUi()`がentryのturn、kind、labelから
   導く表示専用rowとする。Session reopen時のrestored transcriptにも同じ規則を適用する。
4. conversation logと入力欄の間、および入力欄とfooterの間へ、それぞれ空白行を一行置く。
5. footerを二行にする。一行目はstatus、Session/turn、agent、pending、history位置等の操作情報、二行目は
   `[cwd <physical-workspace-path>]`だけを表示する。
6. cwd行はincrement 2の表示契約を維持する。幅に収まるpathは完全表示し、収まらない場合は先頭を省略して
   repository名を含む末尾を残す。
7. latest表示中のstatus行は`ready`、`busy`、`cancelling`等のprimary statusを最優先し、次にSession/turnを
   保持する。agent、context detail、pending、`new below`等は幅に応じて省略できる。通常viewportが
   anchoredの場合だけはhistory位置と`Esc latest`を行頭の必須orientationとし、primary status、
   Session/turn、その他のdetailの順に後置・省略する。
8. `MIN_ROWS`以上では二つの入力境界rowと二行footerを常に表示する。物理的に全rowを置けない既存の
   degraded表示では装飾用の空白rowを先に省略する。高さ4行以上では少なくとも一行のlog、入力、status、
   cwdを各一行、高さ3行では入力、status、cwdを各一行、高さ2行では入力とstatus、高さ1行では入力だけを
   表示する。表示できないrowをframe外へ生成せず、cursorを実在する入力row内に保つ。
9. cursor row、log viewport height、overlay height、frame byte boundを新しい固定row数に合わせる。
   alternate screen、retained redraw、terminal復元は変更しない。

## 決定済みの実装境界

- viewport modeは既存の`UiScroll`にある`followLatest` / `anchored`を正本とし、別のcanonical history
  stateやSession fieldを追加しない。
- history位置は`layoutUi()`が持つ`logStart`、visible log row数、`totalLogRows`からそのframeごとに導く。
  positionをWorker protocol、Presentation contract、Session storeへ追加しない。
- history位置と`Esc latest`は通常viewportが`anchored`かつoverlayがない場合だけ表示する。overlay中はoverlay
  自身のheaderを操作説明の正本とする。
- PageDownの最新到達判定は`TuiRenderer.scrollPage()`内の同じlayout snapshotで行う。
- Escと通常task送信時の復帰判断はHost側`TuiController`がrendererのscroll stateを見て行う。
- turn内とband間の空白はすべてHost側layout projectionで作り、`UiState.log.entries`、provider transcript、
  tool event、execution artifactへ混入させない。
- footerの二行化はTUI固有のlayout contractであり、Workerから届く`PresentationProjection`を変更しない。
- 新しいkey binding、slash command、terminal mouse tracking、外部processは追加しない。

## 実装範囲

### 1. startup表示

- `TuiRenderer.renderCompactStartup()`の二行目から` · F1 help`だけを削除する。
- retained/non-retainedのcompact startup出力を同じ文字列へ揃える。
- startup stateの保持、F1 decoder、controller routing、help overlayは維持する。

### 2. scrollとcontroller

- `TuiRenderer.scrollPage()`で、PageUp時に`maxStart === 0`なら`followLatest`を維持し、PageDownの
  `nextStart === maxStart`では`latest()`へ遷移する。
- `TuiController`のidle Escは、rendererが`anchored`の場合だけ`latest()`を呼び、それ以外は現在の
  `input ignored`を維持する。
- `submitIfNonblank()`では、非空taskがpending laneへadmitされた後、taskをWorkerへ渡す前に
  `latest()`へ戻す。失敗経路ではscroll stateを変更しない。
- resize、entry置換、retentionによるanchor successor処理は既存state reducerを維持する。

### 3. log groupingとband layout

- `logRows()`で`UiLogEntry`列からturn境界とuser/output境界を検出し、重複しないblank `LayoutRow`を導く。
- blank rowをconversation identityのanchorにはせず、既存のscroll探索が次のsemantic entryへ進むことを
  維持する。
- `UiLayout`のfooter表現を二行に対応させ、status rowとcwd rowを別々に幅制御する。
- `layoutUi()`の固定row予約、log height、overlay slice、cursor rowを、入力前後のblank rowと二行footerに
  合わせる。
- `TuiRenderer.renderFrame()`は新しいlayout row順をそのまま描画し、frame byte bound内でも入力、footer、
  cursorをlogより優先して保持する。

### 4. 文書と結果

- 実装が安定した時点で、architectureに記載された現在のTUIの「一行footer」を、実装済みのstatus行と
  cwd行からなる二行footerへ更新する。責務境界や将来設計は変更しない。
- roadmapのF01/F05/F10の現在形に事実上の変更がある場合だけ更新する。
- 実装内容と確認結果を`docs/increments/increment-3-results.md`へ記録する。
- increment 3へ採用した観測は`docs/experience/normal-use-inbox.md`の未採用候補から除き、mouse、外部editor、
  Markdown、tool metadata等の未採用候補を残す。

## 実装順序

1. pure layout testsで、turn境界、user/output境界、入力前後のblank row、二行footer、cursor/log heightの
   期待形を固定する。
2. `layoutUi()`と`renderFrame()`を二行footerと表示専用blank rowへ対応させる。
3. rendererのPageUp/PageDown遷移とhistory位置表示を実装する。
4. controllerのEsc復帰とadmitted task送信時の自動復帰を接続する。
5. compact startupから`F1 help`を削除する。
6. 変更したproduct動作に対応するfocused test、type check、format、lint、`git diff --check`を実行する。
7. stable candidateに対してcoordinating ownerがauthoritative `v0:gate`を一回だけ実行する。
8. 結果文書と必要なroadmap現在形を更新し、production TUIの人間による通常利用確認へ渡す。

## 検証

各確認は、このincrementで変更する具体的なproduct動作に対応させる。

- startup: compact startupに`F1 help`がなく、F1と`/help`のoverlayは従来どおり開閉する。
- scroll boundary: 一画面以内のPageUpはlatestを維持し、長いlogではPageUpが過去へ移動する。
- latest recovery: 過去表示中のPageDown最新到達、Esc、admitted task送信が`followLatest`へ戻り、
  `newBelowCount`を0にする。
- failed submission: 空入力、unknown slash command、pending admission失敗ではanchorとdraftを維持する。
- history orientation: anchored時だけhistory位置と`Esc latest`を表示し、latest時には表示しない。
- history priority: anchored中に長いunknown slash command statusが発生してもhistory位置と`Esc latest`が
  隠れない。anchored中にF1 overlayを開いた場合はoverlay固有のEsc説明だけを表示し、閉じた後にhistory
  orientationが戻る。
- turn grouping: live turn、settled turn、複数tool call、直接assistant応答、restored transcriptでblank rowが
  欠落・重複せず、`UiLogEntry`数とcanonical message列は変わらない。
- band layout: 標準サイズでlog/blank/input/blank/status/cwdの順になり、cwdのfull-path/suffix表示、statusの
  primary情報、cursor位置が正しい。
- regression: overlay、resize、wide/Japanese text、pending/recovery lane、cancel、alternate screen、terminal
  restoreの既存動作を変更しない。

focused verificationは少なくとも次を対象とする。

- `tests/v0/tui_retained_terminal_test.ts`
- `tests/v0/tui_conversation_presentation_test.ts`
- controllerのPageUp/PageDown/Esc/submit経路をproductionと同じinput eventで通すprovider-free test
- `/help` regressionに関係する`tests/v0/tui_tool_preview_test.ts`

実装中は変更箇所のfocused testと、該当する`v0:check`、`v0:fmt`、`v0:lint`、`git diff --check`を使う。
stable candidateでだけ`deno task --config deno.v0.json v0:gate`を一回実行する。provider request、credential
read、real-TTY E2Eはlocal verificationに含めない。

機械確認は実利用の代替ではない。実装後はproduction TUIを人間が通常利用し、実際のterminalで過去表示から
PageDown、Esc、task送信により最新へ戻れること、turn/input/footerの境界と二行footerが読みやすいことを確認する。
providerを使う確認はその時点のユーザー指示に従い、この計画から自動実行しない。

## 対象外

- 保存済みcausal history modalの入口、`/history`、vi風history mode
- mouse wheelとterminal mouse tracking
- canonical history bufferの外部editor表示
- Markdown renderer、plain text rendererのcomponent抽出、Mermaid
- tool definition metadata、`promptGuidelines`、`read`のoffset/limit、bash全出力readback
- tool componentのauthoring API、dependency lineage、F24の自己改訂機能
- input command historyのkey semantics変更
- Presentation contract、Worker protocol、Session schema、canonical transcriptの変更
- credential、provider、network、production TUIの実行
- dependency/lockfile、`_refs/*`、sibling repositoryの変更
- commit、push、tag、publish、release

## 停止条件と承認

次の場合は計画内の実装詳細として補わず、ユーザー判断へ戻す。

- 現在Sessionの`UiScroll`だけでは最新への復帰と位置表示を成立させられず、canonical historyまたはSession
  schemaの変更が必要になる。
- 二行footerまたは表示専用blank rowのためにPresentation contractやWorker protocolの変更が必要になる。
- `/history`、mouse、外部editor、Markdown、tool metadataのいずれかを同時に実装しなければ三つの目的を
  達成できない。
- 既存のF1 key/help overlayを削除しなければcompact startup表示だけを整理できない。

ユーザーはincrement 3の対象範囲と初期実装計画を2026-09-07に承認した。初回reviewの計画上の指摘を
修正した計画はGO（Blocker/P1/P2各0）であり、承認範囲のlocal実装とfocused verificationを完了した。
authoritative gateは成功した。同日、production TUIの通常利用でcompact startup、最新追尾への復帰、
task送信時の自動復帰、turn・入力欄・status・cwdの境界をユーザーが確認し、increment 3を受け入れた。
