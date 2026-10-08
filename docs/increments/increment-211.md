# Increment 211 — S32・S37: 入力履歴の削除とキャンセル・Session一覧キーの変更

現在の状態: **完了（2026-10-08、利用者判断による一律整理）**。

以下の状態・未実施・承認待ちの記載は各作業時点の記録であり、本incrementの現在の残作業として扱わない。
この完了判断は過去の作業を閉じるもので、当時未実施だった実装・検証・配置等を実施済みに変更するものではない。

状態: local実装・focused test・隔離tmux実表示／操作確認・独立review完了（2026-10-07）。
sourceは`ac59f0d0`へ保存済み。212と合わせて常用build・配置済み。pushは未実施。
配置結果は[Increment 212](increment-212.md)を参照する。常用環境での利用者確認待ち。

## 目的・採用と承認範囲

利用者の「では、1と2をそれぞれインクリメントとする」により、提案した第一段階のS32＋S37を
本incrementへ採用した。第二段階のS36は[Increment 212](increment-212.md)として分ける。
本incrementの実表示・操作確認を終えてから212へ進む。
分割・採用と文書化の後、利用者の「211を実装テストレビューさせて」によりlocal実装・非破壊的検証と
独立reviewが承認された。常用build・配置・commit・push、212の実装は今回の対象外。

目的は、使用頻度の低い入力履歴を撤去し、実行キャンセルとSession一覧のキー割当を整理することである。
会話の保存履歴と入力editor内の行移動は維持する。

## 原観測・利用者の判断

- S32（2026-10-03）: 実行中の↑/↓では入力履歴を呼べなかったが、利用者はあまり不便を感じず、
  入力履歴の使用頻度も少ないとして削除候補の記録を指示した。
- S37（2026-10-07）: S36の検討時、Ghostty単独で履歴閲覧から戻るためのEscがHenjiにも届き、
  実行キャンセルと同時に働く想定を利用者が懸念した。誤キャンセルを実機で観測した記録ではない。
- 同日の確認済み割当はF1＝実行キャンセル、F2＝次タスク予約、F3＝現在タスクへの追加指示、
  F4＝Session一覧。pickerを閉じるEscは維持し、Escから外すのは実行キャンセルだけである。
- S32とS37を同時に扱う先行方針を、今回一つのincrementとして採用した。

## 必要な動作・受入条件

1. 送信済みpromptの記録と↑/↓による再呼出しを廃止する。↑/↓はeditor内の行移動とpickerの選択に使う。
   入力履歴のためのdraft退避・navigation、専用定数・export・help・testも利用経路を確認して整理する。
   Sessionの保存会話と実行履歴は削除しない。
2. 通常の会話操作でF1から実行キャンセルを行える。受付可能状態とキャンセル処理は既存Core/API経路を使う。
   Escでは実行をキャンセルしない。
3. Session一覧はF4で開く。F2・F3、入力送信・改行、picker内の選択とEscによる閉鎖は維持する。
   既存overlayの入力優先順を、キー変更だけを理由に変更しない。
4. footer・help・Session一覧のshortcut案内は実際の割当と一致し、入力履歴の案内を残さない。
5. 211では現行の会話表示方式を維持する。Henji内の履歴閲覧から最新へ戻るEscは、実行キャンセルを
   伴わず使える。端末scrollbackへの移行は212で行う。

## 現行product経路・影響範囲

2026-10-07のsource確認:

- stdin → `input_decoder.ts` → `InputEvent` → `remote_session.ts`のoverlay／通常入力処理。
  現行decoderとcontractはF1〜F3までを扱う。F4認識をここへ追加する。
- `remote_session.ts`がprocess-localの`TuiEditorHistory`を所有し、送信時に記録、idleの↑/↓で
  `walkInputHistory`へ分岐する。複数行editorの行移動は入力履歴と別の経路である。
- 通常入力のF1はSession picker、最新表示で実行中のEscは既存キャンセル処理へ接続する。
  pickerなどのoverlayは通常入力より先にEscを消費する。
- `layout.ts`と`slash_command.ts`がfooter・helpのキー案内を生成する。

対象はこれらのTUI入力・案内経路と、その利用者を持つ`input_history.ts`、`input.ts`、
`input_contract.ts`および対応test。Core/API、Dataの保存契約、provider adapter、端末描画方式、
構想・architecture・roadmapは変更対象にしない。

## 実装・確認方針

- 入力履歴の全利用箇所を確認して撤去し、editorの行移動を直接使う。F4の復号とキー分岐・案内を更新する。
- focused確認は、複数行入力の↑/↓、送信後の入力履歴非再呼出し、F1キャンセル、Esc非キャンセル、
  F4のSession一覧、pickerを閉じるEsc、既存F2・F3の操作に対応させる。
  廃止した入力履歴を要求するtestは整理する。
- 変更箇所のtype check・format・lint・`git diff --check`を行う。full gateは要求しない。
- 隔離HOME/XDGのtmux上でproduction TUIの実表示・キー操作を確認し、観測を本書へ記録する。
  実provider callが必要なら、対象・回数・保存先について別途明示承認を得る。

