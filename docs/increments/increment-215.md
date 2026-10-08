# Increment 215 — CoreからData保存実装への不要な実行時依存を除く

作成日：2026-10-08。

状態: 利用者承認済み計画に基づくlocal実装・focused検証・独立reviewを完了（2026-10-08）。
source・計画書・検証記録は後続の利用者指示によりcommitし、origin/mainへpush。build/配置は未実施。

利用者指定の`/tmp/henji-harness-data-contract-dependency-instructions.md`をコピーし、現行経路と
実装・確認方針を詳細化した。本書を今回の要件・計画・結果の正本とする。

## 依頼

Core側がDataのエラーを判別するために、Dataの保存実装とそのSQLite依存を読み込む経路を整理してください。今回の範囲でlocal実装と必要な検証を行い、結果を報告してください。

目的は、CoreとDataの責務に合う依存関係と、エラー処理の明確さを得ることです。不要な実装の読み込みを減らすことはフットプリント削減の候補ですが、RSSの削減量は未確認です。RSSが下がることを今回の合格条件にはしません。

## 対象と基準

- repository：<https://forge.harakara.site/littleisland/henji-harness>
- 調査した基準commit：`db4705c26cd6374ff998e5807cb66ca8a63f7531`（Increment 214）。
- 調査元checkoutはmacOSの参照clone。今回の実装先は利用者指定のLinux開発checkout
  `/home/agent/projects/henji-harness`。着手時HEADは調査基準と一致する。
- 着手時に対象repositoryの`AGENTS.md`と現在のsourceを確認してください。新しい変更がある場合は、以下の根拠が現在も成立するかを確認し、他の作業の変更を保全してください。
- 背景：[構造・処理・責務・フットプリントの分析](/tmp/henji-harness-structure-footprint-analysis-2026-10-08.md)。本書が今回の作業範囲を定義します。分析内の他の候補は、今回の実装対象に含めません。

## 確認済みの問題

`v0/agent/worker/worker_host_coordinator.ts`は、`DataRecallSelectionError`を`../data/session_data_owner.ts`から値としてimportしています。`prepareRecall`のcatch内で`instanceof`による判別に使用しています。

その結果、Core側に次の実行時依存があります。

```text
serve_cli.ts
  → core_service.ts
  → worker_host_session.ts
  → worker_host_coordinator.ts
  → session_data_owner.ts
  → sqlite_history_store.ts
```

`session_data_owner.ts`は保存の実装で、`SqliteHistoryStore`を値としてimportしています。エラーの判別だけでこの実装へ依存する必要があるかを整理してください。

既存の境界には、次の材料があります。

- `data/data_contract.ts`に`DataServiceError`があります。
- `data/data_service.ts`はData内部の`DataRecallSelectionError`を`DataServiceError`へ変換し、コードとHTTPステータスを設定しています。
- `data/client.ts`はWorker越しのエラー応答から`DataServiceError`を再構成しています。
- Coordinatorのcatchには、具体的なクラスに該当しなくても`error.code`を読む処理が既にあります。

`data_contract.ts`などにある`import type`／`export type`の参照は、上記の値importとは区別してください。保存実装への型参照があることだけを、実行時の読み込みと扱わないでください。

## 今回の変更範囲

Core／Data境界のエラー判別・契約と、それに直接関係するimport・利用箇所・検証を対象にします。具体的な実装方法は現在の呼出経路を確認して決めてください。

既存の`DataServiceError`やエラーコードの契約を使ってCoreの実装依存を除く方法が候補です。呼出元がクラスを共有する必要がある場合は、軽い契約側へ置く方法も比較してください。必要な変更が最も小さく、直接呼出とWorker越しの呼出で既存の意味を保てる方法を選んでください。

Data内部だけで使うエラークラスやSQLiteへの依存は、その責務に必要ならData内部に残して構いません。汎用エラー基盤、新しいWorker、全面的な型移動は今回の目的から要求しません。

次は対象外です。

- CLIのコマンド別読み込み、provider adapterの選択的読み込み。
- `runTurn`の分解、終了済みownerの保持、thinkingの更新方式、Worker配置の変更。
- Increment 214で整理済みのモデル入力コピー・JSON計測の再変更。
- recall仕様、保存形式、公開API、入力制約の変更。

## 保つ動作

- recallの成功時の選択結果、descriptor更新、pending recallの一回消費。
- `unavailable`、`busy`、`not_found`、`ambiguous`、`failed`の意味と、Coordinatorからの`WorkerRecallSelectionError`への変換。
- Data側の既存HTTP分類：`not_found`は404、`busy`／`ambiguous`は409、`unavailable`は503、その他の失敗は500。
- Worker越しに受け取るエラーのコード・詳細と、既存利用箇所が必要とするエラーの識別。

クラスを移動・統合する場合は直接利用箇所も確認してください。`tests/v0/agent_worker_foundation_test.ts`には、Data
ownerを直接呼び出して`DataRecallSelectionError`を判別する既存テストがあります。

## 完了条件と検証

