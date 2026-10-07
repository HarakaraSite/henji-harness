# Increment 73 — busy表示を`working`＋spinnerへ変更

現在の状態: **完了（2026-10-07、利用者判断による一律整理）**。

以下の状態・未実施・承認待ちの記載は当時の記録であり、本incrementの現在の残作業として扱わない。
この完了判断は過去の作業を閉じるもので、当時未実施だった実装・検証・配置等を実施済みに変更するものではない。

ステータス: **完了（既存の実装・pty確認・配置済み、現行TUIの実provider確認済み）。**

基準commit: `a598a616`

計画日: 2026-09-18

実装日: 2026-09-18

対象: TUIのbusy lifecycle中のfooter 1行目を、`busy`という語とblink（`BLINK_SGR`）から、`working`という語と
周期更新されるspinnerへ変更する。`cancelling`の語と挙動、経過時間、`Esc cancel`は維持する。SurfaceはHost-localで
あり、Worker protocolやcanonical transcriptへterminal styleを入れない。

## 利用者が必要とする動作

- busy中はfooter 1行目に`working`と経過時間が表示され（例: `[working 00:12]`）、blinkしない。
- spinnerが周期的に変化し、処理が進んでいることが視認できる。
- cancel中は`cancelling`が表示され、spinnerと経過時間の扱いが一貫する。`Esc cancel`表示は維持する。
- spinnerのframeや色はterminalの最終frameだけに適用し、Presentation event、canonical transcript、history exportへ
  混入しない。
- `busy`という語を前提にした内部status／test期待を`working`へ更新する。ただし内部lifecycle名（`busy`）は
  制御ロジックの正本として維持してよい（user-visible表示だけ変更）。

## 計画

### 表示語

- `v0/tui/controller.ts`のstatus設定と`v0/tui/state.ts`の`footerStatus`／`reduceUiAction`で、busy lifecycleの
  user-visible primaryを`working`へ変更する。内部lifecycleは`busy`のままとし、表示変換は`v0/tui/layout.ts`の
  `footerStatusParts`／`activePrimary`（`['busy','cancelling']`）を`working`へ対応させる。
- `busy; /new waits for ready`等の一時notice文字列があれば`working`へ合わせる。

### spinner

- `v0/tui/layout.ts`のbusy blink（`blinkToken`／`blinkScalar*`）を廃止し、`working`／`cancelling`segmentへ
  spinner文字を付す。frame集合（例: `|`, `/`, `-`, `\` またはbraille）と更新間隔を固定値で決める。
- `v0/tui/tui_renderer.ts`のbusy中timerをperiodicに更新し、spinner frameを進めて再renderする。現在の毎秒
  `busy_elapsed`と統合し、経過時間は秒単位、spinnerはより短い間隔で更新する。settle時にtimerを止める。
- spinner frame indexはUiStateまたはrenderer-local stateに保持し、canonical transcript／Presentationへは出さない。

### テストと正本

- `tui_retained_terminal_test.ts`、`tui_controller_overlay_test.ts`、`tui_conversation_presentation_test.ts`等の
  `busy`表示期待、blink前提のlayout test、経過時間表示testを`working`／spinnerへ更新する。
- roadmap F01の「毎秒進む経過時間」「blink」記述、`docs/experience/normal-use-inbox.md` S6を更新する
  （正本更新は別承認）。

## 対象外

- spinnerのテーマ設定、frame集合のdata外部化、複数Surface対応。
- busy以外のblink用途（検索overlayのquery highlight等）の変更。
- 進捗率表示、toolごとの詳細進捗、cancel semantics自体の変更。
- Worker protocol、Presentation contract、canonical transcriptの変更。

## Verification

- focused test: busyで`working`＋経過時間が表示されblink tokenが出ないこと、spinner frameが周期更新されること、
  cancelで`cancelling`＋`Esc cancel`が維持されること、settleでtimerが止まり通常表示へ戻ること、terminal styleが
  最終frameのみでPresentation event／transcriptへ混入しないこと。
- 既存回帰: footer二行構成、history表示、slash command候補、draft、ctrl-c。
- pty／Playwright等での手動確認（別途）。
- type check、format、lint、`git diff --check`。authoritative `v0:gate`は安定候補で1回。

## 規模見積り

表示語変更、spinner実装、timer調整、test更新、docsで**2〜4開発日相当**。

## Human Gate

実装前に、利用者は次を確認・承認する。

1. busy lifecycleのuser-visible表示を`busy`から`working`へ変更する（`cancelling`は維持）。
2. busyのblinkを廃止し、固定frame集合・固定間隔のspinnerへ置き換える。経過時間は秒単位で併記する。
3. terminal styleは最終frameだけに適用し、Presentation event／canonical transcriptへ混入しない。
4. spinnerのframe集合と更新間隔は実装時に確定する（実装内定数）。
5. roadmap F01とinbox S6の正本更新は別承認。

## 結果（2026-09-18）

- `v0/tui/layout.ts`に`BUSY_SPINNER_FRAMES`（braille 10 frame）を追加し、busy lifecycleのuser-visible primaryを
  `working`へ、spinnerを`<frame> working <elapsed>`で表示する。busy blink（`blinkToken`／`blinkScalar*`）を削除。
  幅が足りない場合はspinner→elapsed→語の順に落とす。
- `v0/tui/state.ts`に`busySpinnerFrame`と`busy_spinner` actionを追加。`v0/tui/tui_renderer.ts`のbusy timerを
  120ms周期にし、spinner frameを進めつつ経過時間（秒）を更新。settle時にframe／elapsedをclearする。
- `cancelling`・経過時間・`Esc cancel`は維持。terminal styleは最終frameのみ（spinnerは通常文字で、`BLINK_SGR`は
  busyでは使わない）。検索overlay等のblink用途は変更していない。
- 検証: `tui_retained_terminal_test.ts`のbusy footer testを`working`＋spinnerへ更新（blink期待を削除、
  120ms周期、frame進行、settle clearを確認）。`v0:check`／`fmt`／`lint`／`v0:gate` exit 0。
- 未実施: pty等での手動表示確認、binary build・配置。roadmap F01とinbox S6の正本更新は別承認。


## 現行状態の完了整理（2026-09-27）

B07-N・B09でbusy表示とcancel後の停止表示を確認した。旧blink contractは現行仕様では無効。
根拠は[配置binary・実provider E2E](../../increments/e2e-001-132-2026-09-27.md)と、利用者のincrement文書を完了へ整理する指示。
当時の未実施・未確認の記録は履歴として保持し、現在の完了状態とは区別する。
