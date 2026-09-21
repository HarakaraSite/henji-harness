# Increment 99 — `/history`廃止と`henji history` CLIへの統一（S11/S12統合）

ステータス: **計画（利用者承認済み・実装前）**

計画日: 2026-09-21

関連: 通常利用メモS11（`/history`の人間可読性とAI利用）、S12（別プロセスからのSession参照viewer）、
Increment 43（human history view）、Increment 94（history v7 authority）、
[`roadmap.md`](../roadmap.md) F01／F05／F10、[`henji-host-agent-worker.md`](../architecture/henji-host-agent-worker.md)。

## 利用者が必要とする動作

- TUI内の参照は**メイン会話ログのPageUp**に一本化する（現在Sessionのcommitted turn）。
- 任意Session・詳細内容の参照は、**別ペインで`henji history` CLI**を実行して行う。
- `henji history`は3種類の内容をstdoutへ出力でき、`--out`でファイルにも書ける。`glow -p`／`vi`／`less`／
  file redirectと自由に組み合わせられる。
- 保存SessionはTUI内でresumeせず眺める手段を失うが、`/sessions`で開き直せばメインlogで参照できる。

## 決定事項（利用者判断）

- `/history`、`/history export`、`/history export all`、pickerの`v`を**廃止**する。
- `henji history` CLIへ統一する。
- 3種類の内容:
  1. `session`: **resume時のメインlog相当**（committed canonical turnのみ）。メインlog風label＋
     `toolActivityPreview`＋生assistant Markdown。non-canonical（rejected/cancelled）は含めない。
  2. `canonical`: 現行`/history export`相当の構造化Markdown。
  3. `detail`: 現行`/history export all`相当のdurable JSONL。
- 既定値: `--view session`、`--session --latest`、`--out`なしはstdout。`--follow`は入れない（snapshot）。

## 対象範囲

- 新CLI subcommand `henji history`。
- v7 storeをread-onlyで開くread port（`initialize()`／reconcileを呼ばない）。
- 3種類の出力モジュール（`session`は新規、`canonical`／`detail`は既存exporterを再利用）。
- TUIからのhumanHistory overlay／export一式の削除。

## 対象外

- non-canonical（rejected/cancelled）を含むviewer。必要になった時点で別途。
- `--follow`（live追従）。
- 実provider call。
- AI（model／tool）からのhistory参照（A2）。

## 実装計画

1. **read-only read port**: workspace digestからv7 DB pathを算出し、`DatabaseSync(path, { readOnly: true })`で
   `readHumanHistoryPage`／`readHumanHistoryDetail`／`searchHumanHistory`相当のreadを提供する。reconcileや
   lock取得を行わない。
2. **session view出力**: 対象Sessionのcanonical transcriptを取得し、`[tN] user>`／`assistant>`／`tool>`
   （`toolActivityPreview`）／`tool<` をMarkdownで出力する。assistant本文は生Markdown（`glow`が渲染）。
   `restoredPresentationMessages`相当の投影を再利用し、tool previewは`tool_activity.ts`を使う。
3. **canonical view出力**: 既存`DenoHistoryExporter`（Markdown）をCLIから呼ぶ。`--out`へfile出力、なければstdout。
4. **detail view出力**: 既存`DenoHumanHistoryExporter`（JSONL）をCLIから呼ぶ。
5. **CLI配線**: `henji_cli.ts`へ`history` subcommandを追加。`--session <id>`／`--latest`／`--view`／`--out`をparse。
   `--latest`はworkspaceで最後に更新されたSession。credential不要。
6. **TUI削除**: `slash_command.ts`から`history`／`history_export`／`history_export_all`を削除。
   `controller.ts`のhumanHistory状態、`startHumanHistory`、`processHumanHistoryEvent`、
   `moveHumanHistoryVisualPage`、`startHistoryExport`、`history-exporting`状態、`popRecovery`相当のexport分岐を
   削除。`controller_overlay.ts`のpicker `v`（`viewSession`）を削除。`layout.ts`のhumanHistory描画を削除。
   `tui_renderer.ts`の`renderHumanHistory`、adapterの`humanHistoryReader`／`humanHistoryExporter`配線を削除。
7. **正本更新**: roadmap F01／F05、architecture（下記diff案）。
8. **検証**: focused test更新、tmux確認、authoritative `v0:gate`、commit／build／配置。

## 正本変更案（利用者承認済み）

### roadmap F01（現在のSurface実装であるproduction TUI節）

- slash command一覧から`/history`・`/history export`・`/history export all`を削除する。
- 「`/history export`はcurrent bindingのcommit済みcanonical transcriptを…保存する」の文を削除する。
- 参照はメインlogのPageUpと、別ペインの`henji history` CLIで行う旨を追記する。

### roadmap F05

- 「Increment 43の`/history`が持つtimeline、literal検索、canonical Markdown export、durable JSONL exportを…」の
  記述を、`/history` overlayを廃止し、`henji history` CLI（`session`／`canonical`／`detail`）へ統一した旨へ更新する。
  literal検索はCLIの`--query`（実装する場合）または端末側検索に置き換わる。

### architecture（Terminal TUI Surface節、477-481行付近）

- `/history export`の段落を削除し、read-only viewerは別プロセスの`henji history` CLIが担い、v7 storeをread-onlyで
  読む（TUIプロセスとは独立、credential不要）ことを追記する。
- humanHistory overlay／picker `v`の記述があれば削除する。

## product動作と検証の対応

| product動作 | 確認方法 |
| --- | --- |
| 別ペインから現在Sessionの会話を参照できる | `henji history --latest --view session`をstdoutで実行し、committed turnがメインlog風に出る |
| 詳細と構造化exportをCLIで得られる | `--view canonical`（Markdown）と`--view detail`（JSONL）を出力し、既存exporterと一致する |
| fileへ書ける | `--out <path>`で保存し、内容をreadbackする |
| TUIから`/history`系が消え、参照がメインlogに一本化される | tmuxで`/history`がunknownになり、PageUpで現在Sessionを遡れる |
| 保存Sessionをresumeせず閲覧する手段が消える | pickerに`v`がなく、`/sessions`→resume→PageUpで参照できる |
| 履歴参照がcredentialなしで成立する | credential欠如の隔離XDGでCLIが成功する |

test件数は完了条件にしない。各testは上表のproduct動作へ対応させる。

## 未確認事項

- `session` viewの出力を`glow`で見たときの見やすさ（tool preview行とassistant Markdownの混在）。
- `--out`の既定path（値を省略した場合）を持つか。今回は必須引数とし、省略時はstdoutのみ。
- 既存`DenoHumanHistoryExporter`の出力がCLIのstdoutへそのまま流せるか（receiptの扱い）。
- TUI削除に伴う`presentation` contractの`human_history_*` intent／resultの扱い（削除するか未使用で残すか）。
