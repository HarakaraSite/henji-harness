# Increment 81 — フッターを3行化（Session情報行とmodel行の分離）

ステータス: **実装・検証完了**

基準commit: `2ef01b27`

計画日: 2026-09-19

実装日: 2026-09-19

対象: TUIのfooterを2行から3行へ変更する。1行目の一時status、2行目のcwd・Session短縮ID・Session title、
3行目のroot provider・model・effortという構成にする。SurfaceはHost-localであり、Worker protocol、
Presentation contract、canonical transcriptへ新しいfieldを追加しない。

## 利用者が必要とする動作

- footer1行目は従来どおり一時status（`[ready]`／`[working …]`／`[cancelling]`等）を表示する。
- footer2行目はcwd、Session短縮ID、Session titleを表示する。
- footer3行目は選択中root provider、model、effortを表示する。
- 既存のラベル（`session:`／`provider:`／`model:`）と`[ … ]` bracketを維持する。
- Session titleが未設定のときは`untitled`を表示する（startup headerと一致）。
- 幅が足りない場合は既存同様、cwdをsuffix省略し、Session title、modelの順に省略する。
- 高さが足りない場合は1行目、2行目、3行目の優先で表示行数を制限し、狭いterminalでも物理的に収まる。
- 一時status、cwd、Session ID、Session title、provider、model、effortは既存のprojectionとstartup position
  から導出でき、新しいprotocol fieldや保存schemaを要求しない。

## 根拠

- 利用者要望（2026-09-19）: footerを3行にし、2行目をpath・Session ID・Session title、3行目をprovider・
  model・effortにする。
- 現行`footerIdentityText`（`v0/tui/layout.ts`）はcwd・Session ID・provider・model・effortを1行へ連結し、
  Session titleはfooterに出ない。titleは`state.startup.position.title`にあり、`session_binding_replaced`と
  `session_title`で更新される。
- footer行数・高さ配分は`layoutUi`の`footerCount`が決め、狭い高さでは行を落とす既存規則がある。

## 実装計画

1. `footerIdentityText`を`footerSessionText`（2行目）と`footerModelText`（3行目）へ分割する。
   `footerSessionText`は`projection`がある場合だけ、cwdと`session:<id>`とtitle（`untitled` fallback）を返す。
   `footerModelText`は`projection.model`がある場合だけprovider・model・effortを返す。
2. `layoutUi`の`footerCount`を、status行＋session行＋model行の存在と高さに応じて1〜3へ更新する。
   standard（rows≥24）とrows≥5では全行、rows3〜4ではstatus＋session行、rows2ではstatusのみ、rows1では0。
3. footer配列をstatus、session、modelの順で組み立てる。
4. 既存test（`increment_13`・`increment_15`・`tui_conversation_presentation`）のfooter期待を3行へ更新し、
   Session title表示とrename反映のfocused testを追加する。
5. roadmap F01／F10／TUI節、architectureのSurface記述、`v0/agent/README.md`のfooter記述を3行へ更新する。
6. focused test、`v0:check`、`v0:fmt`、`v0:lint`、`git diff --check`、authoritative `v0:gate`を実行する。

## 対象外

- 新しいprotocol field、保存schema、Presentation contractの変更。
- footerの色付け、ラベルのdata化、Surface差し替え。
- Session titleの新規保存やrename semanticsの変更。
- 高さ・幅しきい値や`MIN_ROWS`／`MIN_COLUMNS`自体の見直し。

## Human Gate

2026-09-19、利用者は3行化の方針、ラベル維持、Session title未設定時の`untitled`表示、およびroadmap・
architecture・component READMEの該当記述更新を承認した。

## 結果

- `v0/tui/layout.ts`の`footerIdentityText`を`footerSessionText`と`footerModelText`へ分割した。
  `footerSessionText`は`[<cwd> session:<短縮ID> <title>]`、`footerModelText`は
  `[provider:<provider> model:<model> <effort>]`を返す。
- `layoutUi`の`footerCount`をstatus＋session＋modelの最大3行へ更新し、狭い高さではstatus、session、modelの
  優先で落とす。rows3〜4ではstatus＋session、rows2ではstatusのみ。
- 幅不足時はcwdをsuffix省略し、なお不足する場合はpath→title→modelの順に省略する既存方針を維持した。
- 既存testを3行構成へ更新し、Session title表示と`session_title`による即時更新のfocused testを追加した。
- roadmap F01／F10／TUI節、architecture Surface記述、`v0/agent/README.md`を3行footerへ更新した。

## Verification結果

- focused test: `increment_13`（5件）、`increment_15`（6件）、`tui_conversation_presentation`（14件）pass。
  TUI suite（`current_code`・`tui_*`・`keymap`・`auto_compaction`）は91件pass。
- `v0:check`／`v0:fmt`／`v0:lint`／`git diff --check`／authoritative `v0:gate`を実行する。
- live provider、実TTY、compiled binaryは対象外。
