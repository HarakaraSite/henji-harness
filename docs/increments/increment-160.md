# Increment 160 — ミニマルなフッターデザイン

現在の状態: **完了（2026-10-07、利用者判断による一律整理）**。

以下の状態・未実施・承認待ちの記載は当時の記録であり、本incrementの現在の残作業として扱わない。
この完了判断は過去の作業を閉じるもので、当時未実施だった実装・検証・配置等を実施済みに変更するものではない。

更新日: 2026-09-30

ステータス: 利用者確認・完了承認済み（2026-09-30）。Increment 160は完了。
local実装・検証・commit/push・常用配置・配置後確認を完了した。

## 目的と採用判断

利用者の「1でミニマルにしようかな　次のインクリメントはそれで」により、
会話で提示した①「ミニマルな開発ツール風」を採用する。
現在のフッターは外側の`[ ]`と項目間の`│`が多く、情報が同じ強さに見える。
3行の役割を保ちながら、余白・文字色・配置で状態とモデルを拾いやすくする。

以下は十分な幅がある場合の配置例。色は後述する。

```text
Enter submit · / commands
● ready   /home/agent/projects/henji-harness       untitled · 28e86367
opencode-go-chat / mimo-v2.6-pro                               auto
```

当初の指示で次incrementとして採用し、要件・計画を記録した。
追加指示「実装して」により、計画に沿うlocal実装と非破壊的検証を行う。
追加指示「コミットプッシュ配置をして」により、commit/pushと常用配置を行う。
公開・外部providerへのrequestは今回行わない。 構想・architecture・roadmapの意味変更は不要。

## 表示要件

- フッターは通常3行。1行目は操作案内、2行目は状態・workspace・Session、
  3行目はprovider・model・effortというIncrement 159の責務を維持する。
- 全行の外側の`[ ]`を外し、左に1セルの余白を置く。 右端も幅に余裕があるときは1セル空ける。
- 1行目は操作同士を`·`で区切る。キー部分（`Enter`、`/`等）は通常文字色、
  操作説明と区切りはdimとする。picker・履歴閲覧でもその時の操作を同じ見た目で表示する。
- 2行目は左に状態とworkspace、右に`title · Session ID`を置く。
  十分な幅があれば左右のグループ間を空白で埋める。Session IDは現行の8文字を使い、
  `session:`のラベルを省く。titleは通常文字色、workspace・ID・区切りはdimとする。
- readyには緑の`●`と緑の状態文字を使う。working／cancellingは黄色とし、
  現行のスピナーと経過時間を維持する。時間の表記・更新間隔は変えない。
  接続断・閲覧状態の既存文字表示は残し、色だけで状態を表さない。
- 3行目は左に`provider / model`、右にeffortを置く。
  modelは通常文字色＋bold、provider・`/`・effortはdimとする。
- 背景色、キートップ装飾、追加の罫線は採用範囲に含めない。
- 狭い画面では空白の伸長をやめ、現行の項目省略優先順位と
  workspace／modelの末尾を残す短縮を引き継ぐ。装飾と余白を含めてterminal cell幅で計算する。
  高さ不足時にfooter行数が減る現行動作も引き継ぐ。

## 現行のproduct経路と影響範囲

通常CLI → HTTP接続TUI → CoreのSession snapshot → TUIのprojection／footer state → `TuiRenderer` →
`layoutUi` → terminal frame。

Coreがworkspace・Session identity・model選択・実行状態を所有する。
TUIはsnapshot、ローカル操作状態、既存timerからfooterを組み立てる。
操作案内は`footerStatusText`、状態・identityは`footerSessionText`、
選択modelは`footerModelText`で配置され、`renderLayoutRow`で文字装飾される。

今回の対象はこの表示経路。入力操作・キー割当・コマンド・状態遷移・API・保存形式を変更しない。
新しい状態所有者や収集経路は追加しない。

## 実装計画

1. `v0/tui/layout.ts`で3行の括弧・区切り・余白・左右配置を置き換える。
   既存の通常画面、overlay、履歴閲覧のfooter生成を同じ表示方針へ揃え、
   狭幅時の計算を新しい表示文字列に合わせる。
2. `v0/tui/tui_renderer.ts`の既存の部分装飾経路を確認し、
   footerに必要なdim・bold・緑・黄色の範囲指定を追加する。
   会話本文の意味を表すtoneをfooterの別の意味へ流用せず、ANSI装飾はrendererで行う。
