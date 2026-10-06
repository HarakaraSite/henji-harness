# Increment 208 — TUI: マウススクロールで会話履歴を参照する

状態: local実装・検証・source commit・公式build・常用配置・配置後smoke・利用者受入（2026-10-07、
Shift+ドラッグ運用）まで完了。pushは2026-10-07の利用者指示で実施済み。full gateは実行していない。

## 利用者が必要とする動作と根拠

利用者指示（2026-10-07、本会話）:

> 次は、　今はページアップダウンでやっている履歴参照をマウススクロールでもできるようにしたい

必要な動作は「TUIの会話表示で、マウスホイールの上下がPageUp／PageDownと同じ履歴参照として働く」
ことである。この指示はrepository文書に未記録であり、会話の利用者指示として扱う。通常利用メモの
候補採用ではない（mouse wheelは過去のincrement 3・4・30・43で対象外とされた記録があり、今回の
利用者指示で初めて対象になる）。

## 現行product経路（2026-10-07、source照合）

- 入力解析は`v0/tui/input_decoder.ts`が唯一の実装である。PageUp／PageDownは`CSI 5~`／`CSI 6~`を
  `page_up`／`page_down`へ復号する。mouseの復号は存在しなかった。
- `v0/tui/remote_session.ts`のmain loopは`page_up`／`page_down`を`renderer.scrollPage('up'|'down')`へ
  渡す。busy中も同じ経路で履歴を移動し、履歴中のEscはlatestへ戻る。
- 端末制御は`v0/tui/terminal.ts`の`TerminalLifecycle`が所有する。`acquire()`でalternate screen・
  bracketed paste・modifyOtherKeys・cursor styleを要求し、`restore()`で戻す。mouse reportingは
  要求していなかったため、端末はmouseイベントを送らず、tmuxの`mouse on`ではwheelがtmuxの
  copy-mode scrollbackへ入るだけでTUIには届かなかった。
- `TerminalLifecycle`は`runRemoteTui`だけが使う。`henji run --stream`等の非TUI経路はこの変更の
  影響を受けない。

## 外部契約（xterm mouse reporting）

- DECSET 1000（normal tracking）はbutton press/releaseとwheelを報告する。DECSET 1006（SGR）は
  `CSI < Cb ; Cx ; Cy M`（press）／`m`（release）形式でbutton codeと座標を曖昧さなく報告する。
  wheel upは`Cb=64`、wheel downは`Cb=65`（xterm ctlseqs）。
- 1006を解さない端末は1000のlegacy形式`CSI M Cb Cx Cy`（`Cb = 32 + event code`、wheel upは96、
  wheel downは97）を送る。payloadを消費しないと3byteが本文入力として混入するため、decoderは
  legacy形式も1イベントとして消費する。
- tmux 3.5aの実測（`.tools/increment-208/tmux-forward-probe.py`／`tmux-forward-probe.json`）:
  paneが`CSI ?1000h CSI ?1006h`を書くと`#{mouse_standard_flag}`=1・`#{mouse_sgr_flag}`=1になり、
  外側端末から注入したSGR wheelイベントは`CSI <64;10;10M`のままpaneへ転送された。tmuxは
  paneのmouse mode要求に従ってwheelをアプリへ渡す。

## 変更（2026-10-07、local）

1. `v0/tui/input_contract.ts`: `InputEvent`へ`wheel_up`／`wheel_down`を追加した。
2. `v0/tui/input_decoder.ts`:
   - SGR形式`CSI < Cb ; Cx ; Cy M|m`を復号し、`Cb=64`→`wheel_up`、`Cb=65`→`wheel_down`、
     その他のbutton／releaseは`unknown`（本文へ混入させない）。wheel判定は最初のparameter
     （button code）だけを使い、座標fieldの内容は検証しない。
   - legacy形式`CSI M`の後続3byteを1イベントとして消費し、wheel code 64／65だけをwheelとして
     復号する。未完のpayloadは`end()`で`InputDecodeError`の対象にした。
3. `v0/tui/terminal.ts`: `acquire()`で`CSI ?1000h CSI ?1006h`を要求し、`restore()`で
   `CSI ?1006l CSI ?1000l`を返す。paste・extended keysと同じ「先に状態をmarkしてから書き、
   best-effortで一度だけ戻す」形にした。mouse無効化はalternate screen退出より前に行う。
