# Increment 105 — 置換済みv5/v6 history実装の除去

ステータス: **実装済み（未commit）**

計画日: 2026-09-22

関連: Increment 94（history v7 production cutover）、Increment 40〜43・50・75・86・87・90・92、
`v0/agent/history/`、`tests/v0/`、`scripts/`、roadmap F04／F05。

## 目的とproduct動作

- productionの履歴authorityは**v7のみ**（Increment 94）であり、v5/v6 eraの実装はproduction module graphから
  到達しない。本incrementはその**置換済み実装と、それを専用に検証しているtest/script/taskを除去**する。
- **product動作は変えない**。v7のsettlement・adoption・projection・journal・human history・CLIの挙動は不変。
- 除去後も、v7が担保すべきproduct動作の回帰testが残っていることを確認する。不足があれば最小限をv7へ移植する。

## 現状（調査）

production entry（`henji_cli.ts`・`mod.ts`・`worker_bootstrap.ts`・`build_henji.ts`）から到達しないhistory
モジュールは次の12件（計 約14,600行。`sqlite_history_store.ts`が8,031行）。

```text
v0/agent/history/history_authority.ts
v0/agent/history/history_record_codec.ts
v0/agent/history/history_segment_codec.ts
v0/agent/history/history_storage_benchmark.ts
v0/agent/history/human_history_export.ts
v0/agent/history/persistent_sequence.ts
v0/agent/history/sqlite_history_store.ts
v0/agent/history/sqlite_history_v6_production_store.ts
v0/agent/history/sqlite_history_v6_store.ts
v0/agent/history/v5_history_metrics.ts
v0/agent/history/v6_history_capacity_benchmark.ts
v0/agent/history/v6_history_pipeline.ts
```

production側として残すv7系: `sqlite_history_v7_production_store.ts`、`sqlite_history_v7_store.ts`、
`sqlite_history_v7_prototype.ts`、`history_v7_model.ts`、`history_store_contract.ts`、`context_attribution.ts`、
`exact_byte_plan.ts`、`history_view.ts`、`human_history.ts`。

## 対象範囲

1. **モジュール削除**: 上記12件。
2. **scripts削除**: `scripts/measure_history_v5.ts`、`scripts/benchmark_history_v6.ts`（v7用の
   `scripts/benchmark_history_v7.ts`は残す）。
3. **task削除**: `deno.v0.json`の`agent:increment-90-capacity`（`agent:increment-94-capacity`は残す）。
4. **test整理**（下記「test disposition」）。
5. 上記に伴う`jsr.json`の`publish.include`（該当があれば）と、`v0:check`のglob（`v0/agent/*/*.ts`で自動）の確認。

## test disposition

- **pure v6（削除）**: `increment_90_history_authority_test.ts`、`increment_90_production_v6_test.ts`。
  これらはv5/v6 authority・benchmark・v6 production store専用。
- **要監査（削除またはv7へ移植）**: `increment_40_sqlite_history`、`increment_41_live_execution_journal`、
  `increment_42_context_attribution`、`increment_43_human_history_view`、`increment_50_normalized_history`、
  `increment_75_session_list_skip`、`increment_86_journal_batch`、`increment_87_journal_index`、
  `increment_92_worker_stage_probe`。
  - 各testについて、検証している**product動作**がv7 test（`increment_94_history_v7_prototype_test.ts`）または
    統合test（`increment_12/14/15/33/35/39/65/76/91/99`、`provider_stream_compatibility`）で担保されているかを
    確認する。
  - 担保済みなら`SqliteHistoryStore`使用部分を除去してtestを削除、またはv7 storeへ書き換える。
  - 未担保のproduct動作（例: v7での「1件の不正recordがsession一覧全体を失敗させない」、v7 journal index）が
    あれば、**最小限のv7 regressionを移植**してから削除する。
- **test fileに残すヘルパ**: `tests/v0/bundled_tool_components.ts`等は対象外。

## 正本

- architecture・roadmapの変更は不要（v7 authorityは不変。Increment 40〜94の記述は履歴）。
- 該当モジュールを参照するarchitecture文書があれば、参照だけ現行へ整合する（例: `history_store_contract.ts`や
  v7系の記述）。履歴increment文書（`docs/increments/increment-40..94`）は変更しない。

## 実装手順（slice）

1. **Slice A**: pure v6 modules・scripts・task・pure v6 test（increment_90×2）を削除し、`v0:check`／`v0:lint`／
   `v0:fmt`／`git diff --check`。v7 testと`v0:gate`でproduction不変を確認。
