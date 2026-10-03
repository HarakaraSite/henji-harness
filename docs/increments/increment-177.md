# Increment 177 — 未使用実装・旧経路テストの撤去と通常test入口の整備

更新日: 2026-10-03

ステータス: local実装・検証、常用配置、commit/push完了。

## 要件・根拠・現行経路

利用者は、現行productから外れた旧実装をテストのために維持せず、未使用コード・未使用テストを
除去した後で`v0:test`を整備する方針を選んだ。追加指示でrepository内に参照のないexportも
削除する。前段のlocal参照調査を入力とする。

人間のCLI/TUI操作はCore → WorkerGeneration → 共通Agent loop/provider/tool → Agent Data →
SQLite保存・会話配信へ進む。公開JSR入口は`mod.ts` → `worker_agent_api.ts`であり、Worker、Data、
bundled Definition/toolはbuildの明示rootから読み込まれる。旧`AgentSession`とdirect runtimeは
この本番経路・公開APIから到達しない。必要な確認はこの現行経路または実際に使われるcomponentで行う。

既存のテスト137ファイルのうち46ファイルが通常`v0:test`に含まれず、172〜176の新規9ファイルも
個別実行に留まっている。未接続であることだけを理由にテストを削除しない。

## 対象範囲・計画

1. 旧`AgentSession`、direct runtime、旧resolved manifestと専用digest実装、旧provider別helper、
   未使用export・file・fixtureを撤去する。必要な定数や検証taskは現行の所有moduleへ接続する。
   公開Definition composition APIと実際に使う検証入口を維持する。
2. provider/stream/toolの継続確認は本番と共通のloopへ移す。Session保存・request帰属・checkpointは
   既存のWorker/Data経路の確認と対応させる。旧APIの明示compaction・summarizer設定やdirect runtime
   parityだけを保証するcaseは除く。現行機能を保証する混在caseは残す。
3. `v0:test`を現行`tests/v0`全体のlocal確認入口にし、旧case名の手列挙による未接続を解消する。
   standaloneの研究probe/spikeテストと実provider確認は通常suiteへ混ぜない。
4. 変更箇所のfocused test、型確認、format/lint、diff checkを行い、安定候補で整備後の`v0:test`を
   一度実行する。失敗時はそのcaseの原因を調べ、修正・focused確認後に必要な残り範囲を実行する。 full
   `v0:gate`は計画しない。

対象はlocal source・test・task/package include・本incrementとhandoffの記録。
構想・architecture・roadmap、実data、常用binary、外部provider、commit/push、公開は変更しない。
動的fixtureと公開APIは単純な文字列参照数だけで削除しない。機能変更や計画外product
bugは利用者へ戻す。

## 確認するproduct動作

- provider本文・thinking・tool引数と結果の継続、診断、credential非露出。
- 既存会話を後続requestへ渡すこと、request帰属、失敗の非採用、checkpointの投影。
- 現行Definitionのtool/role/instruction合成とmodel選択。
- 172〜176を含む現行Core/Worker/Data/API/TUIの既存local regression確認が通常入口から実行できること。

## 結果

- 旧`AgentSession`、direct runtime、旧resolved manifest/digest、旧provider helper、test専用barrel、
  会話barrel・projection・navigationの未使用9 source fileと、未使用busy Worker fixtureを削除した。
  呼出しが消えたcontext/summary検証、fake store、unused constant/helperも撤去した。
- 旧compactionテストを削除し、保存checkpointの次requestへの投影と大きいtool結果の継続を
  現行共通loopの`semantic_context_projection_test.ts`へ移した。provider/stream/tool継続は共通loop、
  max-step失敗は実Worker経路へ移した。旧Sessionだけの保存確認、旧summarizer設定、direct runtime
  parity、不要になった空のrole default確認は削除し、現行Worker/Dataの既存確認を維持した。
- import/re-export、import type、namespace参照を調べ、file内だけで使う450宣言は処理・型を残して
  `export`を外した。使われない宣言は本体を削除した。公開`mod.ts`のDefinition composition API、
  buildが生成する入口から呼ぶ`installBuildManifest`とCLI
  `main`、動的fixtureの`workerProbe`は維持した。
- `v0:test`は`tests/v0`の135 test fileをdirectory指定で自動検出する。172〜176も通常入口へ接続した。
  個別focused taskを残し、rootの独立probe/spike 2 fileとlive provider taskは混ぜない。 local
  HTTPはloopback、既存testに必要なprocess/envを使い、symlink確認に必要なunscoped
  read/writeを付けた。 型確認は`v0:check`、suite実行は`--no-check`に分けた。
- 最後の参照graphで孤立sourceは動的に読む3 fixtureだけだった。参照のないhelperは0。 静的named
  importがないexportの残りは上記の生成入口2個と動的fixture 1個で、利用箇所を確認した。

## 検証結果

- 実装中のfocused確認: 移行した7 test fileで77件、所有module変更のfocused確認で32件が成功。
- 整備後の`v0:test`を一度実行: 642件中634成功、8失敗。全fileの実行は完了した。 local
  serverのlisten先、testのstateRoot隔離、symlink作成permission、176で追加された診断details、
  172の異なる二つのweb_search guideline、directory指定になったtask期待値が原因だった。
  product実装を変えずにtest/taskを合わせ、失敗を含む6 fileのfocused再確認は54件全成功。
- 最終`v0:check`、独立probe/spike 2 fileの型確認、生成build入口と同じmanifest/CLI
  importの型確認が成功。 export modifierの整理後も参照先が解決することを確認した。
- source/script/test全体のlint、format check、`git diff --check`が成功。
- 上記local検証時点では、full `v0:gate`、実provider
  call、常用配置、commit/push、公開は実施していない。

## JSR収録漏れの修正・未確認事項

公開API graphが読む78 local moduleのうち、`jsr.json`のpublish includeから次の5 fileが漏れていた。
利用者の追加指示で5 fileをincludeへ追加した。公開時まで先送りせず、現行APIの必要な依存先を
収録設定に反映した。追加後のgraphとの照合でlocal moduleの収録漏れ0を確認した。公開は実施していない。

- `v0/agent/core/failure_details.ts`
- `v0/agent/provider/chatgpt_auth.ts`
- `v0/agent/provider/credential_file.ts`
- `v0/agent/provider/credential_resolver.ts`
- `v0/api/chatgpt_contract.ts`

実providerとのproduction利用は今回確認していない。任意の外部Definitionによる非公開moduleの直接利用は
互換要件にしない。既存data/fileの削除は本作業に含まない。

## 常用配置（2026-10-03）

利用者の「その後配置して」により、177の整理とJSR include修正を含むlocal sourceを178と一緒に
build・常用配置した。配置先binaryのproduction TUI、catalog選択、localhost providerでの
Worker実行・完了と保存を確認した。Build情報と配置資料、確認した操作は
[Increment 178](increment-178.md#常用配置2026-10-03)を参照する。
起動中の常用Coreと実configは変更せず、新しく起動するCoreから配置版を使う。
利用者の「コミットプッシュはしよう」により、177・178のcommit/pushは追加承認された。公開は行っていない。

## Commit/push（2026-10-03）

利用者の「コミットプッシュはしよう」により、177・178の実装・検証・配置記録と関連メモを commit
`e76056bab3fb30ccb9661290cb7f84625d1c2f3c`へまとめ、`origin/main`へpushした。
完了状態の記録も同じ送信先へcommit/pushする。
配置済みbinaryは常用配置節に記載したbuildのままであり、今回のcommit/pushでは再buildしていない。