3. 新表記に変わる既存footer assertionを更新し、 focused確認と隔離tmuxのproduction
   TUI確認を行う。観測と結果は本文書へ記録する。

局所的な表示変更としてdefaultが担当する。独立reviewやfull gateを段階名だけで追加しない。

## 検証と受入

人間がproduction TUIで状態・モデル・操作を読み取り、既存の操作を完了できることを確認する。

- 既存footer／retained terminalのfocused testで、3行の表記、
  Session・title・modelの変更反映、working／cancellingと経過時間、
  幅不足時の省略が今回の配置でも成立することを確認する。 装飾の確認は実際のANSI出力と対応付ける。
- 必要なtype check、変更ファイルのformat・lint、`git diff --check`を行う。 authoritative full
  gateは今回の局所表示変更の計画に含めない。
- 隔離XDG・workspace・tmuxでproduction TUIを起動し、通常表示、 title変更、既存model選択、slash
  picker、履歴閲覧、resizeを操作する。
  状態・モデルが見分けられ、装飾が本文・入力欄へ漏れず、幅内に収まることを確認する。
- working／elapsed／cancelの画面はlocalhost模擬providerの遅延応答で確認する。 外部provider
  callが必要になった場合は対象・回数・保存先を提示し、明示承認を得る。

実装前の未確認事項は、採用案の文字色と左右配置の実端末での見え方。 production
TUIでの確認結果は以下に記録する。

## 結果

### 実装とfocused確認

3行の外側の括弧と縦区切りを外し、左余白を設けた。 2行目は状態・workspaceとtitle・8文字Session
ID、3行目はprovider・modelとeffortを左右へ配置した。
通常の右端は1セル空け、幅不足時はworkspace／modelの末尾を残して短縮する。
項目が収まらないときのpath→title省略と高さによる行数縮小も維持した。

footer専用の部分装飾をlayoutからrendererへ渡す。キーとtitleは通常文字色、
workspace・ID・操作説明・provider・effortはdim、modelはbold、readyは緑、
working／cancellingは黄色とした。文字装飾はそれぞれの範囲の直後にresetする。
既存のspinner・経過時間・操作割当・Core/API/保存形式は変更していない。

- 既存4ファイルのfocused testと新しい部分装飾確認は59件pass。
  Session・title・model変更、時計とsnapshot反復、履歴・picker・狭幅表示を確認した。
  新しい確認では日本語workspaceを含む文字装飾の範囲と、緑・黄色・dim・bold・resetの
  実際のANSI出力を照合した。旧表記のassertionは新デザインへ更新した。
- production CLIと対象testのtype check、変更TSのformat・lint、diff checkはpass。 full
  gateは計画どおり実行していない。
- 自己reviewでsnapshotから表示までの経路、cell幅と装飾用scalar offsetの対応、
  項目省略と既存操作の維持を確認した。専門agentは使用していない。

### 隔離tmuxのproduction経路

公式build scriptでcandidateを作り、そのcompiled
CLI/Core/TUIを隔離HOME/XDG/workspace/tmuxで操作した。
実config、既存Core、常用binaryは変更していない。

| 操作・状態             | 観測結果                                                                |
| ---------------------- | ----------------------------------------------------------------------- |
| 100列で起動            | 3行の括弧・縦区切りがなく、左余白、左右配置、緑のready、dimとboldが反映 |
| `/rename Footer title` | 右側のtitleへ反映され、IDを維持                                         |
| `/`のpicker            | キーと操作説明を分けた`↑/↓ select · Enter complete · Esc close`を表示   |
| `/model`のpickerと選択 | localhost宣言の別modelへ変更し、3行目に即時反映。推論requestなし        |
| 40×23へresize          | workspace・modelを末尾保持で短縮し、title・ID・effortを幅内に表示       |
| 80×23で実行            | 2行目先頭に黄色のspinner・working・elapsed。時計が少なくとも2秒進む     |
| 実行中のPageUp→Esc     | 履歴で`Esc latest`を表示。最初のEscは最新表示へ戻り、実行を継続         |
| 最新表示でEsc          | executionがsettledとなり、緑のreadyへ戻る                               |
| Ctrl-Q                 | TUI/Coreともexit 0、terminalのcanonical／echo復元、確認用tmux終了       |

