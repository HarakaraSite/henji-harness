# Increment 212 — S36: TUIの会話履歴表示を端末scrollbackへ任せる

状態: local実装・検証・source commit・公式build・常用配置・配置後smoke完了（2026-10-07）。
常用環境での211・212とヘッダー修正の利用者受入済み（2026-10-07）。

## 目的・採用と承認範囲

利用者の「では、1と2をそれぞれインクリメントとする」により、提案した第二段階のS36を採用した。
第一段階の[Increment 211](increment-211.md)を`ac59f0d0`へcommit済み。
利用者の「コミットして、確認は212のあとにする 212に着手しよう」でlocal実装・検証を開始した。
利用者による常用環境での確認は212後にまとめる。provider call・build配置・pushは含めない。
後続の「了解です コミットと配置をお願いします」により、212のsource commit・公式build・常用配置が
承認された。配置結果は本書へ記録する。新しい実provider call・push・公開は含めない。

Henji独自の会話履歴スクロールを端末scrollbackへ移し、スクロール・検索・選択・コピーを端末へ任せる。
Henjiは入力と実行操作、生成中表示、会話の保存とSession再開時の再出力を担う。

## 原観測・利用者の判断

- 2026-10-07、利用者はtmuxまたはGhostty単独のscrollbackへ会話履歴表示を任せる案を検討した。
  Session再開時は保存会話を再出力する方針で、端末の履歴上限の制約を理解している。
- S36を進めるため、S35のmouse wheel履歴参照オン／オフ切替案は取り下げた。
- 入力欄・footerを固定するtmux上下pane連携は、tmux固有になるため見送った。
  会話と入力欄・footerは同じ端末に表示し、履歴閲覧中は入力欄・footerも画面外へ移る方針である。
- tmux copy-mode中はHenjiにキーが届かず、抜けてからHenjiを操作する制約を利用者が了承した。
- 元メモではGhosttyの`scroll-to-bottom = keystroke, no-output`仕様を根拠に、出力だけでは最新へ
  戻らず、アプリへキーを送ると最新へ戻ると想定した。EscもHenjiへ届くことから、実行キャンセルを
  外す判断は211へ採用した。この想定について変更後TUIのGhostty実機確認は未実施である。

