# Increment 98 — コードの無着色化とPageUpのoldest到達修正

ステータス: **実装・検証完了**

計画日: 2026-09-21

関連: Increment 84（assistant本文レイアウトとMarkdownタグ着色）、Increment 95（会話ログのPageDown停止修正）、
Increment 96（見出し全行着色と強調の緑化）、通常利用メモB3（PageUpで履歴先頭へ到達できない）。

## 利用者が必要とする動作

- assistant本文のinline code（`` `text` ``）とfenced code block（``` ``` ```）は色付けしない（無着色）。
- 会話ログでPageUpを繰り返すと、startup headerを跨いでも履歴先頭（oldest）へ到達し、最下行へ戻らない。

## 変更

### コードの無着色化（`v0/tui/assistant_layout.ts`、`v0/tui/conversation_renderer.ts`、`v0/tui/tui_renderer.ts`）

`inlineSpans`のinline code spanと、fence opener／body／closerの`code` tone spanを削除した。`AssistantSpanTone`
から`code`を外し、SGRマップの`code: GREEN_SGR`も削除した。list markerの緑と強調の緑は維持する。

### PageUpのoldest到達修正（`v0/tui/tui_renderer.ts`）

`TuiRenderer.scrollPage`は、PageUp後の`nextStart`がentryIdを持たない行（startup header等）に入り、そこから
上方探索してもentryId行が見つからない場合に`this.latest()`を呼び、最下行へ戻っていた。`nextStart === 0`の
ケースしかoldestへ落としていなかったため、`nextStart`が1〜header最終行の範囲でこの誤動作が起きていた。
上方探索が失敗した場合（`direction === 'up'`）は`latest()`ではなく`oldest`へ遷移するよう修正した。

## 検証

- 実Session `e8e99332`のcanonical transcriptを`restored_log`で復元し、startup header込みで再現。
  - 修正前: `logStart=46`（`history rows 47-87/292`）からPageUpで`followLatest`（最下行）へジャンプ。
  - 修正後: 同じ位置からPageUpで`oldest`（`logStart=0`）へ到達。
- `tests/v0/tui_retained_terminal_test.ts`「retained PageUp reaches oldest across the startup header」を追加。
  startup header＋40 turnで、PageUp中に`followLatest`へ落ちず`oldest`へ到達することを確認。
- `tests/v0/increment_84_assistant_layout_test.ts`:
  - inline codeが色付けされないこと、fenced code blockの全行がspanを持たないこと。
  - 強調（`*`／`**`／`***`）と見出し全行着色、折り返し跨ぎのemphasisは従来どおり。
- increment-84 layout test 12件、`tui_retained_terminal_test.ts` 40件、`tui_conversation_presentation_test.ts`、
  `deno check`、`deno fmt --check`、`deno lint`、`git diff --check`は成功。

### tmux確認（production TUI、2026-09-21）

`AGENTS.md`のSurface変更検証ルールに従い、tmux（100x45）上のproduction TUIで確認した。

- Session `e8e99332`を`/sessions`からresumeし、PageUpを繰り返すと`history rows 1-39/293`の先頭
  （startup header表示）へ到達し、最下行へ戻らないことを確認。
- assistant本文のinline code（`` `$1` ``／`` `$20` ``／`` `09` ``）とfenced code（``` ```awk ``` ```）が
  無着色であること、見出しの青と強調の緑が維持されていることを最終frameで確認。
- 注意: 隔離XDGコピー（`v1`のDB＋WALをコピー）ではresumeが`session resume failed`になったため、実stateを
  read-onlyで使用した。隔離コピーはSQLiteのWAL整合が崩れる可能性があり、検証harnessの課題として残る。

## 対象外

- list marker・table・見出し・強調の着色（維持）。
- 履歴ビュー（`/history`）のinline code表示。対象は会話ログのassistant本文。
- decoderの`unknownAfterBareEscape`挙動。