## 実装結果

- `input_history.ts`を削除し、`input.ts`の専用export、`input_contract.ts`の専用上限定数、
  `remote_session.ts`のowner・記録・draft退避／navigation処理と専用busy分岐を撤去した。
  ↑/↓は既存editorの行移動へ直接渡る。保存会話・実行履歴の経路は変更していない。
- `InputEvent`とdecoderにF4を追加した。既存F1〜F3と同じSS3／CSI経路で復号する。
- 通常入力のF1を既存キャンセル処理、F4を既存Session pickerへ接続した。
  Escの実行キャンセル分岐を除き、picker閉鎖と履歴からlatestへの復帰、overlay優先順を維持した。
- footer・helpをF1 cancel／F4 sessionsへ更新し、入力履歴の案内を削除した。
  F1は履歴閲覧中も使えるため、その場合にキャンセル案内を隠していた処理も除いた。
- 旧入力履歴のみを要求する`increment_146_remote_history_test.ts`を削除した。
  `increment_211_input_test.ts`でremote TUIの複数行↑/↓と送信済みprompt非再呼出しを確認し、
  既存のキー・キャンセル・picker・footer／help testを新しい動作へ更新した。

## 検証・review結果

- implementerのfocused一括確認は55 passed／0 failed。
  `keymap_readline_test.ts`、新規211、141 remote TUI、142 pending、143 Session、
  170 preparing cancel、`tui_retained_terminal_test.ts`を実行した。
  実行前のtask receiptが保留中のキャンセルも、既存実Core確認をF1へ更新して成立した。
- 変更した12 TSファイルのtype check・format check・lintはpass。
  defaultも最終`git diff --check`と入力履歴参照の撤去を確認した。full gateは実行していない。
- defaultは隔離HOME/XDG・workspace・config・stateのtmuxで、production CLIのTUIをsourceから起動し、
  正式HTTP API Workerと実Core/Data/Agentへ接続した。既存provider-freeのbarrier入力で実行を保持し、
  次の操作を確認した。実provider callは0回で、常用binaryのbuild・配置は行っていない。
  - F4によるSession一覧とEscによる閉鎖、複数行入力の↑/↓、送信後のprompt非再呼出し。
  - 実行中のlatestでEscを押してもキャンセルしないこと、履歴閲覧中のEscがlatestへ戻ること。
  - 履歴閲覧中のF1でキャンセルがacceptedになり、実行がidleへ戻ること。
  - F2のfollow-up予約とF3のsteeringがacceptedになり、親の終了後にfollow-upが完了すること。
  - helpのF1／F4案内と入力履歴案内の撤去、Escによるhelp閉鎖、Ctrl-Dのdetach。
- tmux確認の最初の試行は、観測側で`user>`をeditorの`>`と混同した判定と、既存の50ms Esc判定前の
  次入力注入、slash pickerの完了と実行を区別しないdriverにより失敗した。
  driverを実操作に合わせて修正し、最終の全操作はpass。これらを理由にproduction仕様を変更していない。
  script・操作ごとの画面・最終Core readbackは`.tools/increment-211/`（git管理外）に保存した。
- 独立reviewerは、対象コードと対応testの差分、要件、overlay優先順、履歴撤去、F1／F4、Esc、
  footer／helpを確認し、要対応のfindingなし。一般的なhardeningは対象外。
  reviewerは静的確認を担当し、test実行はimplementer、tmux実経路と最終結果の確認はdefaultが担当した。

local実装・確認の残作業はない。2026-10-07の利用者指示でsourceをcommitへ保存し、
常用環境での利用者確認は212の後にまとめる。常用build・配置・pushは未実施。
212の実装着手も同じ指示で承認された。

## Architecture正本の更新案（未反映）

`docs/architecture/henji-host-agent-worker.md`には、211で置き換える旧操作の記載がある。
意味上の更新案は次の三箇所であり、正本変更への別途明示承認を得るまでは本書に留める。

- Surfaceの所有状態（現529行）から「入力履歴」を除く。terminal・draft・cursor・viewport・picker・
  表示用cacheの所有は維持する。
- 履歴とキャンセル操作（現591–592行）を「履歴中のEscはlatestへ戻る。実行キャンセルはF1から
  要求し、Escでは要求しない。pickerのEscはその画面を閉じる」へ更新する。
- Session一覧の入口（現594行）を「F4または`/sessions`」へ更新する。

本incrementの実装・確認は今回の明示要件を基準とし、旧記載を理由に操作を旧仕様へ戻さない。


## 利用者受入と0.11.0公開・配置（2026-10-07）

利用者が211・212とヘッダー修正を通常利用で確認し、「確認しましたよさそうです」と受け入れた。
push、v0.11.0でのJSR公開、常用配置を明示承認した。結果は
[JSR公開記録](../operations/jsr-publish.md#0110-publication--2026-10-07-jst)と
[常用配置記録](../operations/native-0.11.0-deployment.md)へ記録する。
