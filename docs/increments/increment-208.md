# Increment 208 — TUI: マウススクロールで会話履歴を参照する

状態: local実装・検証完了（2026-10-07）。source commit・公式build・常用配置・pushは未実施で、
それぞれ利用者指示を必要とする。full gateは実行していない。

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
  `increment_141_remote_tui_test.ts`の3file 45件pass（新規testと既存testの拡張を含む）。
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

## 承認境界

- 構想・architecture・roadmapは変更しない。通常利用メモの候補追加・採用は行わない。
- source commit・公式build・常用配置・push・公開/release・実provider callは未実施であり、
  それぞれ利用者指示を必要とする。
- 通常利用（Ghostty > ssh > tmux）でのwheel履歴参照の確認は利用者に委ねる。
