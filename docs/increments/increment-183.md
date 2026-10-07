# Increment 183 — S26 CLIエラーの理由・使い方案内

現在の状態: **完了（2026-10-07、利用者判断による一律整理）**。

以下の状態・未実施・承認待ちの記載は当時の記録であり、本incrementの現在の残作業として扱わない。
この完了判断は過去の作業を閉じるもので、当時未実施だった実装・検証・配置等を実施済みに変更するものではない。

状態: 完了（実装・検証、利用者受入、local commit、常用配置）。

## 必要な動作と根拠

通常のCLI操作で誤ったcommand、option、値を指定した人間が、理由と次の操作を理解できるようにする。
原観測は`henji list`が理由のないJSON errorを表示し、Core一覧の`henji core list`へ辿れなかったこと。
2026-10-04の現行sourceを隔離HOME/XDGで再確認し、root、TUI、run、sessions、history、agent/tool、
diagnosticsにJSON errorが残り、sessionsのerrorがstdoutへ出ること、`core list --help`が失敗することを
確認した。証拠は`.tools/increment-183/baseline.json`。

## 対象範囲と現行経路

- 入口は`henji_cli.ts`。helpは実行・保存処理の前に解決し、各command入口へdispatchする。
- 通常のerrorはstderrの短い英語テキストへ統一する。command/option名、指定漏れ、不正な値の理由を
  parserから渡し、invocation errorには該当commandの`--help`を案内する。
- `henji list`は未知commandとして報告し、`henji core list`も案内する。
- 現行のsubcommandについて`--help`を認識し、stdoutへhelp、exit 0を返す。
- runはMain → CLI Worker → runtime parser → Host → Agent Worker。通常/`--stream`のerrorは
  人間向けテキスト、`run --json`のNDJSON error/resultは現在の機械向けcontractを維持する。
- core/serveの`--json`は現在の成功出力を維持し、現在もテキストであるerrorを共通表示へ揃える。
- agent/toolのinspectで起動設定やtoolにrejectがある場合も、失敗理由をstderrへ出す。
- 保存・起動の責務、Core API、provider、通常実行のturn loop、成功時の出力形式は変更しない。

構想・architecture・roadmapの意味上の変更は本採用に含めない。これらの正本変更は別途承認を要する。
A14の削除とA21の受付方針は既存の利用者指示によるメモ整理であり、本incrementの実装範囲には含めない。

## 実装・確認計画

1. CLI表示の共通関数を置き、各parserで具体的な理由を保持する。help対象を現行commandに合わせる。
2. 各commandの通常errorを共通関数へ接続し、sessionsのstderr fallbackを修正する。
3. 変更した人間向け表示の既存testを更新し、実入口のfocused確認で未知command/option、値の指定漏れ・
   不正値、subcommand help、inspect失敗、runの機械向け出力の維持を確認する。
4. 必要なtype check、format、lint、`git diff --check`を実施する。隔離XDGのcompiled CLIとtmuxで
   TUI入口のerror/helpを確認する。provider requestは行わない。

## 結果（2026-10-04）

- `cli_error.ts`へ人間向けerror表示とnamed optionの理由を集約し、現行command入口に接続した。
  TUI/serveの既存parser、runのCLI Worker/Host経路、Data/SQLiteの保存責務は維持している。
- 未知command/option、値の指定漏れ、正整数/port/URL/Session ID等の不正値、排他的optionを
  具体的な理由と該当commandのhelp案内で示す。sessionsのerror fallbackはstderrへ修正した。
- agent/toolのinspect失敗は、JSONの失敗payloadをstdoutへ出す処理からreject理由のstderr表示へ変更した。
  成功時のJSONは維持する。
- core list、agent/tool、sessions、diagnosticsとそのexecutionsの各subcommandでhelpを認識する。
  diagnostics helpには既存のID/ordinal指定方法も記載した。
- `run --json`のNDJSON error/resultと成功時の出力を既存test・実CLI Workerで確認した。
  通常runと`--stream`のerrorは人間向けテキストを出す。出力mode同時指定時は従来どおり通常の
  stderr経路へ失敗を返す。CLI Worker自体の異常終了で返す既存JSON errorも`--json`では維持する。
- focused確認は49件通過。最後のruntime diagnostics入口の理由、TUI値の文言、configuration
  parser整理後に、 変更経路の8件を再確認して通過した。production入口と変更testのtype
  check、format、lint、 `git diff --check`も通過。full gateは計画していない。
- 最終compiled binaryで21ケースを確認。通常errorのstderr、値の理由、subcommand
  help、Session/diagnostic not-found、`run --json`、core listの成功JSONが通過した。証拠は
  `.tools/increment-183/compiled-cli.json`、build logは同directoryの`build.log`。
- 隔離HOME/XDGのtmuxで未知command、core list help、TUI不正値の表示、通常TUIのready、`/quit`による
  Core停止まで確認した。slash候補の確定とcommand実行にはそれぞれEnterを送った。
  初回の終了待ちは候補確定だけで実行しておらずタイムアウトしたが、隔離Coreを明示停止し、
  操作を修正した再確認で通過した。appの変更は不要だった。証拠は
  `.tools/increment-183/tmux-result.json`と`tmux-*.txt`。
