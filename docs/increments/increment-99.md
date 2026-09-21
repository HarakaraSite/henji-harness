# Increment 99 — `/history`廃止と`henji history` CLIへの統一（S11/S12統合）

ステータス: **計画（利用者承認済み・実装前、review反映済み）**

計画日: 2026-09-21

関連: 通常利用メモS11（`/history`の人間可読性とAI利用）、S12（別プロセスからのSession参照viewer）、
Increment 43（human history view）、Increment 94（history v7 authority）、
[`roadmap.md`](../roadmap.md) F01／F05／F10、[`henji-host-agent-worker.md`](../architecture/henji-host-agent-worker.md)。

## 利用者が必要とする動作

- TUI内の参照は**メイン会話ログのPageUp**に一本化する（現在Sessionのcommitted turn）。
- 任意Session・詳細内容の参照は、**別ペインで`henji history` CLI**を実行して行う。
- `henji history`は3種類の内容をstdoutへ出力でき、`--out`でファイルにも書ける。`glow -p`／`vi`／`less`／
  file redirectと自由に組み合わせられる。
- 検索はviewer側（`vi`／`glow`／`less`／tmux copy-mode）で行う。CLIに組み込み検索は持たせない。
- 保存SessionをTUI内でresumeせず眺める手段は失うが、`/sessions`で開き直せばメインlogで参照できる。

## 決定事項（利用者判断）

- `/history`、`/history export`、`/history export all`、pickerの`v`を**廃止**し、`henji history` CLIへ統一する。
- 3種類の内容:
  1. `session`: **resume時のメインlog相当**（committed canonical turnのみ）。メインlogと同じlabel
     （`user>`／`assistant>`／`tool>`／`system>`）、tool結果は`tool>`のactivity textへ畳み込む（`tool<`や
     `[tN]`は出さない）、assistant本文は生Markdown。non-canonicalは含めない。
  2. `canonical`: 現行`/history export`相当の構造化Markdown（`## Turn N`／`### user>`／fenced）。
  3. `detail`: 現行`/history export all`相当のdurable JSONL（non-canonicalも含む）。
- 既定値: `--view session`、`--session --latest`、`--out`なしはstdout。`--follow`は入れない（snapshot）。
- 非canonical（rejected/cancelled）の**人間可読な参照経路は本incrementでは提供しない**。必要になった時点で
  別途検討する。roadmap F05はこの範囲で「部分実装」へ下げる。

## 対象範囲

- 新CLI subcommand `henji history`。
- **read-only read port**: v7 DBを`DatabaseSync(path, { readOnly: true })`で開き、`initialize()`／reconcile／
  schema作成／lock取得を行わない。read-only seamをstore側に追加する。
- **出力sinkの分離**: Markdown／JSONLの「組み立て」と「出力先（stdout／`--out` path）」を分離する。既存
  `DenoHistoryExporter`／`DenoHumanHistoryExporter`は常にstate rootへ一意fileを作る専用のため、生成部分を
  公開し、CLIがstdout／指定pathへ書く。TUI専用のreceipt付きfile出力は不要になるので削除する。
- **単一snapshot read**: exportは1回のread-only接続（単一read transaction）でexecution一覧・occurrence・
  content・manifest・diagnosticを読む。live writerと並行してもある時点の一貫したsnapshotを返す。
- **空DB挙動**: 履歴DBが無いworkspaceでは「履歴なし」を表示して正常終了（0）する。
- TUIからのhumanHistory overlay／export一式の削除。

## 対象外

- 非canonical（rejected/cancelled）を含む**人間可読**viewer（F05部分実装化。必要時に別途）。
- `--follow`（live追従）。
- 組み込み検索（viewer側で代替）。
- 実provider call。
- AI（model／tool）からのhistory参照（A2）。

## 実装計画

1. **read-only read port**: workspace digestからv7 DB pathを算出し、read-only接続を開く。store側に
   `readOnly` seamを追加し、schema作成・reconcile・lockをskipする。提供するread:
   (a) session一覧（`--latest`用、`updated_at`降順）、(b) sessionのcanonical transcript＋metadata
   （`session`／`canonical`用）、(c) `streamHumanHistoryExport`相当（`detail`用）。単一接続で読む。
2. **session view出力**: 対象Sessionのcanonical transcriptを`restored_log`と同じ投影
   （`restoredPresentationMessages`＋`pendingToolActivityText`／`settledToolActivityText`／
   `toolActivityPreview`）でメインlog形式に整形し、stdout／`--out`へ書く。
3. **canonical view出力**: 既存のMarkdown生成（`markdownChunks`相当）を公開関数へ切り出し、CLIが
   stdout／`--out`へ書く。
4. **detail view出力**: 既存JSONL生成（`streamHumanHistoryExport`）を単一read-only接続で回し、CLIが
   stdout／`--out`へ書く。
5. **CLI配線**: `henji_cli.ts`へ`history` subcommandを追加。`--session <id>`／`--latest`／
   `--view session|canonical|detail`／`--out <path>`をparse。`--session`は完全UUID（現行`isSessionId`と同じ）。
   `--latest`は**同一cwd/workspace前提**で最後に更新されたSession。出力先頭に`# session <id>`を出す。
   エラーは他subcommandと同じ`{ok:false,error:{code}}`をstderrへ。
