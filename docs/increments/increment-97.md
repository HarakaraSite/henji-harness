# Increment 97 — recovery laneの削除（S9採用）

ステータス: **実装・検証完了**

計画日: 2026-09-21

関連: 通常利用メモS9、Increment 85（recoverable stopの可視化）、B5（`commit proposal invalid`の理由不明の自動復元）、
[`architecture/henji-host-agent-worker.md`](../architecture/henji-host-agent-worker.md)、[`roadmap.md`](../roadmap.md) F01。

## 利用者が必要とする動作

- recoverable settlement（cancelled／interrupted／max_steps／contract_failure）後、statusに停止理由が残る。
- 同じtaskを再送したいときは入力履歴（Up）で呼び戻せる。
- recovery待ちでも**新しいtaskをsubmitでき、navigationもブロックされない**。
- `/recover`は存在しない。未消費のsteering／follow-upはsettlementで救済しない。

## 背景

利用者が「S9を採用してlaneを削除」と判断した。recoverable stop後のtask復元は、submit時にtaskが入力履歴へ
記録されるためrecovery laneと重複していた。lane固有の価値は未消費steering・follow-upとside-effect警告のみ
だったが、laneが`hasRecovery`で新taskのsubmit（`active task recovery pending`）とnavigationをブロックする
摩擦が実害だった。

## 変更

- `v0/tui/pending_input.ts`: recovery slot（active／steering／follow-up）と`recoverTask`／`recoverSteering`／
  `recoverAfterSettlement`／`popRecovery`／`hasRecovery`／side-effect warningを削除。`clearActiveTask`／
  `clearSteering`を追加し、`snapshot`はuncommitted inputの4 laneだけを返す（`recoveryCount`廃止）。
- `v0/tui/controller.ts`: recoverable分岐でlaneをclearし、statusに
  `<reason>; recoverable input available; press Up to resend`（tool実行後はside-effect警告を付加）を表示。
  `submitIfNonblank`／`navigationIdleAllowed`／`hasProcessPending`からrecoveryブロックを除去。`popRecovery`と
  `/recover`分岐を削除。
- `v0/tui/controller_editor.ts`: `recover()`を削除。
- `v0/tui/slash_command.ts`: `recover` commandと`/recover`を削除。
- `v0/tui/startup_render.ts`: help行`/recover · restore recoverable input`を削除。
- `v0/tui/editor_render.ts`: `pendingMetadataRows`のrecovery行（`r ...`）を削除。
- `v0/tui/layout.ts`: footerコメントからrecovery laneの記述を削除。

## 正本変更

- **architecture**: recoverable settlement節を「停止理由をstatusへ示し、未commit taskはrecovery専用laneへ
  退避せず、再送は入力履歴（Up）に任せる」へ変更。
- **roadmap F01**: 「停止理由と`/recover`を案内し、recovery laneから取り出せる」→「停止理由と入力履歴（Up）での
  再送を案内する」。slash command一覧から`/recover`を削除。「recoverable taskの停止理由表示と`/recover`」→
  「停止理由表示」。

## 検証

- `tests/v0/tui_retained_terminal_test.ts`:
  - cancelled／interrupted後に新taskをsubmitしてもブロックされず、`submitted`が2件になる。
  - occupied editorはrecoverable stop後も保持され、`hasActiveTask`がfalseでside-effect警告がstatusに出る。
  - `/recall`テストから`/recover`依存を除去。
  - footer/pending metadataのrecovery lane期待を削除。
- `tests/v0/tui_tool_preview_test.ts`: slash command一覧・候補から`/recover`を削除（`/r`候補は`/rename`／`/recall`）。
- `current_code_test.ts`、`tui_conversation_presentation_test.ts`、`tui_controller_overlay_test.ts`、
  `keymap_readline_test.ts`、`auto_compaction_test.ts`、`deno check`、`deno fmt --check`、`deno lint`、
  `git diff --check`は成功。

## 対象外

- 未消費steering／follow-upの救済。通常利用で必要になった時点で別途設計する。
- 入力履歴をセッション横断で保存する話（inbox S10）。
- decoderの`unknownAfterBareEscape`挙動（bare Esc直後の1回目のarrowがunknownになる）。本incrementの対象外。
