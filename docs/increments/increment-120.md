# Increment 120 — 読めるthinkingを通常履歴に表示

状態: 実装・検証完了。Increment 119の再送経路とは独立した人間向け表示を扱う。

## 必要なproduct動作と根拠

- providerが読めるthinking本文を返したとき、利用者がassistantの作業過程としてTUIと通常履歴で参照できる。要約だけなら「要約」と示す。本文を返さないモデルや暗号化itemには、架空のthinking本文を表示しない。
- OpenRouter Responses経由のDeepSeekは、README比較で読めるreasoningを返した。従来のtool行だけでは、情報を集めた後にモデルが何を判断したか見えなかった。
- thinkingはmodelへのprivate state再送とは別に扱い、model-visible transcriptの文章へ注入しない。stream断片を一件ずつ通常履歴へ永続化しない。

## 現行経路と対象

- provider parserから`ModelResult`／Agent event、Worker→Hostの実行記録、Presentation event、TUI log、`henji history` CLIまでを対象とする。
- 現行の`assistant_progress`にmodel stepはなく、TUIは同じturnのassistant行を更新する。終了時にlive行が消えるため、progressだけではキャンセル・失敗後の履歴にならない。`henji history --view session`はcanonical transcriptだけを描画し、`--view detail`はJSONLである。
- 現行の`listExecutionEvents`はsemantic occurrenceに加えて診断attachmentを全件読み、展開する。通常の`session`表示にこれを直接使うと、大量のSSE断片を読み直す問題が再発する。semantic eventだけを読むAPIとprojectionが必要である。

## 実装計画

1. providerから実際に受け取った可読本文／要約をmodel stepに結び付けたsemanticな観測としてまとめる。Chatの平文とResponsesの読める`content`／`summary`を区別し、暗号化itemは本文扱いしない。
2. 完了したstepのthinkingを一つの作業単位としてdurable historyに残す。途中で失敗・キャンセルしたstepは、観測できた範囲と未完了であることを区別して残す。断片ごとのdiagnostic attachmentへ依存しない。
3. TUIではthinking、tool、回答の順序が保たれ、後続のprogressやfinalでthinkingが消えない行IDと表示を使う。`henji history --view session`はcanonical・noncanonicalの全実行を時系列に表示し、失敗・キャンセルには状態を明示する。`--view canonical`は採用済み会話だけ、`--view detail`はJSONLのままとする。通常表示は診断attachmentを読まない。

## 受入確認

- 読める本文、要約のみ、暗号化itemのみの観測済み応答形で表示を確認する。読めない内容は表示しない。
- tool継続後の回答、キャンセル、失敗で、観測済みthinkingの順序・帰属・参照可能性を確認する。通常履歴の件数がSSE断片数に比例しないことを確認する。
- focused test、type check、format、lintに加え、隔離XDG・tmuxのproduction TUIで表示と履歴参照を確認する。実provider callを伴う確認は対象・回数・保存先を提示して別承認を得る。

## 第三者計画reviewと承認境界

- 全体reviewで「TUIの一時progressだけでは失敗・キャンセル時に消える」と指摘された。本計画ではstep付きsemantic記録とnoncanonicalの読出しを受入条件にした。
- 利用者は可読なthinkingを成功・失敗・キャンセルすべてで表示する方針を確認し、失敗・キャンセルも通常の`session`表示へ含める案を選んだ。architecture正本`docs/architecture/henji-host-agent-worker.md`の意味上の変更は別承認を得て反映した。構想・roadmapは変更しない。

## 実装結果と確認

- Chatの可読な`reasoning`／`reasoning_content`／`reasoning_details`とResponsesの可読なreasoning本文／要約を、model stepごとに一件の`assistant_thinking`として記録する。暗号化itemだけからは表示文を作らない。失敗・キャンセル時は観測済み部分を未完了として残す。モデルへのprivate state再送と通常の会話入力には混ぜない。
- TUIではthinking行を回答・tool行と分け、先にassistant progressが出てもthinkingが回答より前に表示されるようにした。`henji history --view session`は全executionを状態付きで時系列表示し、thinkingをsemantic occurrenceから読む。診断attachmentを展開しない。`canonical`と`detail`の表示経路は維持した。
- focused testはIncrement 120が5件、Chat providerのIncrement 101が17件、Responsesを含むIncrement 14が25件、provider stream compatibilityが20件、既存history CLIが5件、TUI conversation／retained terminalが58件成功。`v0:check`、`v0:lint`、`git diff --check`成功。
- 隔離XDGのproduction TUIをtmuxで起動し、localhostの模擬Chat providerで成功とキャンセルを確認した。成功時は`thinking>`が`assistant>`の前に表示され、`history --view session`も同じ順序だった。reasoning送信後に応答を待たせてEscでキャンセルすると、TUIに`thinking~`と`failure> cancelled`が残り、通常履歴にも`non_canonical · cancelled`と未完了thinkingが残った。実provider callは行っていない。
