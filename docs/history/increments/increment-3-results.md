# 通常利用 increment 3 — 実装結果

ステータス: 完了。local実装、focused verification、authoritative gate、production TUIでの人間による
通常利用確認とユーザー受入を2026-09-07に完了した。

## 成立した動作

- compact startup二行目から`F1 help`だけを削除した。F1 key、`/help`、startup help overlayは維持した。
- 一画面を超えるconversationでPageUpすると現在Sessionのviewportを過去へ固定し、footerへ表示中の
  row範囲と`Esc latest`を示す。一画面以内ではPageUpしても最新追尾を維持する。
- 過去表示からPageDownで末尾へ到達した場合、idle時にEscを押した場合、または通常taskがpending laneへ
  admitされた場合に最新追尾へ戻る。
- 空入力、unknown slash command、pending admission失敗では過去表示とdraftを維持する。overlay表示中は
  footerの`Esc latest`を隠し、overlay固有のEsc説明を正本とする。
- turn間と、各turnのuser入力から最初のtoolまたはassistant出力への境界を、表示専用の空行として導いた。
  `UiLogEntry`、canonical transcript、Worker eventは変更していない。
- 標準画面をconversation log、空行、入力欄、空行、status行、cwd行の順にした。狭い高さでは入力欄を
  優先し、4行ではlog/input/status/cwd、3行ではinput/status/cwd、2行ではinput/status、1行ではinputだけを
  表示する。
- footerのstatus行とcwd行は別々に幅制御し、cwdは幅が足りなければrepository名を含む末尾を残す。

## Local verification

- focused TUI test: 24 passed、0 failed。turn/input境界、二行footer、1〜4行fallback、compact startup、
  PageUp/PageDown、history orientation、overlay、Esc、task admission成功・失敗、unknown slash commandを含む。
- 変更したTUI sourceのtype check: 成功。
- 変更したsource/testのformatとlint: 成功。
- `git diff --check`: 成功。
- authoritative `deno task --config deno.v0.json v0:gate`: stable candidateへ一回実行して成功。
  - type check成功
  - format check 104 files成功
  - lint 101 files成功
  - 通常test 48 passed、provider互換test 10 passed、0 failed

## Production normal-use acceptance

2026-09-07にユーザーがproduction TUIを通常利用し、次の動作を確認してincrement 3を受け入れた。

- startupに`F1 help`が表示されない。
- PageUp後、PageDownまたはEscで最新へ戻れる。
- 過去表示中に指示を送ると、自動的に最新へ戻る。
- turn、入力欄、status、cwdの区切りが読みやすい。
