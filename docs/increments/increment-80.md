# Increment 80 — `web_fetch`取得URLのtool activity表示（S7）

ステータス: **実装・検証完了**

基準commit: `6cdfc407`

計画日: 2026-09-19

実装日: 2026-09-19

対象: TUIのtool activity（pending／settled）、保存履歴のtool行、direct rendererで、`web_fetch`の取得先URLを
表示する。SurfaceはHost-localであり、Worker protocol、Presentation contract、canonical transcriptへ
新しいfieldを追加しない。

## 利用者が必要とする動作

- `web_fetch`を実行したとき、live tool activityに取得先URLが`web_fetch <url> …`として表示され、settled後も
  `web_fetch <url> ✓`／`✗`として残る。
- 保存Sessionの履歴renderのtool行と、direct renderer seam（`toolCallText`）も同じURL表示を使う。
- 長いURLは既存のpreview上限（96 byte head＋`…`）で省略され、full URLやtool result本文がactivityへ漏れない。
- 表示するURLはmodelが要求した引数`url`である。redirect後のfinal URLはtool result本文の`URL:`行に既にあり、
  本incrementでは表示対象にしない。
- 既存の他tool preview（`bash`／`read`／`write`／`edit`／`bash_output`／`web_search`／`skill`）の表示は変えない。

## 根拠

- 通常利用メモS7（2026-09-18）: `web_fetch`はtool resultにfinal URL・status・content-type・本文を返すが、
  TUIのtool activityでは取得先URLが前面に出ず、どのURLを取得したかを確認しにくい。
- `toolActivityPreview`（`v0/agent/tools/tool_activity.ts`）はtoolの引数からHost-visible previewを導出し、live
  UI（`v0/tui/state.ts`）、履歴render（`v0/agent/session/session_history.ts`）、direct renderer
  （`v0/tui/terminal_text.ts`）が共用する。`web_fetch`だけcaseが無くname-only表示だった。
- tool result本文はtool result textとして別に運ばれ、preview経路は引数のみを使うため、URLの導出にprotocol変更は
  不要。

## 実装計画

1. `v0/agent/tools/tool_activity.ts`の`toolActivityPreview`に`web_fetch` caseを追加し、`firstLine(args.url)`を
   previewにする。
2. `tests/v0/tui_tool_preview_test.ts`に、URL表示とresult後の保持、failure時の保持、長URLtruncate、tool result
   本文非漏洩のfocused testを追加する（既存testファイルのため`v0:test`登録変更なし）。
3. focused test、`v0:check`、`v0:fmt`、`v0:lint`、`git diff --check`を実行する。
4. inbox S7を本increment文書へ移管し、採用済み候補一覧と本文から除く。
5. 検証中に見つかった、基準commit時点で既にdeno 2.9.6の`v0:fmt`に不合格だった`v0/agent/README.md`の
   markdown prose reflowずれ（意味変更なし）を、利用者承認のうえ整形してgateを通す。

## 対象外

- redirect後final URLのactivity表示（必要になった時点で別途）。
- tool result本文、status、content-typeのactivity表示。
- Worker protocol、Presentation contract、canonical transcript、`web_fetch` tool実装・結果形式の変更。
- roadmap F01等の正本更新（roadmap変更は別承認）。
- compiled binaryの再build・配置（runtime不変、既存配置`0.2.1`を維持）。

## Verification

- focused test: `tests/v0/tui_tool_preview_test.ts`の15件pass。
  - `web_fetch` pendingで`web_fetch <url> …`を表示。
  - success result後もURLを保持し`✓`、result本文のfinal URLを漏らさない。
  - error result後もURLを保持し`✗`、error本文を漏らさない。
  - 長URLは`…`で省略され、既存のbyte上限内に収まる。
- `v0:check`／`v0:fmt`／`v0:lint`／`git diff --check`を実行する。
- 安定候補でauthoritative `v0:gate`を1回実行する。

## 規模見積り

switch case追加、focused test、docsで**0.5開発日相当**。

## Human Gate

2026-09-19、利用者は「承認、実装を進める（requested URLのみ）」として上記計画を承認した。redirect後final URLは
対象外とする。

## 結果

- `toolActivityPreview`に`web_fetch` caseを追加し、引数`url`をpreviewとして返すようにした。live tool activity、
  保存履歴のtool行、direct rendererが同じ表示を使う。
- 長URLは既存`boundedHead`（96 byte）で省略される。
- focused testを3件追加し、`tests/v0/tui_tool_preview_test.ts`は15件pass。
- redirect後final URL、tool result本文の表示は行わない。
- 検証で`v0:fmt`が基準commit `6cdfc407`の`v0/agent/README.md`で不合格になることを確認した（43-44行・57-58行の
  prose reflowずれのみで、increment-79の「fmt pass」記載と不一致）。利用者承認を得てdeno fmtで整形し、意味変更は
  ない。