1. Coreのエラー判別から`session_data_owner.ts`／`sqlite_history_store.ts`への不要な実行時依存が除かれていること。変更前後のimport経路を示してください。
2. 上記のrecall動作とエラー分類が維持されていること。変更に対応する既存テストを選び、実際に通った範囲を示してください。
3. 対象repositoryの規約に従った必要な型チェック・format・lint・差分チェックが成功していること。

関連する既存テストは`increment_38_recall_context_test.ts`、`agent_worker_foundation_test.ts`、`increment_143_http_session_test.ts`です。変更した呼出経路に対応するものを選び、Data→Core→HTTPの変換を触った場合はその経路も確認してください。検証のための追加ケースは、既存テストで確認できない具体的な変更がある場合に絞ってください。実providerへの有料呼出はこの指示の検証に必要ありません。

依存確認では、値importと型だけの参照を区別してください。`deno info`等の出力に型の依存が含まれる場合、一覧に残ることだけで未解消と判断しないでください。また、CLIのhistory／session系コマンドには別の正当なSQLite読み込み経路があります。CLI全体からSQLiteを除くことは今回の完了条件ではありません。

RSSの測定は必須ではありません。測定した場合は条件と結果を別に報告し、依存が減った事実だけからRSS削減を推定しないでください。

## 実行範囲と報告

この指示で行う作業はlocal変更と非破壊的な検証です。commit・push・公開・配置や実provider呼出については、利用者からの別の明示指示に従ってください。

Coreが制御を担い、Dataが保存と会話の正本を担う分担を保ってください。この局所的な依存整理で製品要件や責務分担の変更が必要と判明した場合は、その根拠と必要な追加範囲を報告してください。

完了報告には、選んだ方法、除いた実行時依存、変更ファイル、保ったエラー動作、検証結果、残る関連依存とその理由を含めてください。

## 現行product経路と実装計画

利用者のrecall操作はTUI/APIからCoreのrecall commandへ入り、WorkerHostSession →
ExecutionCoordinator.prepareRecall → DataClient → Data WorkerのDataService →
DataSessionOwnerへ進む。選択元executionはDataの保存履歴から解決し、pending
recallとdescriptorもDataが所有する。
成功後、Coordinatorは最新descriptorを採用する。次turnへの投影と一回消費は既存Worker/Data経路が担当する。

エラーはDataServiceが内部のDataRecallSelectionErrorをstatus/code/detail付きDataServiceErrorへ変換し、
DataClientがWorker応答から再構成する。CoordinatorはcodeをWorkerRecallSelectionErrorへ写し、Coreは
not_foundをcommand結果のnotFoundへ写す。Data ownerを直接使う既存callerは内部クラスを識別する。

### 選ぶ変更

Coordinatorの値importと`instanceof DataRecallSelectionError`分岐だけを除き、既存のstring型error.code取得を使う。
内部クラスもDataServiceErrorもcodeを持ち、既存の汎用分岐で同じ結果になるため、共有クラスの移動や新規moduleは不要。
DataServiceErrorによる追加のinstanceof限定も、codeの意味を保つために必要ないので採用しない。

- production変更は`v0/agent/worker/worker_host_coordinator.ts`のみ。
- Data内部のエラー、DataServiceのstatus/detail変換、DataClientの再構成、CoreのHTTP/API分類は変更しない。
- 成功時descriptor更新、busy/unavailable判定、未分類エラーのfailedへの既存変換も保つ。
- class同一性を境界の条件にせず、現在使っているcode契約を維持する。

### 確認方針

- 変更前後の`serve_cli.ts`を入口とするDeno module graphを採取し、runtimeのcode依存だけを辿る。
  type依存・dynamic importは区別し、Coreの静的値importからowner/SQLiteへ至る経路の変化を記録する。
  graphの全module数やRSSの削減を成功条件にしない。
- 既存`increment_38_recall_context_test.ts`で実Worker越しの選択成功・ambiguous分類・pending
  recall一回消費等を確認する。
- `agent_worker_foundation_test.ts`のData settlement rollback/recall
  testをfocused実行し、直接owner利用で
  DataRecallSelectionError/not_foundが維持されることを確認する。Data内部には変更を加えない。
- 既存`increment_143_http_session_test.ts`へ、存在しないexecutionのrecallがnotFoundとして返る照合だけを追加する。
  この具体的な失敗のData → Coordinator → Core →
  HTTP経路は、同testの従来の成功／一回消費確認では確認できない。 同testを実行し、成功時pending
  recallと次turn/保存Sessionの実経路も併せて確認する。
- 関連source/testのtype check、変更fileのformat/lint、git diff --checkを行う。full
  gateは要求しない。実装・検証段階では外部provider
  call、RSS比較、build/配置、commit/pushを対象外とする。

未確認事項は、同じ保存実装へ到達する別の静的値import経路の有無。graphの差分で確認する。
存在する場合は経路と担当用途を報告し、今回のエラー依存と無関係な変更へ拡張しない。
構想・architecture・roadmapの正本変更は今回の局所変更に含めない。