4. `v0/tui/remote_session.ts`: main loopで`wheel_up`→`scrollPage('up')`、`wheel_down`→
   `scrollPage('down')`を`page_up`／`page_down`と同じ分岐に追加した。1 wheelイベントは1ページで、
   既存のPageUp／PageDownと同じ位置・同じfooter（`history n/N · Esc latest`）になる。overlay
   （help・picker等）のwheelは対象外で、従来どおり無視される。
5. test: `tests/v0/keymap_readline_test.ts`へSGR wheel／legacy消費のtestを、
   `tests/v0/tui_retained_terminal_test.ts`へmouse modeの要求・復元testを、
   `tests/v0/increment_141_remote_tui_test.ts`へbusy中のwheel paging stepを追加した。

## 確認（2026-10-07、local）

- focused: `keymap_readline_test.ts`8件・`tui_retained_terminal_test.ts`・
  `increment_141_remote_tui_test.ts`の3file 45件pass（新規testと既存testの拡張を含む）。関連testは
  `increment_74`・`increment_155`・`increment_146`・`increment_194`の10件と、`increment_140`・
  `increment_142`・`increment_143`・`increment_144`・`increment_170`の15件もpass。
  `v0:check`・`v0:fmt`・`v0:lint`・`git diff --check`はpass。full gateは実行していない。
- tmux production TUI確認（隔離HOME/XDG/workspace、local provider＝接続失敗endpoint、実provider
  call 0回、tmux 3.5a private server、`mouse on`、clientはDAに応答する外側端末をptyで模擬、
  `.tools/increment-208/tui-mouse-probe.py`）:
  - 新binary（本変更、build ID `7294a33d7482b358c59fee58aea16e9720a0077f564e69a43d7f8c1cdca262d2`、
    SHA-256 `f11d26a86721eb9c4f22f3afeac87540140e348e6a9baa1026f8a6face050ee1`）:
    - 起動中の`#{mouse_standard_flag}#{mouse_sgr_flag}`は`11`。外側端末への`?1000h`／`?1006h`の
      要求も観測した（tmuxがpaneの要求を外側端末へ中継）。
    - 外側端末から`CSI <64;10;10M`（wheel up）で表示が12 taskの最新からtask 1〜6の履歴へ移動し、
      footerは`history 4/28 · Esc latest`になった。このとき`#{pane_in_mode}`は0で、tmuxの
      copy-modeには入っていない。
    - `CSI <65;10;10M`（wheel down）で最新追尾へ戻り、footerは`Enter submit`へ戻った。
    - click（`CSI <0;10;10M`／`m`）は無視され、draft `mouse draft`は変化せず、payloadが本文へ
      混入しないことを確認した。
    - Ctrl-Q終了後の`#{mouse_standard_flag}#{mouse_sgr_flag}`は`00`（復元）。
    - 証拠: `.tools/increment-208/tui-mouse-probe-new.json`／`tui-mouse-probe-new.txt`。
  - 変更前binary（常用0.10.0、SHA-256 `5404a60920d942cacbf9d1d7548fe0bad1578c2a9136d2a27daf3bcd27fbb2c3`）:
    - 起動中のmouse flagsは`00`で、wheel upで`#{pane_in_mode}`=1（tmux copy-mode）になり、TUIの
      表示は変化しなかった（履歴footerは現れない）。
    - 証拠: `.tools/increment-208/tui-mouse-probe-old.json`。
- 未確認: Ghostty実機（macOS）でのwheel→SGR送出。Ghosttyの公式repository（commit `51ed437c`時点、
  2026-10-07に確認）は`src/terminal/mouse.zig`でnormal（1000）とSGR（1006）をmodeとして持ち、
  `src/input/mouse_encode.zig`でwheel four／fiveをbutton code 64／65としSGR形式
  `CSI < code ; x ; y M`を書くと実装している。ただし実機のGhostty→ssh→tmux経路そのものは
  このVMからは検証できない。実provider callは行っていない。

## 独立review（2026-10-07）

reviewer agent（read／search／git_inspectのみ、test実行なし）が未commit diff・変更後source・本文書・
probe artifactを読んで独立reviewした。製品correctnessのfindingはなし。確認された点: wheelは
PageUp／PageDownと同じ`scrollPage`分岐に入りbusy gateがない、overlay・draft・pickerと干渉しない、
SGR／legacyのpayloadが本文へ混入しない、acquire／restoreが順序・冪等・partial failureを含めて
整合する、既存key復号は追加のみで回帰しない、testは実byte列と実`runRemoteTui` loopを使う。

