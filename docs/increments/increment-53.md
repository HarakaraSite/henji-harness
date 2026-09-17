# Increment 53 — TUI startupのactive base表示とsession pickerのlocal time・1行化

ステータス: **完了**

基準commit: `57d8bddd`

計画日: 2026-09-17

対象候補: `docs/experience/normal-use-inbox.md` の S8、S6

## 利用者が必要とする動作

1. TUI起動時のorientationで、現在のWorker generationが使うHenji base instructionのresource ID、
   built-in/external selection source、識別可能な短縮revisionを独立した行で確認できる。workspace
   `AGENTS.md`の有無を示す`context:`行は別の意味として残す。
2. Session pickerは各Sessionを1行で表示し、更新日時をHenjiを実行している環境のlocal timezoneで示す。
   title、短縮ID、turn数、current/resumable/unavailableを同じ行に含める。保存済みtimestampの形式は変えない。

## 計画

### S8 — startup orientationのactive Henji base表示

- `v0/agent/runtime/startup_orientation.ts`の`RuntimeDisplayState`と、`v0/presentation/contract_types.ts`の
  `PresentationStartupState`へ、data-onlyな`baseInstruction`を追加する:
  `{ resourceId: string; selectionSource: 'built-in' | 'external'; revisionDigest: string }`。
- `v0/agent/worker/worker_tui_session.ts`は既に解決済みの`SelectedHenjiBaseInstruction`を保持しているため、
  その`ref.resourceId`、`selectionSource`、`ref.revision.digest`を`projectRuntimeDisplayState`へ渡す。
  built-in選択時は`resourceId = 'builtin/henji-base'`、`selectionSource = 'built-in'`を使う。
- `v0/tui/startup_render.ts`のfull layoutに、`context:`行の隣へ
  `content('base:', `${resourceId} · ${selectionSource} · ${shortDigest}`)`を追加する。表示例は
  `base: local/henji-base · external · 82d67dd2`とする。short digestはdigest先頭8文字。
- `context:`行はworkspace instructionの有無を示す現行の意味のまま変更しない。
- compact layout（`width < 64 || rows < 16`）は現行の2行を維持し、base行を出さない。
- resourceIdはescapeし、`MAX_RUNTIME_DISPLAY_STATE_BYTES`のbound内に収まることを確認する。
- 表示専用とし、Worker、Definition評価、instruction composition、canonical history、context attributionを
  変更しない。`henji instruction`のinstall/activate/deactivateも変更しない。

### S6 — session pickerのlocal time・1行表示

- `v0/tui/layout.ts`のsession pickerを1 Sessionあたり1行に変更する。形式は
  `<marker> <local更新日時>  <title> · <id8> · <turnCount> turns · <availability>`とし、`columns`に合わせて
  現行同様にtruncateする（`marker`は選択中`>`、他は空白）。
- 更新日時は保存済み`updatedAt`のISO文字列を表示時にだけlocal timezoneへ変換する。`new Date(value)`の
  local getterから`YYYY-MM-DD HH:MM`を組み立て、現行の`Z`表記をやめる。invalid値は`unknown`とする。
  保存値、Session schema、SQLiteのtimestamp形式は変更しない。
- page表示、Up/Down選択、Left/Right page、Enter resume、`current`/`resumable`/`unavailable`の意味、
  `no sessions`/`loading`表示は変更しない。

## 対象外

- S2、S4、S5、S7、A系、R系、E1の他候補
- 保存timestampの形式変更、Session schema変更、migration、fallback
- Worker protocol、instruction composition、attribution、canonical historyの変更
- 新規slash command、session pickerの機能追加（検索、削除、rename等）
- 構想、architecture、roadmapの変更

## Verification

- focused testで、full startup layoutにbuilt-inとexternalの`base:`行が出ること、compact layoutでは出ないこと、
  `context:`行が残ることを確認する。
- focused testで、session pickerが1 Session 1行になり、local time表記、title、id8、turns、availabilityを
  含むことを確認する。既存`tests/v0/tui_retained_terminal_test.ts`の2行・`Z`表記assertionを新product動作へ
  更新する。
