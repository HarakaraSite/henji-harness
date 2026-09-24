# Increment 124 — 保存Sessionのthinking復元と全履歴の閲覧

状態: 実装・検証・commit・binary配置完了（2026-09-24、利用者確認待ち）。利用者が通常利用メモS15を採用し、計画を承認した。通常実行中の逐次表示はS16として通常利用メモに残す。push・releaseは未実施。

## 必要なproduct動作と根拠

- `/sessions`で保存Sessionを選ぶと、採用済み会話に対応する保存済みthinkingを、発話・tool・回答と同じ時系列で表示する。起動時の保存Session復元も同じ経路を使う。
- 復元画面の100メッセージ／2 MiBという固定切捨てを廃止し、PageUpで古い会話とthinkingへ到達できるようにする。画面描画は必要な範囲だけを処理する。
- 根拠: 現行TUIは通常実行中にthinkingを表示し、`henji history --view session`でも保存済みthinkingを読めるが、復元時にはcanonical transcriptの末尾だけを`restored_log`へ渡していた。利用者はPi・Zotの実装調査を踏まえ、復元履歴の固定切捨てを外す方針を選んだ。
- 対象はcanonical会話に属するthinking。失敗・キャンセルのnoncanonical thinkingは`henji history --view session`から参照できる。

## 実際の経路と変更

- HostのSession復元でcanonical transcriptとsemantic historyのcanonical root executionを結び、model stepごとのthinkingを対応するassistant message位置へ付ける。Presentation adapterを通し、`restored_log`で通常表示と同じthinking行を作る。
- TUIの全entryを保持し、描画用の窓だけを末尾から表示する。PageUp／PageDownで窓を移し、`latest`で現在の末尾へ戻る。復元時の100メッセージ／2 MiB切捨てhelperと、通常ログの512 entry／2 MiB保持上限を除去する。
- 保存形式、modelへの再送内容、`henji history` CLIの表示、通常実行中の逐次更新は変更対象に含めない。

## 受入確認

- 保存thinkingと発話・tool・回答の順番、512 entryを超える復元履歴から先頭へ到達する操作、起動時復元と`/sessions`での復元を確認する。
- focused test、type check、format、lint、`git diff --check`に加え、隔離XDG・tmux上のsource production TUIで保存と復元を確認する。実provider callは行わない。

## 実施結果

- canonical root executionのsemantic thinkingを読み、model stepに対応するassistant messageの前へ挿入した。起動時と`/sessions`の両方がこの復元経路を通る。toolを挟む複数step、thinking summaryのラベル、発話との順序をfocused testで確認した。
- 復元履歴の100メッセージ／2 MiB切捨てhelperを除去した。TUIの通常ログも512 entry／2 MiB保持上限を除去し、全entryを保持したまま描画窓だけを移す。600件を超える復元entryでPageUpから先頭、PageDownから末尾へ到達し、通常ログ520件、復元本文2 MiB超の保持をfocused testで確認した。
- 関連focused test 98件と追加の2 MiB確認1件が成功した。`v0:check`、対象fileのformat・lint、`git diff --check`も成功。full gateは実行していない。
- 隔離XDG・tmuxのsource production TUIでlocalhost模擬Chat providerを1 request使用した。保存時、`/new`後に`/sessions`で選び直した時、`--session`で再起動した時のいずれも`user>`→`thinking>`→`assistant>`の順序とthinking本文の空行を確認した。画面記録は`/tmp/henji-i124-tui-Hh05Ud/{live,restored-picker,restored-startup}.txt`。模擬providerはREADMEの内容を実際には比較していない。実provider callは行っていない。
- 同じ隔離XDGの別Sessionでlocalhost模擬Chat providerを2 request使用し、`read` toolを挟む2 model stepを保存した。`/sessions`復元後も`user>`→`thinking>`→`tool>`→`thinking>`→`assistant>`の順序を確認した。画面記録は同directoryの`tool-live.txt`と`tool-restored-picker.txt`。この回答も模擬応答であり、実際のREADME比較結果を示さない。

## commit・配置

- 実装・test・文書をclean commit `763498f993ead4b10a91dee68df9abf1c6788a12`にまとめ、Deno 2.9.7で`deno task --config deno.v0.json henji:compile`を実行した。build IDは`14fb8dc79165747e52fac31a72eda5697178bed02677bd910ac2bc6999f7ec32`、embedded runtime digestは`fc28255282e6e609388b3386b199e2dea574a08e84511d7db326f4c20e786f66`。
- `dist/henji`を`~/.local/bin/henji`へ同一directory内のstaging fileから原子的に配置した。両fileのSHA-256は`baf500ce44d08be6eeaf593eea85181372555eee0ebeb17679b20ae51fd854d7`で一致。配置先の`--version`は上記source commit・build ID・runtime digestを表示した。
- 配置済みbinaryを隔離XDG・tmuxで起動し、2 model stepの保存Sessionを`--session`で開いた。`user>`→`thinking>`→`tool>`→`thinking>`→`assistant>`の順序を確認した。画面記録は同directoryの`tool-restored-installed.txt`。この起動ではprovider callを行っていない。
- pushとreleaseは行っていない。