finding未満のnoteとして記録した事項: malformed SGRの座標fieldは検証しない（本文書の表現を実装に
合わせた）、legacy `CSI M`が50ms以上分断された場合のpayload混入windowは端末が1 writeで送るため
到達しない、split testは明示timestampにした、clickはアプリ所有になりterminal選択はoverride
gesture依存、wheel 1イベント＝1ページでtrackpad burstは複数ページになり得る、`/help`のkey表示は
PageUp／PageDownのまま。reviewerはtest実行・`v0:check`／fmt／lintの再現をしておらず、それらは
実装側の記録である。

## 意図的な非変更

- footer・`/help`のkey表示は`PageUp/PageDown`のままとする（mouseは追加入力で、既存表示は誤りでは
  ない）。mouseをhintへ併記するかは利用者判断とする。
- help overlay・picker・`henji run --stream`のmouse操作は対象外。
- architecture正本（`docs/architecture/henji-host-agent-worker.md`）のPageUp／PageDown記述は現行の
  ままでも成立するため変更しない。mouse wheelを明記する場合は正本変更の承認が必要である。

## Commit・公式build・常用配置結果（2026-10-07）

利用者指示（2026-10-07、本会話「commi　常用配置」）により、commit・公式build・常用配置を実施した。

- source commit: `c39e39a6f858dd93a9cc35bd43a732f8f81b4a08`
  （`feat: page TUI history with the mouse wheel`）。`v0/tui` 4file・tests 3file・increment-208・
  handoffの9 fileで、既存の未追跡`191-result.json`と`scripts/diagnostics/__pycache__/`は含めていない。
- このcommitから公式`henji:compile`で0.10.0をbuildした。build ID:
  `a4f8394f15077090cf805eec80ba2adf330423dbca057c7ef6b729a99b2b6396`、embedded runtime digest:
  `1f1908e2a95df0ecb01152119fe2f4ec143b6fe19e3f5d9f04766b58c489f970`。`--version`は
  `source=c39e39a6f858dd93a9cc35bd43a732f8f81b4a08`（`+dirty`なし＝sourceDirty=false）。
- `dist/henji`と常用`~/.local/bin/henji`へatomic renameで配置し、binary SHA-256
  `c9ef9beec5cecd88a21a2f377e26b56345afcc2e166cdbb7f46d84c6be2099e5`の一致を確認した。
- 直前の常用binary（0.10.0 pre-208、SHA-256 `5404a60920d942cacbf9d1d7548fe0bad1578c2a9136d2a27daf3bcd27fbb2c3`）
  を`~/.local/bin/henji.previous`と`.tools/increment-208/deployment/henji.local.previous`へ保存し、
  元の`henji.previous`（207版、SHA-256 `e6a548c89d9acaf58bf01f1b28c4cc6152fb4179011110bd5bf4a8b6625f9a98`）を
  `.tools/increment-208/deployment/henji.local.previous.pre208`へ保存した。
- 配置後smoke（隔離HOME/XDG/workspace、local provider、実provider request 0回）:
  `deploy-smoke.py`でCore＋TUIを起動し、`● ready`表示、Ctrl-QによるTUI終了、Core exit 0を確認した
  （`.tools/increment-208/deployment/smoke.json`・`smoke-tui.txt`）。さらに配置binaryで
  `tui-mouse-probe.py`（PROBE_LABEL=deployed）を再実行し、mouse flags `11`、wheel upで
  `history 4/28 · Esc latest`、wheel downで最新復帰、click無視とdraft保持、終了後flags `00`を確認した
  （`.tools/increment-208/tui-mouse-probe-deployed.json`）。
- 稼働中の実Core/TUIは配置前binaryのままで、停止・再起動していない。
- 2026-10-07の利用者指示で`origin/main`へpush済み（`83b05023`・`c39e39a6`・`bad4381c`・`1cffe8b0`）。
  公開/releaseは実施していない。

## 配置後の利用者観測（2026-10-07）: 素のドラッグでコピーできない

利用者報告（2026-10-07、再起動後）: wheel履歴参照は動作したが、マウスドラッグでのコピーが
できなくなった。

