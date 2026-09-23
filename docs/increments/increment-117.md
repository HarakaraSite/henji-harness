# Increment 117 — 未使用の履歴処理と旧UI経路の除去

状態: 実装・検証・既存DB切替・配置完了

## 目的と根拠

- 通常利用でキャンセルした一実行に約4.5万件の診断attachmentが残り、現行の読者がいない
  `human_history_entries`へ展開する処理が起動時にも実行された。
- `henji history`の`session`／`canonical`はSession正本を、`detail`はexecution・semantic occurrence・
  diagnostic attachmentを直接読む。TUIの`/history`閲覧はIncrement 99で廃止済みである。
- provider evidenceのattributionではrequest treeを複数回cloneしていた。旧`history_page`とSession
  JSONファイルcodecは現行productから呼ばれない。
- 利用者は上記の処理・残存経路すべての削除計画を承認した。既存v8 SQLite DBは保存せずDBごと削除する方針も
  明示的に選択した。これにより既存Session・診断記録は失われる。

## 対象と実装

1. 永続化human history行、三つの投影outbox、prototype専用の`history_projection_entries`、投影の
   書込み・読取・drainと専用testを削除する。CLIの三形式とsemantic／diagnosticの保存・readbackは維持する。
2. provider evidenceを一度cloneし、複製済みrequestへattributionを追加する。
3. `session_turns`を採用turnとexecutionの唯一の対応表とし、`canonical_turns`と
   `session_heads.canonical_execution_id`を削除する。`session_heads.revision`の競合確認、同一transaction内の
   採用、`executions.adoption`は維持する。
4. 旧`history_page`のTUI／presentation／Worker経路と旧Session JSONファイルcodecを削除する。メインログの
   PageUp、Session validation、context用の履歴indexは維持する。
5. v7保存モデルのSQLite schema versionを8から9へ更新する。v8からのmigrationや互換読取は作らない。
   安定した新binaryの用意と検証後に、対象workspaceの旧DB本体とWAL／SHMを、Henji停止状態で削除する。

## 確認

- focused testでcanonical完了、non-canonicalキャンセル、再起動復元、`henji history`三形式、`/recall`、
  診断attachmentとprovider evidenceのreadbackを確認する。
- 新DBに不要な六表がなく、旧UI intentとcodecへのproduct参照がないことを確認する。
- type check、format、lint、`git diff --check`を行い、安定候補へ`v0:gate`を一回実行する。
- TUI Surface変更は隔離XDG・tmuxのproduction TUIで起動、PageUp、Session切替を確認する。実provider callは
  今回の確認に含めない。

## 対象外

- 新規実行での診断記録の粒度・保存期間の変更。通常利用メモA9に未採用候補として残す。
- `diagnostic_attachments`、`immutable_contents`、`session_turns`、`derived_documents`の削除。

## 実装・検証結果

- 永続化human history投影と三つのoutbox、prototype専用投影表、旧history page経路、旧Session JSONファイル
  codecを除去した。provider evidenceのrequestsは複製済みの一つのtreeへattributionを追加する。
- `session_turns.execution_id`へ一意制約とexecutionへの外部キーを付け、`canonical_turns`の重複書込みを
  廃止した。Session削除では、参照元の`session_turns`を先に削除する順序へ変更した。
- 新規SQLite schema version 9。focused testでは通常完了、キャンセル、再起動復元、診断attachment、
  `henji history`のexport、`/recall`、Session削除、provider evidence attributionを確認した。
- 隔離XDGのproduction TUI（実provider callなし）で、保存Sessionの表示、PageUpによる`history rows`への
  スクロール、`/sessions`から別Sessionへの切替を確認した。隔離DBの実CLIで`session`／`canonical`／
  `detail`（56行のJSONL）と`sessions list`を確認した。
- authoritative `v0:gate`は初回のtest型誤記を修正後に再実行してexit 0。`git diff --check`も成功。
- コードと正本変更はcommit `5a4cc32f`、診断記録保存方針の未採用メモは別commit `ca4014cb`。
  そのclean sourceからHenji 0.5.0（build `1a1beb0d…`、SHA-256 `c1c93566…`）を作り、
  `~/.local/bin/henji`へ原子的に配置した。pushとreleaseは行っていない。
- 稼働中のHenjiがいないことを確認し、現在workspaceの既存v8 `history-v7.sqlite3`とWAL／SHMを削除した。
  配置済みbinaryの`sessions list`で空の新DBを生成し、`PRAGMA user_version=9`、不要な六表がないことを確認。
  `henji history --latest --view session`は`# no history`を返した。既存Session・診断記録は選択された方針どおり
  失われた。実provider callは行っていない。
