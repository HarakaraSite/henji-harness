# A25・Increment149〜153 — 完了・commit・push・常用配置

更新日: 2026-09-29。ステータス: 実装・検証・完了承認・commit・push・常用配置・配置後確認完了。

## 対象と承認

利用者が複数Core対応を完了とし、関連文書更新・commit・push・配置を明示指示した。
対象は五sliceの実装・test、計画・結果・通常利用文書とhandoff。
構想・architecture・roadmapへの意味上の反映案は個別計画に保持し、今回それらの正本は変更しない。
JSR公開、実config・credentialの変更、旧DB/metadata削除・migrationは含めない。

## 完了を支える確認

各slice後のreviewer code/test reviewと指摘修正を完了した。追加の全体俯瞰reviewはBlocking0/P10。
安定候補のfull gateはtypecheck/fmt/lint/tests478件を通過した。
compiled通常TUIの二Core並行完了・保存、busy
detach/ID再接続、client別draft、Session切替と保存resume、 親子toolのcancel/個別Core
stopの独立性を実providerで確認した。
gpt-6-astra提案の追加E2Eで、保存tool履歴を新Coreの実providerへ再投影して継続し、
同workspaceのheadless stdin/NDJSON callerとtool同時稼働・両完了を確認した。 実装後のprovider実績は32
physical requests。詳細は[153](increment-153.md)と各sliceを参照する。

## 配置手順と確認

レビュー済みsource/test・taskを維持して文書を更新し、実装commitをorigin/mainへpushする。
cleanな実装commitからDeno2.9.7の公式build scriptでcompiled binaryを作り、 受入済みcandidateとruntime
digestを照合してから旧binaryを保持し、常用先へ原子的に配置する。
配置binaryそのものを隔離XDG/workspace/tmuxで通常二起動・別Core/Session、ID list/status/attach、
detach継続、選択idle CoreのSession切替と個別stopを確認する。provider requestは追加せず、full
gateを再実行しない。 配置結果を文書commitへ記録してpushし、local mainとorigin/mainの一致を確認する。

配置前の `/home/agent` には旧binaryのCoreがidleで稼働している（PID32600、epoch8ed7e3d8…、URL
http://127.0.0.1:41115）。 repository workspaceには旧Coreはない。既存CoreとSessionのwriter
ownershipは保持し、停止・自動移行しない。 旧Coreへは既存URLで明示再接続でき、新しいID
discoveryは新Coreを対象にする。

## 実施結果

実装・test・関連文書の42fileをcommit `8ccf835b84b5270498bf150a35d1cfe62ad17659`
へまとめ、`origin/main`へpushした。
レビュー済み実装15file・test13file・task定義1fileは凍結artifactと一致する。追加変更は文書だけ。
配置後記録はこの実装commitに続くdocs commitへまとめてpushする。

cleanな実装commitからDeno2.9.7の公式scriptでbuildし、`/home/agent/.local/bin/henji`へ原子的に配置した。

- version: `henji 0.7.0`、sourceは上記commit、dirtyなし。
- build ID: `fea3c1e6ff42f3e80cd8844b60581c0261efa09e06fc0272f74cdb6bc8cd7b7e`。
- runtime SHA-256:
  `c92e6b3485b4f6774f5d7a2e6d49efaf690ec4e91ad54ea1fe689715d40a5d66`。実provider受入済みcandidateと一致した。
- binary SHA-256:
  `b09e0361edbaa28a3dc4fd8a03ece5fb965970f51b609d9c97d8c0df9b159fac`。clean候補と常用binaryのhash・version・source・buildが一致した。
- 旧binary: `/tmp/codex-agent-context/a25-deployment-20260929/henji.previous`へ保持。SHA-256
  `cbdc92d8df12e67371d3b7e12163bd932067a2b6c210f00b994dde45c9267681`。

配置binaryそのものを隔離XDG/workspace/tmuxで確認した。通常二起動の別PID/epoch/Session、
通常100×35・初回compact60×14のCore/Session表示、Core一覧とprefix status、対象省略stopの非停止、 TUI
detach後のCore保持とID再接続、他client draft保持、選択idle Coreだけの新Session、 個別Core
stop後の他Core存続、最後のCore一覧が空になることを確認した。 execution admissionと追加provider
requestはゼロ。full gateは再実行していない。検証Core/tmuxは停止済み。

`/home/agent`の旧Coreは停止せず、配置後も同じepoch/Sessionでidle・応答可能だった。
新規起動は新binaryを使い、旧Coreへの再接続には `henji --connect http://127.0.0.1:41115` を使う。
旧Coreは新しいepoch別ID discoveryの一覧対象へ移行していない。既存data/configは変更していない。

証拠:
`/tmp/codex-agent-context/a25-deployment-20260929/evidence`のbuild.log、deployment.json、version.txt、
`/tmp/codex-agent-context/a25-deployment-20260929/production`のsummary.json、Core一覧/状態、snapshot、各tmux画面。
構想・architecture・roadmapの正本意味変更とJSR公開は行っていない。