原因（tmux 3.5a実測）: TUIが`?1000h`／`?1006h`を要求したため、tmuxはpaneのmouse modeを優先し、
mouseイベントをアプリへ転送する（root binding `MouseDrag1Pane`／`WheelUpPane`の`mouse_any_flag`分岐）。

- `.tools/increment-208/tmux-select-probe.py`（private server、外側端末をptyで模擬）:
  paneが`11`の間はplain dragがアプリへ転送され（app受信を実測）、tmuxのcopy-mode（prefix+[）中でも
dragはアプリへ届く。paneが`00`（変更前相当）ならdragはtmuxへ入り、releaseでtmuxバッファへ
コピーされる（s2）。
- `.tools/increment-208/tmux-copy2-probe.py`: paneが`00`ならdrag選択が成立しreleaseでbuffer
`alpha`が得られる（s5）。paneが`11`でも、キーボードのcopy-modeは機能する（s6: `C-Space`→`Down`→
`M-w`で選択コピー、emacs mode-keys既定。Enterはemacsでは未binding）。
- tmux自身のコピーは`set-clipboard external`でもOSC 52で外側端末へ送られる
  （`tmux-copy3-probe.py` A: buffer `alpha`とOSC 52送出）。変更前はドラッグ→tmuxバッファ＋
  Ghosttyクリップボードが成立していた。
- アプリからのOSC 52は`external`／`off`では無視され、`on`でのみバッファ化＋外側端末へ転送される
  （`tmux-osc2-probe.py`、tmux man・source `input_osc_52`の`state != 2`）。
- Ghostty側の契約（ghostty(1) man、Arch man mirror）: `mouse-shift-capture`既定false＝Shiftは
  アプリへ送られず選択拡張に使われる、`copy-on-select`既定true（Linux/macOS）、
  `clipboard-write`は既定で許可、`mouse-reporting`は`toggle_mouse_reporting` keybindで実行時解除
  可能。Ghostty実機（macOS）での確認はこのVMからは未実施。

現時点の回避経路: GhosttyのShift+ドラッグ（Ghostty自身の選択、copy-on-selectでクリップボードへ）か、
tmuxのキーボードコピー（`prefix + [`→移動→`C-Space`→移動→`M-w`→`prefix + ]`）。

改善案（今回不採用・将来の候補）:

1. 変更なし（Shift+ドラッグ運用。`/help`への追記は行わない）。
2. TUIに一時的なmouse解放コマンドを追加する（解放中は素のドラッグでtmux選択、wheel履歴参照は無効）。
3. TUI内でドラッグ選択＋OSC 52コピーを実装する（素のドラッグでコピー、wheel維持）。tmux側を
   `set -g set-clipboard on`へ変更すればmacOSクリップボードまで届く（実測済み）。

この節の追記ではproduct source・runtimeを変更していない。

## 利用者受入（2026-10-07）

利用者が実環境（Ghostty > ssh > tmux、再起動後の常用binary）でmouse wheelによる履歴参照を確認し、
本incrementを「Shift+ドラッグ運用」で受入した。

- wheel履歴参照（PageUp／PageDown相当）は動作する。
- TUIがmouseをcaptureしている間、端末標準のドラッグ選択は使えない。テキスト選択・コピーは
  GhosttyのShift+ドラッグ（Ghostty自身の選択、`copy-on-select`既定trueでクリップボードへ）または
  tmuxのキーボードcopy-mode（`prefix + [`→移動→`C-Space`→移動→`M-w`→`prefix + ]`）を使う。
- 「配置後の利用者観測」の改善案2（mouse一時解放）・3（アプリ内選択＋OSC 52）は今回採用しない。
  将来必要になった場合の候補として同節に残す。
- `/help`等へのmouse/コピー手順の追記は行わない（利用者指示なし）。

この受入ではproduct source・runtimeを変更していない。

## 承認境界

- 構想・architecture・roadmapは変更しない。通常利用メモの候補追加・採用は行わない。
- source commit・公式build・常用配置・pushは利用者指示により実施済み。公開/release・実provider callは
  未実施であり、それぞれ利用者指示を必要とする。
- 利用者は2026-10-07に実環境（Ghostty > ssh > tmux）でwheel履歴参照を確認し、mouse capture中の
  素のドラッグコピー不可を仕様（選択はShift+ドラッグまたはキーボードcopy-mode）として受入した。
