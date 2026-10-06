# Increment 207 — TUI入力: Shift+Enterで改行（tmux経路の拡張キー）

状態: local実装・検証済み、利用者受入待ち。source commit・公式build・常用配置・push・利用者環境の
tmux設定変更は未実施。

## 利用者が必要とする動作と根拠

利用者指示（2026-10-07、本会話）:

> 次に現環境　ghosttty(mac) > ssh > vm(debian) > tmux　では入力時に改行がopt + enterでしかできない
> shift + enterもできるようにしたい

必要な動作は「TUIの入力欄で、Shift+Enterがsubmitではなく改行として働く」ことである。この指示は
repository文書に未記録であり、会話の利用者指示として扱う。通常利用メモの候補採用ではない。

実行環境の実測（2026-10-07、本VM）:

- tmux 3.5a。`~/.tmux.conf`は`extended-keys on`、`extended-keys-format csi-u`、`mouse`、
  `history-limit`を設定済みで、`terminal-features`のextkeys指定はない。
- 稼働中のclientは`xterm-256color`で、`#{client_termfeatures}`は
  `bpaste,ccolour,clipboard,cstyle,focus,title`（`extkeys`なし）。
- 稼働中のpane（bash・旧Henji）の`#{pane_key_mode}`は`VT10x`。

## 現行product経路（2026-10-07、source照合）

- 入力解析は`v0/tui/input_decoder.ts`が唯一の実装である。CR/LFは`enter`（submit）、`ESC CR`と
  `CSI 27;3;13~`（xterm modifyOtherKeysのAlt+Enter）は`alt_enter`、`CSI 13;2u`／`13;3u`／`13;5u`
  （CSI-u形式のShift/Alt/Ctrl+Enter）は`newline`として復号する。
- `v0/tui/remote_session.ts`の`applyEditorEvent`は`newline`・`alt_enter`でエディタへ`\n`を挿入し、
  `enter`はsubmitとして扱う。
- 端末制御は`v0/tui/terminal.ts`の`TerminalLifecycle`が所有する。`acquire()`でalternate screen・
  bracketed paste・cursor styleを書き、`restore()`で戻す。拡張キー（modifyOtherKeys／Kitty keyboard
  protocol）の要求・復元は実装していなかった。
- したがって、Shift+Enterを区別するキーボードprotocolを端末へ要求していないため、端末はShift+Enterを
  Enterと同じCRとして送り、TUIはsubmitと解釈していた。Opt+Enterだけが改行になるのは、Alt+Enterが
  legacyの`ESC CR`として届き既存の`alt_enter`経路に入るためである。
- Kitty keyboard protocolを使う端末（Ghostty等）も、アプリが`CSI > 1 u`等で要求しない限りShift+Enterを
  区別して送らない。tmux 3.5aのman pageは`extended-keys on`でpane内のprogramがmode 1/2を要求でき、
  modeは`#{pane_key_mode}`で観測できると説明する。tmux 3.5aにkitty protocol用optionはない（man page・
  client featuresの実測）。

## 変更（2026-10-07、local）

1. `v0/tui/terminal.ts`: `acquire()`で`CSI > 4 ; 1 m`（xterm modifyOtherKeys mode 1）を要求し、
   `restore()`で`CSI > 4 ; 0 m`を返す。bracketed pasteと同じ「先に状態をmarkしてから書き、
   best-effortで一度だけ戻す」形にした。mode 1は「well-known representationを持たないキー」だけを
   修飾付きで報告する。mode 2は全キーをCSI-u化するため、通常文字入力が`unknown`になる現行decoder
   では入力が壊れる。よってmode 1を要求する。
2. `v0/tui/input_decoder.ts`: xterm modifyOtherKeys形式の`CSI 27;2;13~`（Shift+Enter）と
   `CSI 27;5;13~`（Ctrl+Enter）も`newline`へ復号する。CSI-u形式とlegacyの`ESC CR`は既存のまま。
   tmux経路ではtmuxがpaneの要求形式（`extended-keys-format csi-u`）へ変換するが、tmuxを介さない
   直接接続では端末がxterm形式で報告するため、両形式を受理する。
3. test: `tests/v0/keymap_readline_test.ts`のmodified Return testへxterm形式2件を追加し、
   `tests/v0/tui_retained_terminal_test.ts`へ`terminal lifecycle requests extended keys and restores
   the previous mode`を追加した。

## 確認（2026-10-07、local）

- focused: `tests/v0/keymap_readline_test.ts`・`tests/v0/tui_retained_terminal_test.ts`は36件pass
  （新規test 1件と既存testの拡張を含む）。`agent:increment-74-terminal-write:test` 6件、
  `agent:increment-155-tui-shutdown:test` 2件もpass。`v0:check`・`v0:fmt`・`v0:lint`・
  `git diff --check`はpass。full gateは実行していない。
