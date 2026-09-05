# Surface roadmap (rebuild)

Status: **archived — unapproved OpenCode draft**

Archive disposition: OpenCodeが現コードと参照実装から再構成した未承認draft。現在のroadmapは、
訂正済みの現在地、構想、architectureに基づいて別途作成するため、この文書は正本として使わない。

正本なしで現コードと参照実装（pi / zot / opencode / opencomputer / cloudflare-agents）から
立て直す。内部機構ではなく表面機能で整理する。F1文言は別incrementにparkしたまま。

## Operating principles (owner-approved)

- 安全作業は明示incrementに分離し、各increment計画に安全項目を混ぜない。
- reviewは機能・要件・実経路のみ。汎用安全reviewは行わない。
- 痛み駆動（既存修正）と構造比較（新規着手前）を使い分ける。

## Done (human-confirmed unless noted)

- FR5 Cycle 1–3: 通常画面・alternate隔離・tool行頭preview。
- Slash最小: `/help`・`/sessions`・`/exit`＋未知一覧（`/history`・`/context` は除外）。
- F1: `Henji help · 工事中` の1行のみ。指示あるまで触らない。
- Keymap (a): readline編集系（A/E/B/F、Alt+B/F、K/U/W、Alt+D）。
- Keymap (b): 改行はAlt+Return確定（Shift/Ctrl+Returnは端末依存）。
- Keymap (c): 機能系Ctrl除去（G/T/L/R/P/N）とUp/Down端履歴置換。
- 自動compaction: 送信前に64K到達＋有用境界で要約1件→成功時のみturn開始、
  失敗/取消は停止、通知はstatus＋system行。

## Deferred verification

- Shift/Ctrl+Returnの実端末確認（ghostty要設定の可能性）。
- 64K自然到達での自動compaction実確認（費用のため後回し）。

## Orphaned (code retained, no entry point)

- 履歴モーダル（`openHistory`）、contextパネル（`openContextPanel`）、回復（`popRecovery`）。
  自動compaction設計まで保持。slash再追加か復活は未決定。

## Backlog (undecided)

- #3: hook・tool許可/不許可の確認UI（次点本命）。
- edit前後diff表示、外部エディタ起動、tool個別展開。
- 追加slash候補：`/copy`、`/export`、`/import`、`/jump`、`/clear`、`/compact`、
  `/skills`・`/skill:<name>`、`/new`・`/resume`・`/fork`・`/tree`・`/session`・`/name`、
  `/settings`・`/reload`・`/quit`、`/jail`・`/unjail`、model系（将来枠）。
- コマンドパレット（opencode式一覧起動）。

## Phase B/C (concepts)

- Phase B: 外部TS定義の置き場・最小manifest・発見規則・検証・commit点・二段階trust。
  実行はdata-only＋prepare/materialize維持。
- Phase C（研究枠）: エージェント自身によるTS関数見直し・修正。成立条件のみ先に書く。