最終probeはlocalhost模擬providerへ1request、外部providerへ0request。
前段のprobeを含むlocalhostの推論requestは合計2回。実credentialは使用していない。
tmuxのANSI付きcaptureでもreadyの緑、workingの黄色、modelのbold、補助情報のdimを照合した。

確認用probeの初回2回はmodel pickerに到達せず停止した。
コマンド補完→実行のEnterを分け、模擬provider宣言に現行の`modelListSource: catalog`を指定して修正した。
3回目は全操作と終了まで成立したが、旧probeから残った「default-selection.jsonが存在しない」という
期待で停止した。今回確認したmodel選択は隔離configへ保存する正常動作のため、
probeの期待をその選択値のreadbackへ修正し、最終probeで成功した。productionの挙動は変更していない。

candidate・build log・focused log・typecheck log・tmux probe・captureの保存先:
`/home/agent/.local/state/henji-build-artifacts/increment-160-20260930/`。
candidateは`henji.candidate`、build IDは
`8a98cf19ac7f21d9df0be56090e61b36b6d2f5147a65efe5420ebb2458109f5e`。
最終production確認は`compiled-175041/`、結果一覧は`tmux-results.json`。

### 残る境界

local実装と検証は完了。利用者による見た目の確認・increment完了承認は取得済み。
追加指示によるcommit/push・常用配置・配置後確認は完了。公開は未指示。
構想・architecture・roadmapは変更していない。

## commit・push・常用配置（2026-09-30）

利用者の追加指示に従い、今回の実装・test・increment文書・handoffをcommitしてorigin/mainへpushする。
固定commitのclean checkoutから公式buildし、検証済みcandidateとruntime
SHA-256が一致することを確認する。
旧binaryを保存して常用先`/home/agent/.local/bin/henji`へ原子的に配置する。
配置先とbuild候補のhash・version・source・buildを照合し、配置binaryを隔離HOME/XDG/workspace/tmuxで
非provider操作だけ確認する。既存Coreと実configは保持する。
結果は本節とhandoffへ記録し、後続の文書commitでpushする。

### 配置結果

実装・test・increment文書・handoffの8ファイルをcommit
`9359337d702067f31c899d7ab255a0084d0a385b`へまとめ、origin/mainへpushした。 このcommitのclean
checkoutからDeno 2.9.7で公式buildし、sourceDirty=falseのbinaryを生成した。 runtime
SHA-256は実装時に検証したcandidateと一致した。

旧binaryを保存して`/home/agent/.local/bin/henji`へ原子的に置換し、
配置先とbuild候補のhash・version・source・buildの一致を確認した。henji 0.7.0。

- build ID: `d8afc403bd2090468e28901dc63c628c700e40ac5987b54adeee0d57d13a99f0`。
- runtime SHA-256: `660b275ca63bd7b37ed7a0cf0ccadbeedbd3ca1f640a9630559977efd3c888a0`。
- binary SHA-256: `b85dafc88ae11eccc14a12d0692abb316f8f004788ccf6d2253220cf0a61b520`。
- 旧binary: 同increment artifactの`deployment/henji.previous`。 SHA-256:
  `fd1766dd437fdcde41a841e708a3bc987f3783f1341e52f2f03c8a42bb86b975`。

配置したbinaryそのものを隔離HOME/XDG/workspace/tmuxで起動し、readyの3行footerとANSI色、 F1
Session一覧、slash picker、改名、40列footer、`/quit`終了を確認した。 Core APIのbuild
identityも配置先と一致し、TUI/Coreともexit 0。確認用Core/tmuxは終了した。 この確認はprovider
requestなし、実credentialなしで行い、実configは変更していない。

配置前から稼働していたHenjiプロセス2件はPIDと起動時刻を保ち、停止・移行していない。
新しく起動するTUIから今回のデザインが適用される。
利用者確認・increment完了承認は取得済み。JSR公開、構想・architecture・roadmapの変更は行っていない。

配置証拠の保存先:
`/home/agent/.local/state/henji-build-artifacts/increment-160-20260930/deployment/`。 clean
checkout、`build.log`、`preflight.json`、`deployment.json`、`version.txt`、
`smoke-results.json`、`smoke-175959/`のcaptureとCore identityが正本。

## 利用者確認・完了（2026-09-30）

常用配置後、利用者の「みやすくなった　インクリメントを完了とする」により、 見た目の確認とIncrement
160の完了承認を取得した。 本incrementの作業は完了。完了記録をcommitしてorigin/mainへpushする。
