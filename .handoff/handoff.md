# Handoff

## Records

### Increment 30 — 現在Sessionの履歴検索とjump

- 状態: 実装とrepository gateは完了し、通常利用確認待ち。PageUpでanchorした履歴中に`/`で検索入力、Enterで最古一致、`n`で新しい一致、`N`で古い一致、PageUp / PageDownで周辺閲覧、Escで最新へ戻る。100 messagesより古いcanonical transcriptもHost側で検索し、draftは保持する。
- 次: production TTYで`docs/increments/increment-30.md`の「通常利用で確認する操作」を確認する。問題がなければ利用者の明示指示後にcommitする。
- 正本: `docs/increments/increment-30.md`
- 注意: authoritative `v0:gate`は一回成功済み。空の未追跡ファイル`henji`は由来不明のため変更・commit対象に含めない。

### F24前段の配布・外部化・履歴正本に関する参照調査

- 状態: standalone executable、外部moduleのinstall・activation・reload、SQLite harness比較、およびPrime AgentのRLM・Continual Harness・JSONL履歴・永続kernelの調査結果を通常利用メモへ保存済み。Pi・Zotの参照snapshot更新とDeepSeek Harnessの追加も完了した。SQLite履歴正本の第一参照候補はRust製Forgeで、Prime Agentは自己改定と状態分離の比較候補だが、いずれもsnapshot追加・採用は未決定。
- 次: 再開時にForgeまたはPrime Agentを`_refs`へ追加するか判断し、追加対象のcurrent commit・licenseを再確認して参照snapshot化する。
- 正本: `docs/experience/normal-use-inbox.md`の「配布・F24候補: standalone executable、各種Definitionの外部化、reload」と「Agent実行: canonical transcriptの物理的な保持方式」、`_refs/README.md`
- 注意: 空の未追跡ファイル`henji`は由来不明のため参照snapshot・メモのcommit対象から除外した。構想・architecture・roadmapの変更、SQLite採用、ForgeまたはPrime Agentのsnapshot追加はまだ承認されていない。