- 変更箇所のtype check、format、lint、`git diff --check`を実行する。
- 実際の起動確認は、利用者の指示がある場合だけcompiled standaloneでTUIを起動して行う。実provider requestは
  不要であり、行わない。

## 規模見積り

表示用state fieldの追加、startup renderer、session picker layoutと関連testの更新に限定される。
**1〜2開発日相当**。

## Human Gate

実装前に、利用者は次を確認・承認する。

1. S8をstartup orientationのfull layoutの独立行とし、compact layoutでは省略する具体化。
2. `base:`行の表示形式`<resourceId> · <built-in|external> · <short digest>`と`context:`行を残す扱い。
3. S6を1 Session 1行とし、保存timestampを変えず表示時だけlocal timeへ変換する具体化。
4. 実provider requestを行わない検証水準。

2026-09-17、利用者はこの計画を承認し、実装を指示した。

## 実装・検証結果

- `RuntimeDisplayState`（`startup_orientation.ts`）と`PresentationStartupState`（`contract_types.ts`）へ
  optionalな`baseInstruction`を追加した。`projectRuntimeDisplayState`は指定時にresourceId・selectionSource・
  revisionDigestをboundして保持し、未指定時はfieldを持たない。
- `worker_tui_session.ts`はgeneration開始前に解決済みの`SelectedHenjiBaseInstruction`から`ref.resourceId`、
  `selectionSource`、`ref.revision.digest`を`projectRuntimeDisplayState`へ渡す。既存のmanaged instruction
  resolutionを再利用し、新たな解決や追加requestは行わない。
- `startup_render.ts`のfull layoutは`agent:`の直後に
  `base: <resourceId> · <built-in|external> · <digest先頭8文字>`行を出す。compact layout
  （`width < 64 || rows < 16`）は現行2行を維持しbase行を出さない。`context:`行はworkspace instructionの有無を
  示す現行の意味のまま残した。
- `layout.ts`のsession pickerは1 Session 1行とし、`> <local更新日時>  <title> · <id8> · <turnCount> turns ·
  <availability>`を`columns`でtruncateする。更新日時は`updatedAt`のISO文字列を表示時にだけ`Date`のlocal getterで
  `YYYY-MM-DD HH:MM`へ変換し、`Z`表記をやめた。保存値、Session schema、SQLite timestamp形式は変更していない。
- focused testは`tests/v0/tui_retained_terminal_test.ts`のpicker assertionを1行・local timeへ更新し、startup base行の
  built-in/external表示、compactでの非表示、`context:`行の維持、`projectRuntimeDisplayState`のboundと未指定時挙動を
  追加した。
- 検証: 対象7 test file（`current_code`、`tui_conversation_presentation`、`tui_retained_terminal`、
  `tui_controller_overlay`、`tui_tool_preview`、`keymap_readline`、`auto_compaction`）は86 passed / 0 failed。
  変更対象のtype check、format、lint、`git diff --check`は成功した。実provider requestは行っていない。
- 未実施: push、compiled standaloneでの実機TUI起動確認。実機確認は利用者の指示がある場合だけ行う。
- 利用者の明示指示により、実装をcommit `a8ac6a85`へ確定した。そのclean commitからbuild
  `beddeb779debf2d93ef11d4adff5ac64ae8343549e7a5cb45aec2f312a90d6a3`を生成し、`dist/henji`と
  `~/.local/bin/henji`を同一artifactへatomic置換した。両方のSHA-256は
  `196b8ae8378d8a54239bd647fdba4e173d3fd57a39cc77a0e4051251ef767dbb`であり、導入版はsource
  `a8ac6a85828131a36e49b0cb20a76afcc733b680`、`sourceDirty=false`を返した。
- 導入版の`instruction active`はexternal selectionと
  `local/henji-base@sha256:82d67dd29734d72e19b04977e5e7b4c57b0a05ea57ae90746116d78303535d98`を返し、
  置換後もactive bindingが維持されていることを確認した。実credential値は表示・copy・logせず、実provider
  requestは行っていない。tag、release、publishは行っていない。
