# Increment 123 — thinking本文の段落と折り返し

状態: local実装・検証完了（2026-09-24）。利用者が本変更をIncrement 123として正式に扱うと決め、通常利用メモS12を採用した。構想・architecture・roadmapは変更していない。commit、push、binary配置、releaseは未実施。

## 必要なproduct動作と根拠

- 長いthinkingをTUIで読んだとき、本文内の段落区切りを残し、幅を超える行は単語の境界で折り返す。thinkingと隣接するtool・回答の間には空行を置き、作業単位を見分けられるようにする。
- thinking本文の意味、semantic履歴、modelへの再送内容は変更しない。回答やtoolの既存表示も変更しない。
- 根拠: 通常利用メモS12のREADME二言語版比較（session `677dbc65`）で、9件のthinkingと13件のtoolが順序どおり残る一方、長文が読みにくかった。利用者はPiとの比較で、特に改行による読みやすさを改善対象として選んだ。
- 参照観測: tmuxのPi v0.87.1でOpenRouterの`deepseek/deepseek-v4.1-flash`（thinking high）に同じREADME比較を依頼した。Piの画面ではthinkingの段落が空行で分かれ、長い行は単語境界で折り返された。記録は`/tmp/henji-pi-thinking-6LQUYMoL/display.txt`。Piの表示色や折りたたみは今回採用していない。

## 現行経路と対象

- providerの可読なthinkingはmodel stepごとの`assistant_thinking` eventになり、`v0/tui/state.ts`が`kind: 'thinking'`のlog entryとして保持する。`v0/tui/layout.ts`は従来、ラベルと本文を結合して文字単位の`wrap`へ渡し、隣接するthinking・tool・回答の間に空行を置かなかった。
- 回答本文は既に`v0/tui/assistant_layout.ts`の単語境界折り返しを通る。thinkingのTUI表示だけに同じ折り返しロジックを使い、行内のMarkdown着色は加えない。
- 対象: `v0/tui/assistant_layout.ts`、`v0/tui/layout.ts`、`tests/v0/tui_conversation_presentation_test.ts`。通常履歴の保存形式と`henji history`表示は対象外。

## 変更内容

- thinking本文用rendererを追加し、元の改行を保ちながら長い行を単語境界で折り返す。表示幅を超える単語だけはセル幅で分割する。
- TUIの会話行を作る際、thinkingと前後のentryの境界に空行を一つ置く。元の本文にある空行も残す。ラベル、tool・回答の順番、semantic本文は保持する。

## 受入確認

- focused testは、README比較を模した長いthinking、本文内の空行、thinking→tool→thinking→回答の並びをTUI行で確認する。表示だけの変更であり、通常履歴の文字列は既存Increment 120 testで確認する。
- 最終コードでTUI conversation、Increment 120 thinking履歴、retained terminalのfocused testは66件成功。`v0:check`、対象fileのformat・lint、`git diff --check`も成功。full gateは実行していない。
- 隔離XDGとtmuxでsourceのproduction TUI（`agent:tui --no-session`）を起動し、localhost模擬Chat providerの可読な`reasoning_content`を表示した。幅100列で長い文が`headings. The`の後の単語境界で折り返され、本文内の空行とthinking・回答間の空行が見えた。画面記録は`/tmp/henji-thinking-tui-LtEYJTsg/display.txt`。実provider callは行っていない。

## 未実施

- 配置済みbinaryへの反映と実providerでの再確認は行っていない。今回のproduct経路確認はsource TUIとlocalhost模擬providerで完了した。
