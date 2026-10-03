# Increment 44 — post-SQLite consistency and obsolete-code cleanup

ステータス: **完了（2026-09-13）**

基準commit: `715cc366`

## 利用者が必要とする動作

- Increment 40〜43でSQLiteへ切り替えた後のproduct経路を一つにし、通常実行とdirect testで永続
  Sessionを使う場合はいずれもSQLiteを唯一のhistory正本とする。
- 旧Session JSON、provider evidence、failure diagnostic、execution artifactのfilesystem storeを実行module
  graphから除外する。既存の旧dataは削除、変更、移行しない。
- 現行product動作を確認するtestはSQLite経路へ移し、旧JSON形式または到達不能な実装だけを検証するtestは
  削除する。fixtureや過去の互換性を現行仕様として残さない。
- 到達不能なlegacy notice、未参照export、不要なcompatibility aliasを除き、現在の責務とmodule graphを
  読み取れる状態にする。
- 開発taskはsibling repositoryのDeno binaryへ依存せず、PATH上のDeno 2.9.6で再現できる。

## 根拠と確認済み状態

- Increment 40はSQLiteへの破壊的cutoverと、旧JSONのscan/import/compatibility read/fallback禁止を定義した。
- production TUIは既に`SqliteHistoryStore`を使うが、provider-free direct testと未使用のTUI runtime seamには
  旧`DenoSessionStore`経路が残っている。
- 旧filesystem storeとbarrel exportがproduction CLIのcompile graphへ入り、旧store前提のtestも通常suiteに
  残っている。`agent_worker_foundation_test.ts`は専用taskがある一方、`v0:test`から外れている。
- `worker_host_session.ts`のlegacy model noticeは一度もtrueにならず、presentationまで到達不能な分岐を持つ。
- `deno.v0.json`とrelease手順はsibling repository内のDeno 2.9.4絶対pathを参照する。
- [公式Deno 2.9.6 release](https://github.com/denoland/deno/releases/tag/v2.9.6)のARM64 binaryで、変更前の
  `check`、`lint`、`fmt --check`とIncrement 40〜43の54 testが成功した。2.9.6は
  [Deno 2.9 LTS系列](https://docs.deno.com/runtime/fundamentals/stability_and_releases/)である。

## 承認済み実装範囲

1. Deno 2.9.6をVM内のユーザー共通toolとして`~/.local/bin/deno`へ導入し、buildが要求するversionを
   2.9.6へ更新する。現行taskと運用文書はPATH上の`deno`を使う。
2. `createWorkerSession`の永続`new`/`continue`/`session`をphysical I/O modeに関係なくSQLiteへ統一し、
   TUI内の未使用な旧runtime/store compositionを削除する。`none`はmemory Sessionを維持し、productionの
   no-session executionだけSQLite journalを使う。
3. Deno filesystem版Session/evidence/diagnostic/artifact実装と、そこだけで必要なpath/codec/exportを削除する。
   SQLiteとin-memory test seamが共有するport、error、codecは残す。
4. model/provider switching、managed Definition、`/new`、`/recall`など現在も必要な動作のtestをSQLiteへ移す。
   旧schema roundtrip、旧sidecar persistence、重複した旧store testは削除する。
5. Worker foundation suiteから現行protocol/lifecycleの確認を通常suiteへ残し、旧永続化だけの確認と専用taskの
   二重構造を除く。
6. 常にfalseのlegacy noticeと、repository内参照がなく現在のpublic package APIでもないalias/helper/exportを
   削除する。旧schema validatorは現行schema validationから利用される範囲を残す。

## 対象外

- 既存SQLiteまたは旧JSON dataの削除、変換、migration
- product構想、architecture、roadmapの意味変更
- tag、commit、push、JSR publish、release
- 導入済み`~/.local/bin/henji`の置換

## Verification

- 変更箇所に対応するfocused testを先に実行する。
- Deno 2.9.6で`v0:check`、`v0:fmt`、`v0:lint`、`git diff --check`を確認する。
- 安定候補に対するauthoritative `v0:gate`を一回だけ実行する。
- compile graphに旧filesystem persistence moduleが含まれないこと、taskにsibling repository絶対pathがないこと、
  旧dataを削除する処理を追加していないことをread-onlyで確認する。

## 実装結果

- `~/.local/bin/deno`へDeno 2.9.6 ARM64を導入した。開発task、nested Deno launcher、JSR publish手順は
  sibling repositoryの絶対pathを使わず、`PATH`上の`deno`を解決する。build scriptは正確に2.9.6を要求し、READMEへ
  [公式installation guide](https://docs.deno.com/runtime/getting_started/installation/)とVM内配置を記録した。
- production TUIから未使用のdirect runtime compositionを削除し、`createWorkerSession`を唯一の既定compositionにした。
  永続`new`/`continue`/exact Sessionはprovider-free testを含めSQLiteを使い、production `--no-session`はSession rowを
  作らず同じSQLite journalへexecutionを保持する。permission-freeの`persistence: none` test seamはmemoryのままである。
- 旧`DenoSessionStore`、`FakeSessionStore`、`session_persistence.ts`を削除した。provider evidence、failure diagnostic、
  execution artifactの旧filesystem実装も削除し、SQLite adapterとfocused testが共有するport、typed error、in-memory seamだけを
  残した。既存のSQLite・JSON dataは読込み、変更、削除していない。
- 現行のmodel/provider switching、managed Definition、`/new`、`/recall`、cancellation settlement、provider evidenceの
  testをSQLiteへ移した。Worker foundation suiteは旧sidecar/JSON persistenceと重複確認13件を除いて26件を通常
  `v0:test`へ組み込み、専用taskを削除した。Increment 32に残っていた旧artifact directory副作用だけのtestも削除した。
- 到達不能なlegacy model notice、未参照のnavigation transaction、TUI direct runtime seam、旧schema V2〜V4 codec/export、
  compatibility aliasとhelperを削除した。CLI module graphに削除したfilesystem Session moduleは含まれず、旧store class名の
  repository内参照も残っていない。
- Deno 2.9.6でfocused test 140件が成功した。最初の`v0:gate`はIncrement 32の旧directory副作用test一件で途中停止し、
  原因となるtestを削除して同Incrementの6件をfocused再確認した。具体的原因を解消した後のauthoritative `v0:gate`は
  check、format、lint、全272 testを含め成功した。
- standalone compileと`--version` readbackも成功した。candidateは
  `/tmp/henji-i44-compile-J2kKth/henji`、build IDは
  `7fea0a774139136219e0088f6158e9a68874a9c744b4f53d65532ba719da4e78`で、Deno 2.9.6を表示する。
  installed `henji`は置換していない。