元メモの外部仕様参照（2026-10-07確認の記録）:
[tmux copy-mode](https://github.com/tmux/tmux/wiki/Getting-Started#copy-and-paste)、
[Ghostty scroll-to-bottom](https://ghostty.org/docs/config/reference#scroll-to-bottom)。
着手時は実際の端末設定・挙動を確認し、仕様からの想定と実測を区別する。

## 必要な動作・受入条件

1. 通常画面へ会話を順次出力し、確定してscrollbackへ流れた表示を後から描き直さない。
   履歴のスクロール・検索・選択・コピーをHenji独自のviewportで処理しない。
2. 生成中の本文・thinking・tool進捗／結果、入力欄・footerを表示・更新できる。
   すでにscrollbackへ流れたtool開始行への結果は続きとして追記し、過去行への書き直しを避ける。
   進行中の同じentityの更新を、確定した過去会話の変更と混同しない。
3. 複数行入力とpickerを会話表示と共存させ、211で整理したキー操作を使用できる。
   最新表示では入力欄・footerが見え、履歴閲覧中は同じ端末の表示全体がスクロールする。
   pane分割による固定入力欄は追加しない。
4. SQLiteのsemantic履歴を維持する。Sessionを開き直したときは、その保存会話を順番に再出力できる。
   端末scrollbackを永続履歴の正本にしない。
5. tmuxとGhostty単独の履歴参照・コピーを想定する。tmux copy-modeのキー消費や端末の履歴上限は、
   了承済みの制約として扱う。端末設定をHenjiが自動で変更しない。

## 現行product経路・影響範囲

着手前（2026-10-07）のsource確認:

- API snapshot/update → reducerと会話投影 → `tui_renderer.ts` → layout・`screen_frame.ts` → 端末出力。
- `TerminalLifecycle`はalternate screenとmouse trackingを要求する。`screen_frame.ts`は画面内の行を
  上書きするため、mouse trackingを解除するだけでは会話全体を順番にscrollbackへ残せない。
- Henji内の履歴参照は`remote_session.ts`からrendererのviewportへ渡る。
  保存会話とSessionの切替・再開は既存Core/API/Dataの経路にあり、端末履歴とは状態の所有者が異なる。

対象はTUIの端末lifecycle・描画・履歴閲覧・入力／pickerとの接続と対応test。
置換で使われなくなるviewport・履歴操作・状態と専用testは、残る利用箇所を確認して同じ変更で整理する。
非TUIの`run --stream`、Core/APIの操作・保存契約、provider adapter、実dataの削除は対象外。
構想・architecture・roadmapへの反映が必要なら、変更案を本書へ置き、別途明示承認を得てから変更する。

## 着手時に決める設計事項・確認方針

- 表示を確定して端末へ流す境界と、生成中の更新領域を定義する。
  長い本文・thinking・tool進捗が画面を超える場合も、過去表示の書き直しに頼らず読める経路を設計する。
- 複数行入力・footer・pickerの配置と、閉じた後の会話表示への復帰方法を決める。
  Session切替・再開の再出力とライブ更新の接続も、保存済み内容を欠落・重複させない経路として整理する。
- focused確認は、順次出力と生成中の更新、tool開始／結果、入力とpicker、保存Sessionの再出力に対応させる。
  現行viewportを仕様として固定するtestは、新しいproduct動作に合わせて修正・整理する。
- 変更箇所のtype check・format・lint・`git diff --check`と、隔離HOME/XDGのtmux上のproduction TUIで
  生成中・履歴閲覧・コピー・複数行入力・picker・Session再開の実経路を確認し、本書へ記録する。
  Ghostty単独の確認環境と確認担当は着手時に整理し、未確認の挙動を確認済みとして扱わない。
- 実provider callが必要なら、対象・回数・保存先について別途明示承認を得る。full gateは要求しない。
  メモリ削減率・描画速度の改善率を本incrementの受入条件にしない。

## 採用したlocal設計

- 通常画面へ確定会話をCRLFで追記し、末尾の生成中表示・editor・footer・overlayだけを相対cursor移動と各行のELで更新する。
  alternate screenとmouse trackingは要求しない。
- Session表示scopeごとに出力済み位置を持つ。scope変更時は保存会話を再出力し、同scopeのsnapshot再同期で確定会話を重複させない。
- tool開始・更新・結果は順次追記する。本文・thinkingは末尾を更新し、画面を超える部分は先頭から確定して追記する。
  実行終了時にはcomplete=falseで残ったsemantic entityも表示確定する。
- resize時は既に表示したlive本文を、その場で確定する。端末がreflowして履歴へ移した本文を再追記せず、
  以後の累積更新は新しいsource部分を追記する。editor・footerは新しいサイズで引き続き操作できる。
- 本文が変わらないeditor・footer更新では、同じ先頭行を保持して変更された末尾だけを描画する。
  resize検知前の旧geometryの再描画が物理resizeと重なっても、既出本文を再出力しない。
- ヘッダーはSession表示scopeの初期情報を1回だけ出す（2026-10-07の利用者指示で変更）。
  RENAME・context・skillsなどの更新では追記せず、保存Sessionを開き直す時に最新状態を出す。
- Markdown tableなど、追記によって既出行の内部配置が変わるblockは全体を確定し、後続sourceだけを追記する。
  queue notice後の本文継続とthinkingの確定label変更も、既出本文prefixを再追記しない。
- 旧viewportとHenji内の会話PageUp/Down・wheel処理・history footerは撤去する。help overlayのPageUp/Downは残す。

端末制御の参照: [xterm control sequences](https://invisible-island.net/xterm/ctlseqs/ctlseqs.html)。

tmux実測では、画面先頭からED0で末尾を消すと`scroll-on-clear`によって直前の画面が履歴へ追加され、
生成中本文が再描画のたびに増えた。各行のELへ変更した理由はこの観測である。
該当条件は[tmux screen-write.c](https://github.com/tmux/tmux/blob/master/screen-write.c)の
`screen_write_clearendofscreen`も参照した。端末設定自体は変更しない。

## 正本変更案（未反映・別途承認待ち）

architectureのTUI説明には旧viewport、input history、alternate screen、会話履歴キーが残る。
211の入力履歴撤去・F1 cancel／F4 Sessionと、212の端末scrollback・表示scopeの出力receipt・
通常画面のmutable tailへ更新する案である。SQLite semantic履歴を正本とし、Core/API/Dataの所有境界は維持する。
対象は`docs/architecture/henji-host-agent-worker.md`のTUI／入力／会話表示の記述。
構想・architecture・roadmapは今回変更していない。

## 現在の未実施事項

Ghostty単独の実機挙動・211と212の常用環境での利用者確認は未実施。
212のsource commit・常用build・配置は後続指示により実施済み。push・公開は未実施。

## local実経路確認（2026-10-07）

隔離HOME/XDGと一時workspaceで、source CLIのproduction TUIをtmux上に起動した。
実CoreとData／Agent／API Workerを使用し、provider-free child taskとlocal bash toolで確認した。
provider callは0回。端末設定・実config・実dataは変更していない。

- 通常画面を使用し、alternate screen・mouse trackingがoffであることを確認。
  保存した10turnの会話が順番に履歴へ入り、tmux copy-modeで先頭へ移動・選択・コピーできた。
- F4 Session pickerとEscでの復帰、複数行editorのUp/Down、旧入力履歴を呼ばない動作、
  実行中EscでcancelされずF1でcancelできる動作、F2 follow-up／F3 steeringを確認。
- 80行の日本語入り生成中本文と6行draftを表示し、140×30→90×20→140×30へresizeした。
  狭い状態でdraft末尾への追記・Up/Homeから前行の編集ができた。
  本文各行の履歴内出現数はresize前・後・実行完了後とも2回（user入力と進捗表示各1回）で、
  再描画やresizeによる既出本文の再追記は発生しなかった。
- local bashの開始`…`と結果`✓`が履歴へ順次追記され、実stdoutを後続assistant表示で確認。
- `/new`の後、F4 pickerから保存Sessionをviewで開き直した。保存会話をsemantic順で再出力し、
  先頭の保存user行は再表示1回分だけ増えた。長い本文・tool結果・最終回答も再表示された。
- helpの211キー案内と旧操作案内の撤去、Ctrl-Dでのdetachを確認。

再確認可能なlocal evidence（git対象外）: `.tools/increment-212/tmux-result.json`、
`tmux_probe.py`、`core_probe.ts`、`tui-raw.log`。
Ghostty単独はこの環境に実機がなく未確認。通常利用の確認は利用者の指示どおり211・212をまとめて行う。

resizeと旧geometry再描画が重なる問題を観測したため、修正後の同じprobeを3回実行した。
3回とも上記11操作群がPASS、provider callは0回、本文80行の出現数は前・後・完了後とも各2回。
結果は`.tools/increment-212/tmux-result-1.json`〜`tmux-result-3.json`へ保持した。

## focused検証・review結果

- 変更されたTUI経路のfocused testは最終候補で128 pass／0 fail。
  順次出力、長い本文の確定、thinking確定、F2後の累積更新、Markdown table追記、resize、
  tool開始／結果、211入力、picker、Session切替、header更新、shutdownと出力順序を確認した。
  廃止したviewport／retained frame専用testは撤去し、継続するproduct動作は残した。
- 変更された39 TSファイルとsource CLIのtype check、39 TSのformat・lint、`git diff --check`はPASS。
  旧`writeFrame`／`ConversationViewport`／`CoalescingWriter`と旧order-copy補助処理の参照残存はない。
  full gate・メモリbenchmarkは実行していない。
- 独立reviewでthinking label／F2 notice後の本文重複、Markdown tableの既出cell重複、廃止キーのhelp残存を
  P2として採用し修正。一回の限定re-reviewで3件の解消とresizeのreceipt／writer接続を確認した。
  追加findingなし。review後のheader更新と旧geometry再描画の局所修正は親agentが確認し、
  最終focused testと上記tmux実測で検証した。

最終候補の記録: `.tools/increment-212/focused.log`、`static.log`。
通常会話の保存・Core/API/provider契約と非TUIの`run --stream`は変更していない。

## 保存履歴1万行の追加測定（2026-10-07）

利用者の「1万行くらいのテストはできない？」により、隔離HOME/XDG・一時workspaceの
production TUI／実Core／Data・Agent・API Workerで追加測定した。production sourceは変更していない。
provider-free task 20turnを保存し、userとassistant各250行／turn、計10,000行・60 entityを用意した。
保存後にCoreとWorkerを終了して再起動し、別の新規SessionからF4 pickerで保存Sessionを開いた。
初回表示前に再起動後のCoreから対象Session本文をreadしていない。OSのfile cacheはflushしていない。

測定用tmuxは140×30、history-limit 100,000行（隔離tmux serverの設定のみ）。
表示時間はpickerの対象を選択済みの状態から、決定キー送信→最後の本文行・対象Session footerが
表示されたcaptureまでのwall time。tmux command／captureと10ms間隔のpollを含む概測である。

| 操作 | 所要時間 |
| --- | ---: |
| Core再起動後の初回view | 294ms |
| 2回目view | 247ms |
| 3回目view | 251ms |
| view中央値 | 251ms |
| F4 picker読込 | 31〜42ms |
| 表示後の入力→editor表示 | 21〜24ms |
| Rによるresume→本文・Enter submit表示 | 220ms |
| resume後の追加task→回答・ready表示 | 146ms |

初回は本文10,000行、header・label等を含む端末出力10,084行。
5,000種類の番号付き行がuserとassistantへ各1回ずつ出現し、semantic順も一致した。
viewを3回、resumeを1回行った後の履歴でも、各再表示分のみ増えて計40,000本文行となり、
欠落・意図しない重複・順序変更はなかった。resume後の追加taskで新しい回答を確認し、
CoreのactiveSessionIdが保存Sessionであることも確認した。provider callは0回。

このVM／tmuxでのsource TUI測定であり、Ghostty実機や旧実装との速度比較は行っていない。
記録（git対象外）: `.tools/increment-212/large-session-result.json`、`large-run.log`、
`large_core_probe.ts`、`large_session_probe.py`、`large-view-1.txt`〜`large-view-3.txt`。

## tmux履歴上限2,000行の確認（2026-10-07）

利用者の「同じ1万行の履歴で、tmuxの表示を2000行にして直近の履歴だけ表示されているのを確認して」
に従い、同じ内容の20turn・10,000本文行を隔離環境で保存し、Core再起動後にproduction TUIの
F4からviewで開き直した。隔離tmux serverは140×30、`history-limit 2000`をpane作成前に設定した。
通常tmuxの設定、production source、既存の保存dataは変更していない。provider callは0回。

- 実際の`history_limit`は2,000、`history_size`は1,854行。
  表示中30行を合わせたcaptureは1,884行で、そのうち番号付き本文は1,867行。
- 残った本文番号列は、前回の履歴上限100,000行で取得した10,000本文行の末尾と完全一致した。
  最古の残存行は`212-load-04133 日本語の保存会話 17`、最後の行は`212-load-04999`。
  古い先頭`212-load-00000`は端末履歴に残らず、最新行は通常画面で表示された。
- copy-modeでhistory-topへ移動し、さらにscroll-upしても位置は先頭のまま
  （scroll_position=1,854、copy_cursor_y/x=0/0）。その行を実際に選択・copyし、bufferの内容が
  最古の残存行と一致した。`capture-pane`はcopy-modeの表示画面そのものとして扱わなかった。
- その後HTTP APIで保存Sessionのsemantic本文をreadし、10,000行の番号と順序が元の履歴に完全一致する
  ことを確認した。端末履歴上限によって保存会話は削られていない。再表示は約279ms。

tmux 3.5aは上限へ達すると最古の10%（この設定では200行）をまとめて落とすため、
履歴保持数は常にちょうど2,000行ではない。
参照: [tmux 3.5a grid_collect_history](https://github.com/tmux/tmux/blob/3.5a/grid.c#L325-L350)、
[capture-paneの対象grid](https://github.com/tmux/tmux/blob/3.5a/cmd-capture-pane.c#L98-L120)。

記録（git対象外）: `.tools/increment-212/large-scrollback-2000-result.json`、
`large-2000-run.log`、`large_scrollback_2000_probe.py`、`large-scrollback-2000-history.txt`、
`large-scrollback-2000-screen.txt`、`large-scrollback-2000-copied-oldest.txt`。

## Commit・公式build・常用配置（2026-10-07）

利用者の「了解です コミットと配置をお願いします」により実施した。

- source commit: `894aeb0b7188b0688a68a04d6be3aa949d96f1d0`
  （`feat: move TUI conversation history to terminal scrollback (increment 212)`）。
  対象は212のTUI／対応test／診断consumer・increment-212・handoffの44 file。
  作業前から残る文書再配置の差分・未追跡README・`191-result.json`・`__pycache__`は含めていない。
- このcommitから公式`henji:compile`で0.10.0をbuildした（version変更は依頼されていない）。
  209のHTTP API、210のCore、211の入力・キー変更もこの常用binaryに含む。
  `--version`とcompiled Core APIでsource一致・sourceDirty=falseを確認した。
- build ID: `4c7f0dcf40c0fc045bca7210359e5936c3e325fd324c394ea753129904541966`。
  runtime SHA-256: `b5b713ff044fe4dda3fb410c2b71cab4be6956a6d7edcc7b015c31380954ff8f`。
  binary SHA-256: `1d6a50fd701ed61115e983ca635725388344757baf73cc485a48c90d9b8e50c1`。
- `dist/henji`と`/home/agent/.local/bin/henji`へatomic renameで配置し、両方のversionとSHA-256一致を確認。
  旧208 binary（source `c39e39a6`、SHA-256
  `c9ef9beec5cecd88a21a2f377e26b56345afcc2e166cdbb7f46d84c6be2099e5`）は
  `~/.local/bin/henji.previous`と`.tools/increment-212/deployment/henji.local.previous`へ保存した。
  元の`henji.previous`は同directoryの`henji.local.previous.pre212`、旧distは`henji.dist.previous`へ保存。
- 配置binaryを隔離HOME/XDG/workspace・外部DenoのないPATHで実行した。
  local固定catalogのproviderを指定し、task投入・実provider requestは0回。
  compiled Core／Data・Agent・API Worker起動、ready表示、alternate screen／mouse tracking off、
  複数行editorとUp/Home編集、F4 picker・Esc復帰とdraft保持、Ctrl-QでTUI終了・Core exit 0を確認した。
  初回smokeはdriverの期待source SHA誤記で中断し、deployment記録から直接取得するよう直して再実行PASS。
  これによるproduction source／配置binaryの変更はない。
- 既存の稼働Core/TUIは停止・再起動していない。新しいCore/TUIの起動から適用する。
  常用環境・Ghosttyの利用者確認は次の段階。push・公開／releaseは実施していない。

記録（git対象外）: `.tools/increment-212/deployment/build.log`、`deployment.json`、
`deploy_smoke.py`、`smoke.json`、`smoke-tui.txt`、`smoke-picker.txt`、`smoke-editor.txt`。
この配置記録のcommitは文書だけの変更であり、binaryのsourceは上記source commitを指す。

## 配置後の新規Sessionヘッダー重複修正（2026-10-07）

利用者の「新規でセッション開始した時、ヘッダーが重複して表示される」を受け、
既承認の212配置に対する不具合対応として修正・検証した。後続の表示固定指示を含め、commit・再配置まで完了した。

- 配置済みbinary・隔離HOME/XDG・local固定provider・tmuxで`/new`を再現した。
  初回`/new`でヘッダー数が1→3となり、旧Sessionの`new (autosave)`に続いて同じIDの
  `exact session`ヘッダー、その後に新しいIDのヘッダーが出た。実provider requestは0回。
- 新Sessionを開くと旧Sessionがpassive descriptorへ変わり、startupのsessionModeが
  `new`→`exact`、active-only baseInstructionが存在→省略へ変わる。
  同じ表示scopeのこのmetadata変化をヘッダー再出力の判定へ含めていたため、
  新Sessionへ切り替わる前に旧Sessionのヘッダーが追記された。
- この2項目を同scopeのヘッダー再出力キーから外した。表示scope変更時は従来どおり初期ヘッダーを
  最新のstartup情報で出力する。context・skills・タイトルの実際の変更は表示更新を維持する。
- 新しいfocused regressionと既存remote header更新等で15 pass／0 fail。
  対象source・testとCLIのtype check、対象format・lint、`git diff --check`はPASS。
- 修正sourceのproduction TUI＋配置済みcompiled Coreを隔離tmuxで操作し、連続する2回の`/new`で
  ヘッダー数が1→2→3と新Sessionごとに1回だけ増えた。複数行editorとF4／EscもPASS。
  source確認記録は`.tools/increment-212/header-fixed-source/`、修正前の再現記録は`header-fix/`。

先行修正をcommit・build後、以下の追加指示を反映して再配置した。実provider call・push・公開は含めない。

### ヘッダーを表示開始時の情報へ固定（2026-10-07）

利用者がRENAMEでの再出力を観測し、「ヘッダは初期の情報だけ表示でいいよ、更新情報は、
保存履歴から復活する時に更新状態でいい」と指定した。先行修正`e1ac27ea`はbuild済み・未配置の
段階で、この指示を追加の正本要件として採用した。

- 同scopeのmetadata比較キーを廃止し、初回出力済みのbooleanだけを保持する。
  metadata自体の更新・保存は従来どおり行い、scope reset後は最新snapshotからヘッダーを出す。
- 旧remote header更新testは、最新状態の保存Sessionを開く動作へ修正した。
  RENAMEとcontext・skills更新が出力を増やさず、再表示で更新情報を出すfocused regressionも追加した。
- focused test 16 pass／0 fail。変更箇所とCLIのtype check、format・lint、diff checkを完了した。
- source commit `afc75e0bb1d80a9070880ba6161d14d9bdf16927`から公式`henji:compile`で再buildし、
  `dist/henji`と`/home/agent/.local/bin/henji`へatomic renameで再配置した。versionとSHA-256は一致する。
  build ID: `8a1a9e4cfd5d738df1734cf4057bfff88c9bb2c9edb93834c11aedb33c53bc01`。
  runtime SHA-256: `ed9f40278d06e4f5081e3a403c066c47f91be1e0f3006f393b44b3c2c564ed2d`。
  binary SHA-256: `99d2b87b3ba113ac4a6100bae038c6f5b57e77f24723e5afdf335c688d9d512a`。
- 直前の212配置binary（source `894aeb0b`）は`henji.previous`と記録directoryへ保存した。
  その前の`henji.previous`も`henji.local.previous.pre-header-fix`へ保存し、旧binaryを保持した。
- 配置binaryのcompiled Core/TUIを隔離HOME/XDG・外部DenoのないPATH・tmuxで確認した。
  `/rename`でAPI保存titleが更新されても、ヘッダー数は1→1で増えない。
  続く2回の`/new`では1→2→3。F4 pickerから旧Sessionを開き直すと3→4で、最新titleを表示した。
  複数行editorとUp/Home、F4／Escのdraft保持、active Sessionへ戻ってCtrl-Q終了もPASS。
  Coreのsource一致・sourceDirty=false、normal screen・mouse off、Core exit 0を確認した。
  task投入・実provider callは0回。
- 初回smokeはdriverがRENAME完了前の省略可能なtitleを直接参照し、中断した。
  pollingを省略可能なtitleに合わせて修正し、再実行PASS。production変更・再buildはない。
- 常用環境の稼働Core/TUIは再起動していない。新しいCore/TUI起動から適用する。
  利用者による常用環境確認は引き続き待つ。push・公開は実施していない。

記録（git対象外）: `.tools/increment-212/header-fixed-build.log`、
`.tools/increment-212/header-fixed/deployment/deployment.json`、`header_deploy_smoke.py`、
`smoke.json`、`after-rename.txt`、`header-history.txt`、`saved-restored.txt`。
この結果記録のcommitは文書変更だけであり、binaryのsourceは`afc75e0b`を指す。


## 利用者受入と0.11.0公開・配置（2026-10-07）

利用者が通常利用で確認し、「確認しましたよさそうです」と受け入れた。
push、v0.11.0でのJSR公開、常用配置を明示承認した。結果は
[JSR公開記録](../operations/jsr-publish.md#0110-publication--2026-10-07-jst)と
[常用配置記録](../operations/native-0.11.0-deployment.md)へ記録する。
