# Increment 209 — HTTP APIの不要な処理を整理する

状態: local調査・改善・検証完了（2026-10-07）。常用build・配置は未実施。

## 目的と承認範囲

利用者の「以前行った無駄な処理がないかチェックして、あれば改善する。今回はapiに対して行いたい」
および対象指定「HenjiのHTTP API」を根拠に、HTTP APIのlocal変更と非破壊的検証を行う。
現行の公開操作、HTTP結果、snapshot→updateの順序、接続解除とCore停止の意味を維持する。
provider adapter、TUI表示、保存契約、構想・architecture・roadmapは対象外。

## 現行の利用経路と確認した不要な仕事

- HTTP操作: `HenjiApiClient` → API Workerの`server.ts` → `api_bootstrap.ts`のRPC →
  Coreのoperation → Data/Agent owner → RPC reply → HTTP response。
- SSE: CoreのSession購読がDataのsnapshotと更新を合成 → API Workerへencoded frame →
  HTTP SSE → clientのJSON/contract decode。snapshotと後続更新の整合はCoreが所有する。
- 停止: Coreが新規受付を閉じ購読へ終了を通知 → API WorkerがHTTP handlerをdrain →
  Coreが保存・清算 → listenerを閉じる。

| 確認した処理 | 不要と判断する根拠 | 改善 |
| --- | --- | --- |
| SSEの区切りを`search`と`match`で二度検索し、追加chunkごとに未完本文の先頭から検索 | 一回のmatchで位置と長さが得られる。既読の区切りなし本文を再検索する必要はない | 次のchunkでは末尾の未完区切りから検索を再開する |
| drain中に未完RPCを0msタイマーで繰り返し確認 | RPCはHTTP handler内で開始され、そのreplyをhandlerがawaitする。購読開始も`ready`をawaitする | 所有するactive handlerのPromiseをawaitする |
| 起動時のbuild manifestの取得とWorkerへの送信 | API Workerは起動messageのbuildを読まない。公開`coreRead`はCore自身のbuild情報を返す | 未使用fieldと送信元の取得を除去する |
| admissionClosedをWorker入口と共通handlerで二重判定・503 responseを二重実装 | 共通handlerが全requestの受付終了を判定する | 共通handlerに統一する |

## 検証計画

- SSEのsnapshotとupdateを、分割UTF-8・分割LF/CRLF区切り・複数eventを含む受信で確認する。
  新しい仕様やprovider variantの追加ではなく、変更する受信経路の既存動作を確認する。
- 既存の実HTTP testで保存閲覧、実行、複数購読と再接続、停止時の未完購読・保存・listener清算を確認する。
  providerが必要なtestはlocalhost serviceだけを使い、実provider callは行わない。
- 変更sourceのtype check・format・lintと`git diff --check`を行う。full gateは要求しない。
- SSE検索は同一の長いframeとchunk分割を用いて変更前後の検索対象文字数を比較する。
  wall timeの改善率は保証しない。

## 未確認事項と承認境界

- 利用者の「コミットして」によりsource commitを承認した。実provider call、常用build・配置、push、
  公開/releaseは今回の範囲に含めない。
- TUI Surfaceは変更しない。HTTPの結果とlifetimeを実HTTP testで確認する。
- 結果は本書へ記録する。既存incrementの完了状態を再開しない。

## 実装と確認結果（2026-10-07）

- `v0/api/client.ts`: SSE separatorを一回のglobal matchで取得する。chunk追加時の検索開始位置を
  前回末尾の3文字へ進め、最大4文字のCRLF separatorがchunkを跨ぐ場合も保持する。
  コメント、複数data行、末尾の区切りなしevent、UTF-8の継続decodeは既存どおり扱う。
- `v0/agent/http/api_bootstrap.ts`: drainはactive handlerのPromiseをawaitし、pending RPCの
  timer pollingを除去した。新規受付終了の判定と503 responseは共通handlerへ統一した。
- `api_worker_client.ts`・`api_worker_protocol.ts`: 未使用の起動build fieldとその取得・送信、
  consumerのない`ApiOperationArgs`型を除去した。公開`coreRead().build`は維持した。

検証:

- focused HTTP testは8件pass、0件fail。新規209の2件（長いsnapshotの分割受信、未完read中の停止）と、
  既存140・141・145・170 S3を実行した。実API Worker、Core、Data Worker、localhost HTTP/SSEを経由し、
  保存閲覧、実行、切断・再接続、取消、複数購読、停止時の未完購読とBash子processの清算を確認した。
  外部の実provider callは0回。新規長文受信testの分割部分だけは取得済みの実snapshotをfetcherで再配信し、
  通常HTTP streamからのsnapshotとの一致も確認した。
- 変更sourceのtype check（新規testと既存HTTP testのcheckを含む）、format、lint、
  repository全体の`git diff --check`はpass。full gateは実行していない。
- 最初のfocused実行はtest起動に必要な`--allow-run=deno`等を付け忘れ、Bash起動待ちから進まなかった。
  当該test processを停止し、repositoryのtest taskにある実行権限・envを付けて再実行した。
  production codeやtestの期待動作をこの理由で変更していない。
- 変更前のHEAD（`8a0eff9e`）のclientと変更後のclientに、同じ262,399 byteのSSE frameを257 byteずつ与え、
  両方で同一のdecoded frameを確認した。separator検索に渡す文字範囲の合計は
  **134,609,665 → 265,462 code unit（約99.8%減）**。検索回数は1,025 → 1,024。
  本文への繰り返し検索を減らした結果であり、API全体の速度改善率ではない。
  単発のwall timeは99.3 → 48.0 msだったが、これを保証値にはしない。
  測定script・baseline client・結果は`.tools/increment-209/`（git管理外）に保存した。

自分で差分をreviewし、公開APIのfield・結果、snapshot→updateの順序、Coreの状態所有と保存・清算境界を
変えていないことを確認した。一般的なhardening、拒否条件、provider処理、TUI Surfaceの変更は追加していない。
常用binaryは未更新であり、人間の通常利用での確認は配置後に行う。local改善としての残作業はない。

## Source commit（2026-10-07）

利用者の「コミットして」により、HTTP APIのsource 4file・新規test・本書とhandoffの209部分を
今回のcommitへ保存する。既存の文書整理と未追跡dataは含めない。
個別increment索引は既存の未追跡文書に209の参照を追記した状態で保持し、今回のcommitには含めない。