6. **TUI削除**: `slash_command.ts`から`history`／`history_export`／`history_export_all`を削除。
   `controller.ts`のhumanHistory状態、`startHumanHistory`、`processHumanHistoryEvent`、
   `moveHumanHistoryVisualPage`、`startHistoryExport`、`history-exporting`状態、export分岐を削除。
   `controller_overlay.ts`のpicker `v`（`viewSession`）を削除。`layout.ts`のhumanHistory描画、
   `state.ts`のhumanHistory overlay型、`tui_renderer.ts`の`renderHumanHistory`、adapterの
   `humanHistoryReader`／`humanHistoryExporter`配線と`human_history_*` intent／resultを削除。
7. **正本更新**: roadmap F01／F05、architecture（下記diff案）。
8. **検証**: focused test更新、tmux確認、authoritative `v0:gate`、commit／build／配置。

### 複雑化した場合の簡素化案

単一snapshot readが複雑になりすぎる場合の優先順位:

1. **`detail`（JSONL）を本incrementから外す**。`session`／`canonical`はcanonical transcript（単一table）だけを
   読むため、単一接続で容易に一貫性を保てる。`detail`は後続incrementで単一snapshot版として追加する。
2. それでも複雑なら、`canonical`も`session`に統合し、`session`＋`detail`の2種類に減らす。
3. 最後の手段として`--out`を外し、stdoutのみにする（`> file`で代替可能）。

いずれも利用者に戻して判断する。

## 正本変更案（利用者承認済み・review反映）

### roadmap F01（現在のSurface実装であるproduction TUI節）

- slash command一覧から`/history`・`/history export`・`/history export all`を削除する。
- 「`/history export`はcurrent bindingのcommit済みcanonical transcriptを…保存する」の文を削除する。
- 参照はメインlogのPageUpと、別ペインの`henji history` CLI（`session`／`canonical`／`detail`、stdout／
  `--out`）で行う旨を追記する。

### roadmap F05

- `/history` overlayとliteral検索を廃止し、`henji history` CLIへ統一した旨へ更新する。検索は出力をviewer
  （`vi`／`glow`／`less`）で行うため、product組み込みのliteral検索は持たないと明記する。
- 非canonical／diagnosticの**人間可読**参照を失うため、現コード状態を**部分実装**へ下げる。canonical/non-canonical
  のdurable data（`detail` JSONL）と`/recall`は維持する。

### architecture（Terminal TUI Surface節、477-481行付近と85-87行）

- `/history export`の段落を削除し、read-only viewerは別プロセスの`henji history` CLIが担い、v7 storeを
  read-only（単一snapshot）で読む（TUIプロセスとは独立、credential不要）ことを追記する。
- 「人間向けhistory viewはcanonical/non-canonical双方へ到達できる方向を保つ」（85-87行）を、本incrementでは
  canonicalはメインlog＋CLI、non-canonicalは`detail` JSONLのみで、人間可読viewは将来項目である旨へ更新する。

## product動作と検証の対応

| product動作 | 確認方法 |
| --- | --- |
| 別ペインから現在Sessionの会話を参照できる | `henji history --latest --view session`をstdoutで実行し、committed turnがメインlog形式（`user>`／`assistant>`／`tool>`、`tool<`なし）で出る |
| 詳細と構造化exportをCLIで得られる | `--view canonical`（Markdown）と`--view detail`（JSONL）を出力し、廃止前の`/history export`／`/history export all`と同一Sessionで内容一致する |
| fileへ書ける | `--out <path>`で保存し、stdoutとbyte一致する |
| 並行writeでsnapshotが壊れない | henji書き込み中に`--view detail`を複数回実行し、execution一覧・occurrence・manifestが同一時点で整合する |
| 空workspaceで正常終了する | 履歴DBなしで`henji history --latest`が「履歴なし」を出してexit 0 |
| TUIから`/history`系が消え、参照がメインlogに一本化される | tmuxで`/history`がunknownになり、PageUpで現在Sessionを遡れる |
| 保存Sessionをresumeせず閲覧する手段が消える | pickerに`v`がなく、`/sessions`→resume→PageUpで参照できる |
| 履歴参照がcredentialなしで成立する | credential欠如の隔離XDGで3 viewが成功する |

test件数は完了条件にしない。各testは上表のproduct動作へ対応させる。

## review結果と対応（2026-09-21、独立サブエージェント2件）

通常reviewと批判的reviewを実施し、双方 `Conditional Go`。主な指摘と対応:

- **検索の喪失**: 利用者判断で組み込み検索は持たず、viewer側検索に代替。F05/F01文言を修正。
- **exporterがstdout／`--out`非対応**: 出力sinkを分離する計画へ変更。
- **非canonical人間可読経路の喪失**: F05を部分実装へ下げ、architectureを更新。必要時に別途。
- **atomic snapshot**: 単一read-only接続で読む計画へ変更。簡素化案を併記。
- **read-only seamと空DB**: seam追加と「履歴なし」exit 0を計画へ追加。
- **session viewの形式**: メインlogは`tool>`に結果を畳み込み`tool<`を出さないため、`[tN]`／`tool<`を使わない
  仕様へ修正。
- **`--latest`の前提**／**CLIエラー契約**／**removal網羅（`human_history_*`、README）**／**F10陳腐化**: 計画へ
  反映。F10の正本更新は別承認とする。

## 未確認事項

- `session` viewを`glow`で見たときの見やすさ（tool activity行とassistant Markdownの混在）。
- 単一read-only接続での`detail`生成が現行store構造（`#coreStore()`依存）でどこまで流用できるか。
- `--out`の既定path（値を省略した場合）を持つか。今回は必須引数とし、省略時はstdoutのみ。
- TUI削除に伴う`presentation` contractの`human_history_*` intent／resultの完全削除範囲。