## 結果

### 実装と保った契約

production変更は`v0/agent/worker/worker_host_coordinator.ts`だけ。
DataRecallSelectionErrorの値importと専用のinstanceof分岐を削除し、もともと存在するstring型codeの取得を使う。
内部エラーもWorker越しのDataServiceErrorもcodeを持つため、既存のWorkerRecallSelectionErrorへの変換を保つ。
成功時descriptor採用、busy/unavailable判定、既知codeの分類、その他をfailedとする処理は変更していない。

DataRecallSelectionErrorはData owner内部に残し、直接利用する既存testの識別もそのまま維持した。
DataServiceの404/409/503/500分類とdetail生成、DataClientのstatus/code/message/detail再構成、Coreの
not_found → notFound変換は無変更。公開API・保存形式・pending
recallの所有と一回消費も変更していない。

### 実行時依存の比較

変更前後に`deno info --json --no-remote --frozen-lockfile --config deno.v0.json v0/agent/cli/serve_cli.ts`を実行した。
JSONの`code`依存を入口から辿り、`type`依存とdynamic importを除外して照合した。

```text
変更前のCore静的値import:
serve_cli → core_service → worker_host_session → worker_host_coordinator
  → session_data_owner → sqlite_history_store

変更後:
serve_cli → core_service → worker_host_session → worker_host_coordinator
  （DataRecallSelectionErrorの値importなし）
```

変更後の同入口からは、静的なcode依存でsession_data_owner/SQLiteのいずれにも到達しない。
CoordinatorのDataCommitDecisionやdata_contractのowner型参照はtype依存として残るが、実行時の値importではない。
このgraphで到達するmodule数は107から82になった。これは静的な依存graphの比較であり、RSSの測定ではない。
graphと集計はgit管理外の`.tools/increment-215/imports-before.json`、`imports-after.json`、`import-summary.json`へ保存した。

Data Worker側のDataService → DataSessionOwner/SqliteHistoryStoreは保存責務に必要なため維持する。
CLIの`history_cli.ts`・`session_cli.ts`も保存履歴操作のためSQLiteを値importしており、今回の対象外。
CLI全体・Data WorkerからSQLiteを除いたという意味ではない。

### 確認したproduct動作

- `increment_38_recall_context_test.ts`の7 testが成功。実Worker越しの最新／明示指定の選択、
  ambiguousのWorkerRecallSelectionError分類、descriptorへ反映されたpending recallの一回消費、clear、
  checkpoint併用・出所・保存artifactのreadbackを確認した。
- `agent_worker_foundation_test.ts`のData settlement rollback/recall testをfilterして1 testが成功。
  Data ownerの直接利用と再openでDataRecallSelectionError/not_foundの識別が維持された。
- `increment_143_http_session_test.ts`へ、存在しないexecutionを指定したrecallのnotFound拒否を追加し、1
  testが成功。 実localhost HTTP → Core → Coordinator → Data Workerの失敗分類を確認した。
  同じ実経路で、既存のrecall成功・pending
  recall表示・次turnへの投影・一回消費・保存Session再開も成功した。
- 合計9 focused testが成功。busy/unavailable/failedの全分類を新しいtest matrixにしたわけではなく、
  既存の分類処理とDataのHTTP status/detail変換が無変更であることをsource/diffで確認した。
- 関連sourceと上記3 test fileのtype check、変更source/testのlint、変更fileのformat、git diff
  --checkが成功した。 full gateは実行していない。

### 独立review

2026-10-08の利用者指示により、read-only reviewerがCoordinatorとHTTP session testの差分、
直接caller・contract、計画と依存graphを確認した。上限30分の通常correctness reviewとして実施した。

- 必須finding・任意修正コメントともなし。既存code判別と削除したinstanceof分岐の分類結果は同じで、
  成功時descriptor更新、DataServiceのstatus/detail、DataClientの再構成、CoreのnotFound変換は維持されるとの評価。
- reviewerが保存graphを静的code依存だけで独立に再集計し、107→82、Core入口からowner/SQLiteへの到達なし、
  残るowner参照がtype依存であることを確認した。
- 変更した143 HTTP session
  testを再実行し、不存在executionの拒否、recall成功、一回消費、保存Session再開が成功した。 git diff
  --checkも成功した。追加修正はない。
- 全エラー分類の実行確認、RSS、実provider、full gate、build/配置はreview対象外とした。

### 残る未確認事項と権限境界

RSS・速度は測定しておらず、依存graphの変化から改善量を推定しない。実provider call、TUI操作、
compiled
binaryのbuild/配置は実施していない。commit/pushは後続の利用者明示指示に基づき実施した。今回の機能確認は実Data
Workerと隔離localhost HTTPを
用いた既存product経路で行い、実config・credential・保存Session・既存未追跡fileは変更していない。
構想・architecture・roadmapの正本変更はない。

変更fileは本計画書、Coordinator、既存HTTP session test、現在地を更新する`.handoff/handoff.md`。
