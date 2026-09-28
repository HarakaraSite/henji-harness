# A25・Increment149〜153 — 完了・commit・push・常用配置

更新日: 2026-09-29。ステータス: 利用者完了承認済み、commit・push・常用配置は作業中。

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

commit・build・配置・配置後確認が完了した時点で追記する。
