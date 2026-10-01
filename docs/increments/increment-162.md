# Increment 162 — コマンドピッカーの英語表記

更新日: 2026-10-01

ステータス: **利用者確認・完了承認済み（2026-10-01）。Increment 162は完了。**
local実装・検証・常用配置・配置後確認を完了した。
利用者の「確認しました両インクリメントを完了とします」により完了承認を取得した。

## 目的と範囲

利用者の「コマンドピッカーに日本語表記がある、『一覧』とか英語表記に統一したい」により採用。
コマンドの説明、usage欄のショートカット表記、ショートカットなしの表記を英語に揃える。
説明を共有する`/help`も同じ英語の操作名・キー説明・表見出しへ揃える。
操作・キー・API・保存状態は変更しない。構想・architecture・roadmapの意味変更は不要。
直前までの配置指示とUI修正の継続として、local変更と検証、常用配置、配置後確認を行う。
追加指示「read toolも統一しよう」によりread tool向け内部指示の英訳も対象へ追加した。
commit/push・公開・実provider callは未指示。

## 現行経路と計画

`/`入力 → remote TUIのcommand候補取得 → `SLASH_COMMANDS` → rendererのslash picker →
`layoutUi`のusage・description・候補行 → terminal。
`/help`は同じ`SLASH_COMMANDS`と`SHORTCUT_ONLY_OPERATIONS`を表にする。
Coreや保存履歴に表示文言を所有させず、既存TUIの表示定義を修正する。

- `Session一覧`を`List sessions`、`model選択`を`Select model`等の短い操作説明へ変更する。
- `Enter（Session picker）`を`Enter (Session picker)`、`対応なし`を`none`へ揃える。
- 共通helpの操作説明・見出しも英語へ変更する。
- 変更した表示を期待する既存assertionを更新し、対象のfocused test、type check、format、lint、
  diff checkを行う。full gateは今回の文言変更に含めない。
- 隔離HOME/XDG/workspace/tmuxのproduction TUIで、コマンド一覧、候補選択・補完、
  `/help`、狭い画面の表示を確認してから配置し、配置後も同じ経路を確認する。
  外部providerへrequestしない。

## 検証と結果

表示の英語統一と既存操作の維持を確認する。変更前に確認できた日本語の発生元は
`slash_command.ts`の説明・shortcut・help表と`layout.ts`のshortcutなし表記。
実端末での英語文言と折り返しは検証前には未確認。


### 実装とfocused確認

全14コマンドのdescriptionとshortcutを英語へ変更し、shortcutなしは`none`と表示する。
`/help`で共有する操作名・キー説明・表見出しも英語へ統一した。
操作、入力event、Core/API、保存状態は変更していない。

既存の英語表示期待を更新して、remote TUI、command補完、retained terminal・helpのfocused
38件pass。production CLIのtype check、変更TSのformat・lint、diff checkもpass。
新しいtestは文言変更のために追加していない。full gateは計画どおり実行していない。

### production TUIと配置

公式build scriptのcandidateと配置後の常用binaryを隔離HOME/XDG/workspace/tmuxで確認した。
全14コマンドの選択時の英語説明、`none`とshortcut欄、prefix検索、Tab補完、
`/sessions`実行、`/help`の先頭から最後の操作まで、40列のpickerを確認した。
Ctrl-QでTUI/Coreともexit 0。確認用Core/TUI/tmuxは終了。provider requestは0。

旧binaryは`henji.previous`へ保存し、操作確認済みcandidateを常用先へrenameした。
配置後のversionとbinary digestはcandidateと完全一致。実config・実Session・既存Coreは変更していない。
新しい通常起動から英語表記になる。

- 配置先: `/home/agent/.local/bin/henji`
- version: `henji 0.8.0`
- source: `85256f4e…+dirty`（commit/pushは未指示）
- build ID: `5084e0725fed2f67402fff836c9f08aa055c2971ef17bc20953256b7f7cdffbc`
- runtime digest: `49ea1b47b0fb2769db1bbfc8ecf4ac496c5d57c6cc7cbd2381d39992366bfd7f`
- binary digest: `33a41b1959d8f0fddb066c6031c3a059b6016173605f70482b346550e2b4f5ac`

証拠・旧binaryの保存先:
`/home/agent/.local/state/henji-build-artifacts/increment-162-20261001/`。
配置前のcaptureは`tmux-202986/`、配置後は`tmux-203190/`。
配置記録は`deployment.json`、操作結果は`tmux-results.json`。

### 他の日本語表記の確認

利用者の「他に日本語表記の混ざっている箇所はない？」に対して追加調査した。
`v0/tui`、`v0/agent/cli`、`v0/presentation`のsourceには日本語文字列の残りはない。
`v0`全体のTypeScriptで残る日本語は`v0/agent/tools/file_tools.ts:74`のread tool向け
内部promptGuidelines一箇所。TUIの固定表示ではなく、今回変更していない。
利用者の本文・Session title・外部catalog由来の名前は固定UI文言の調査対象に含めない。


### read toolの内部指示も英語へ統一・再配置

追加指示「read toolも統一しよう」に従い、`file_tools.ts`のpromptGuidelinesを英訳した。
意味は「File調査はbashのcat/sedよりreadを優先し、続きをoffset/limitで読む」のまま。
read toolのexecute・引数・result contractは変更していない。

既存のactive tool guidelines testを英語文言へ更新し、materializeされたread toolから
親・reviewer compositionのsystem instructionに指示が組み込まれることを確認した（1件pass）。
production CLIのtype check、変更TSのformat・lint、diff checkもpass。
`v0/**/*.ts`を再検索し、日本語文字列の残りは0。
この検索はsourceの固定文言を対象とし、利用者の本文・title・外部データの言語は対象にしない。

新candidateと配置済みbinaryを隔離HOME/XDG/workspace/tmuxで起動し、Core/TUIの正常起動、
英語command picker、Ctrl-QでTUI/Coreともexit 0を確認した。provider requestは0。
モデルによる英語指示の効果測定は行わない。Agentへの指示の組込みは上記focused testで確認した。
確認用Core/TUI/tmuxは終了。実config・実Session・既存Coreは変更していない。

操作確認済みcandidateを常用先へ配置し、versionとbinary digestが一致することを確認した。
直前のbinaryは`read-english/henji.previous`へ保存。新しい通常起動から適用する。

最新build ID: `a9e40f9ac82cab7b2ec8b90c6ed12deb38ddadd22bc8ecf40ef23b01e9feb87f`。
最新runtime digest: `fd856bb1ea287163f41281c1306697529eb62a16fe71bf7dcf9f5a239a428421`。
最新binary digest: `3ad993449078cd27a5ee2a72fe4808a7e260b4b0f7a7608cc9001a0cb3e14ff6`。
sourceは引き続き`85256f4e…+dirty`。commit/push・公開は未指示。

証拠は`/home/agent/.local/state/henji-build-artifacts/increment-162-20261001/read-english/`。
配置前captureは`tmux-203760/`、配置後は`tmux-203833/`。
最新の配置記録は`deployment.json`、起動結果は`tmux-results.json`。