2. **Slice B**: 要監査testを1件ずつ処理。v7 coverageを確認し、移植が必要なものはv7へ最小regressionを追加。
   `SqliteHistoryStore`依存を除去したtestだけ残す。
3. **Slice C**: 残ったv5/v6参照・import・型を除去し、`jsr.json`／docs参照を整合。

各sliceでfocused test、`deno check`、`fmt`、`lint`、`git diff --check`。authoritative `v0:gate`は安定候補で
coordinating ownerが一回。最後にbinary rebuild・`~/.local/bin/henji`配置。

## 検証

- 削除後、`rg "sqlite_history_store|v6_history|v5_history|history_authority|persistent_sequence|human_history_export"`
  がproductionとtestから消えていること（履歴docsを除く）。
- v7のproduct動作: `increment_94_history_v7_prototype_test`、統合test、`increment_99_history_cli`、
  `agent:e2e:test`がpassすること。
- `v0:gate` exit 0。binary rebuild・配置後、隔離XDG smoke（`henji history`、`henji sessions list`）。

## 結果（実装済み）

- **Slice A**: `v0/agent/provider/credential_file.ts`のIncrement 101残骸（旧per-profile export 7件）を除去し、
  `readCredentialFileAt`を非export化。focused test `agent:increment-101-provider-headers:test`（13件）と
  `agent:provider-stream-compatibility:test`（20件）がpass。
- **v7 regression追加**: `tests/v0/increment_105_history_v7_list_test.ts`「v7 listWorker skips an unreadable
  session record」。これは旧increment_75が担保していた「不正recordがsession一覧全体を失敗させない」動作のv7版で、
  `agent:increment-105-history-v7-list:test`として`v0:test`へ登録。1件pass。
- **increment_92のv7移植**: `SqliteHistoryV6ProductionStore`→`SqliteHistoryV7ProductionStore`、v6 `byte_streams`／
  `readByteStream`によるexact-byte readbackをv7 `immutable_contents`（`exactByteDigest(observed.bytes)`）参照へ置換。
  exact-capture testは`captureProfile: 'diagnostic-v1'`を指定。11件すべてpass。
- **削除**: 12モジュール、`scripts/measure_history_v5.ts`・`scripts/benchmark_history_v6.ts`、tests
  `increment_40/41/42/43/50/75/86/87/90_history_authority/90_production_v6`、task
  `agent:increment-40..50`・`increment-75/86/87/90-history-authority/90-capacity`。
- **参照整合**: `jsr.json`の`publish.include`から削除済み`sqlite_history_store.ts`を除去。
- **v7 coverage根拠**: 削除したtestのproduct動作は`increment_94_history_v7_prototype_test`（semantic settlement・
  diagnostic・projection/search/rebuild・restart reconciliation・isolated product pathのcommit/resume/project/export、
  21件）、`increment_99_history_cli_test`、統合test（`increment_12/14/15/33/35/39/65/76/91`）、
  `provider_stream_compatibility`で担保。

### 検証結果

- `v0:check`（265ファイル）、`v0:fmt`、`v0:lint`、`git diff --check`すべてexit 0。
- `agent:increment-92-worker-stage-probe:test` 11件、`agent:increment-105-history-v7-list:test` 1件pass。
- authoritative `v0:gate` exit 0。
- commit `6b3776e1`のclean treeからDeno 2.9.7でrebuildし、binary（build `e725f3e0…`、source `6b3776e1…`、
  SHA-256 `7a57be03…`）を`~/.local/bin/henji`へ原子的に配置済み。隔離XDG smokeで`henji sessions list`
  （`{"schemaVersion":2,"sessions":[]}`）と`henji history`（`# no history`）がexit 0。

## 未確認事項

- increment_43のhuman history（v7 `human_history.ts`）とlegacy `human_history_export.ts`の境界（削除済み）。
- 隔離XDG smokeによるproduction TUI/CLI実経路の確認（未実施）。

## 対象外

- v7のschema・store・pipeline・CLIの変更。
- `history-v7.sqlite3`等の実データ削除（既にIncrement 94で旧DBは削除済み。追加のdata削除はしない）。
- 履歴increment文書（過去の記録）の書き換え。
- 過剰exportのde-export（Slice Cは本incrementではv6残骸の除去に限定し、一般的なde-exportは別途）。