- tmux層の実測（外側端末をptyで模擬、private tmux server、`.tools/increment-207/tmux-key-probe.py`）:
  - paneが`CSI > 4 ; 1 m`を送ると`#{pane_key_mode}`は`Ext 1`になる（tmuxがpaneのmode 1要求を受理）。
  - 外側端末から`CSI 27;2;13~`（Shift+Enter）を送ると、要求したpaneへは`CSI 13;2u`として届く。
    Enterは`0d`として届く。`extended-keys-format csi-u`が効いている。
  - tmuxが外側端末へ拡張キーを要求するのは、`terminal-features`に`extkeys`があり、外側端末がDAに
    応答した場合だけで、そのとき`CSI > 4 ; 2 m`を送る。`extkeys`なしではDA応答があっても送らない
    （4条件の比較は`tmux-key-probe.json`）。
- production TUI確認（隔離HOME/XDG、`.tools/increment-207/henji`＝現行sourceから`henji:compile`、
  local provider、実provider call 0回、tmux 3.5a private server、clientはDAに応答する外側端末を
  ptyで模擬）:
  - 起動中の`#{pane_key_mode}`は`Ext 1`。この変更前の実Core/TUI paneは`VT10x`だった。
  - `alpha`→Shift+Enter（外側形式`CSI 27;2;13~`）→`beta`で、エディタは`> alpha`と`> beta`の2行に
    なり、submitは発生しなかった（`user`行は現れない）。
  - Enterで`alpha\nbeta`が1メッセージとしてsubmitされ、transcriptに`user> alpha`と継続行`beta`が
    現れた。local providerは接続失敗（設計どおり）。
  - Ctrl-Q終了後の`#{pane_key_mode}`は`VT10x`へ戻る（復元）。
  - 証拠: `.tools/increment-207/tui-probe.json`、`tui-probe.txt`、`tui-core.log`、
    `tmux-key-probe.json`、`tmux-key-probe.log`。build logは`build.log`。
- 未確認: Ghostty実機（macOS）での挙動。GhosttyがmodifyOtherKeys mode 1/2に対応し、Shift+Enterを
  `CSI 27;2;13~`として送ることは公式repositoryの議論と実装記述に基づく推論であり、このVMからは
  検証できない。tmuxを介さない直接接続の経路も同じ理由で未検証である。

## 利用者側に必要な設定（提案、未実施）

- `~/.tmux.conf`へ次の1行を追加する。client TERM（`xterm-256color`）に一致させる。

  ```tmux
  set -as terminal-features 'xterm*:extkeys'
  ```

  `-a`（append）が必要である。`terminal-features`はserver optionで、`-g`で設定するとtmux組み込みの
  既定エントリ（`xterm*:clipboard:ccolour:cstyle:focus:title`、`screen*:title`、`rxvt*:ignorefkeys`）を
  置き換えてしまうことを実測した（`set -as`は追記、`set -g`は置換）。
- 反映手順（実測に基づく）: 追記後、tmux clientをすべてdetachして`tmux kill-server`し、tmux serverを
  起動し直す。このfeatureはserver起動時に有効でないと効かない。
  （2026-10-07: 利用者が`~/.tmux.conf`へ追記済み。稼働中serverの再起動待ち。）
  - 実測: 設定ファイルに書いてserver起動 → client attach（DA応答あり）時にtmuxが外側端末へ
    `CSI > 4 ; 2 m`を送り、paneがmode 1を要求すると`#{pane_key_mode}`が`Ext 1`になる。
  - 実測: 稼働中serverへ`source-file`で追加 → 既存clientのfeaturesは変わらない。detach/attach後は
    `#{client_termfeatures}`に`extkeys`が現れるが、外側端末への要求は送られず、paneのmode 1要求も
    受理されない（`#{pane_key_mode}`は`VT10x`のまま）。`refresh-client`でも同じ。
- 併せて、新binaryでのTUI起動が必要である（変更前のTUIは拡張キーを要求しない）。
- 確認方法: `tmux show-options -s | grep terminal-features`に`xterm*:extkeys`があること、
  `tmux list-clients -F '#{client_termfeatures}'`に`extkeys`があること、新TUI起動中に
  `tmux display-message -p '#{pane_key_mode}'`が`Ext 1`であること。
- 影響範囲の実測: 拡張キーを要求しないpaneは`VT10x`のままで、外側端末からの`CSI 27;2;13~`は`0d`
  （通常のEnter）に落ちる。bash等の既存paneの入力は変わらない。
- Ghostty側の設定追加は不要の見込み（modifyOtherKeys対応。要求はtmuxが行う）。macOSのOpt+Enter
  （legacy`ESC CR`）は従来どおり改行として動く。
- 証拠: `tmux-key-probe.json`、`cfg-refresh-probe.json`、`cfg-refresh-with-pane-probe.json`、
  `enable-on-demand-probe.json`、`nonrequesting-pane-probe.json`。

## 承認境界

- 構想・architecture・roadmapは変更しない。通常利用メモの候補追加・採用は行わない。
- 実provider call、commit、公式build、常用配置、push、利用者環境（`~/.tmux.conf`・Ghostty設定）の
  変更は未実施であり、それぞれ利用者指示を必要とする。