- tmux確認の保存履歴でexecutionは0件。provider requestは行っていない。この実装検証では実configや
  常用binaryを変更していない。確認用binaryは`.tools/increment-183/henji`。

通常利用メモのS26は本書へ移設した。構想・architecture・roadmapは変更していない。

## 採用元メモ（2026-10-04時点）

- 観測（2026-09-29、利用者の通常操作）: `henji list`で
  `{"ok":false,"error":{"code":"invalid_invocation","message":"invalid invocation"}}`
  がそのまま表示された。Core一覧の正しい操作は`henji core list`だが、何を間違え、どう直せばよいか
  メッセージから分からない。
- 原観測時の常用binaryでの確認（2026-09-29、隔離HOME／XDG、実provider requestなし）:
  不明なcommand／optionに対し、root、通常起動／`tui`、`run`の通常表示／`--stream`、`history`、
  `sessions`、`module`、`tool`、`diagnostics`はJSONエラーを出す。TUI optionの指定漏れ等は
  具体的な理由がJSON内にあるが、ほかは`invalid invocation`だけの場合が多い。
  `core`／`serve`はテキストで、command間で表示が統一されていない。
  `sessions`のエラーはstderrではなくstdoutへ出る。
  `henji core list --help`もhelpとして処理されずエラーになる。
- 現行差分（2026-10-04、source照合）: 181で旧module commandは廃止し、JSON設定のagent/tool
  commandへ切り替えた。configuration_cli.tsは理由を含むJSON errorを返す。
  当時のcommand全件のbinary再確認は行っておらず、表示統一・出力先・helpは採用時に現在の入口で確認する。
- 利用者判断（同日）: CLIらしいメッセージへ改善したい。今回はメモだけを残し、まだ修正しない。
- 候補: 通常表示ではstderrへ、不明なcommand／option名、値の指定漏れや不正な値の理由、
  該当commandの使い方またはhelpへの案内を短いテキストで出す。例えば`henji list`には
  未知のcommandであることと、Core一覧は`henji core list`であることを案内する。
  明示的な`run --json`等の機械向け出力は維持し、成功時の出力形式は別の変更として扱う。
  エラーの出力先とsubcommandのhelpも、今回観測した不整合の改善候補に含める。
- 再検討条件: 利用者がこの改善を個別Incrementへ採用するとき。対象command、表示文言、
  機械向け出力との境界を採用時に決める。
- 関連: `v0/agent/cli/henji_cli.ts`、`v0/agent/cli/cli_help.ts`、`v0/agent/cli/`の各command入口。

## Commit・常用配置の承認（2026-10-04）

利用者の「コミットして配置して、完了とします」により、S26の受入、local commit、公式buildと常用配置、
配置結果の記録commitを承認された。A14の削除とA21の受付方針のメモ整理も今回のcommitへ含める。 clean
sourceから公式buildを作り、検証済みcandidateとのruntime digest一致を確認する。
旧binaryを保存し、`dist/henji`と`/home/agent/.local/bin/henji`へatomic配置する。
配置後は隔離HOME/XDGのCLI/tmuxで確認する。実provider requestは行わず、稼働中Coreは維持する。

## 配置結果と完了（2026-10-04）

実装と関連メモをsource commit `2b22cbae166b0ba372bc31661b886cbc61a99252`
（`feat: explain CLI errors and support subcommand help`）へ確定した。 clean
sourceから公式buildを作り、sourceDirty=false、runtime digest
`4d8be1a3ec51c541f9ca0fb3cd9b35b5896ed61288e475935ac323f825dc5e53`が実装検証済みcandidateと一致することを確認した。
配置版はhenji 0.8.0／Deno 2.9.7、build ID
`79e50882b3fb867c969883506fe5492598d9ddb42146eea513cf19d0e7ec904b`。

旧binaryを`.tools/increment-183/deployment/henji.{dist,local}.previous`へ保存し、staging fileから
`dist/henji`と`/home/agent/.local/bin/henji`へatomic配置した。両配置先のversionとbinary SHA-256
`b59456b877138226db682184f557d73b1b63e17a62bd53e545bd629652eaf0c5`が一致した。

配置版の隔離HOME/XDGでCLIの未知command、core list help、run JSON
error、sessionsのstderr、TUI不正値を
確認した。tmuxで通常TUIのready、`/quit`、確認用Coreの停止まで通過した。
保存履歴のexecutionは0件で、provider requestも0件。実config・credential・旧DBは変更していない。
配置前後で常用CoreのID・PIDが同一であることを確認した。次回Core起動から配置版を使用する。

証拠は`.tools/increment-183/deployment/`の`build.log`、`deployment.json`、`tmux-result.json`、
`tmux-*.txt`、`existing-core-check.json`。受入済みruntimeと同一のため、full gateと実provider確認は
繰り返していない。配置結果と完了状態を記録commitへ保存する。

利用者の「完了とします」に従い、Increment 183を完了とする。
