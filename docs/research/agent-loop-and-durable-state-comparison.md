# Agent loopとdurable stateの参照実装比較

ステータス: 未採用候補の背景調査。architecture、roadmap、個別Increment要件、実装認可ではない

調査日: 2026-09-11〜2026-09-12

## 目的

長期Sessionのcanonical transcriptをどのように保持するか、turn中のeventをどこまでdurableにするか、
agent loop、approval、steering、compaction、並列tool callをどの境界で扱うかを参照実装と比較する。
ここでの参照実装の挙動はHenjiの仕様ではない。未採用のproduct候補は
[`../experience/normal-use-inbox.md`](../experience/normal-use-inbox.md)を入口とする。

## Henjiの確認済み境界

- Henjiはcommit済みtranscriptの防御copy上で一つのuser turnを実行し、`final`またはterminal tool成功時に
  turn全体をatomic commitする。cancel、provider failure、途中のtool failureはcanonical transcriptへ混ぜない。
- provider request/evidenceとWorker execution artifactはcanonical transcriptと分けて保存できる。Increment 38では
  uncommitted executionを人間が`/recall`で選んだ場合だけ、次turnへ一回投影する経路を追加した。
- 完全な`committedTranscript`は常時RAMに展開し、turn開始やmodel request構築時にclone・走査・
  serializationする。turn commitでは完全な`session.json`をatomic rewriteする。長期Sessionでの体感性能影響は
  まだ実測していない。
- 完全履歴の論理的な所有と、RAMやdisk上の物理的materializationは分離可能である。SQLiteや
  append-only event storeの採用は未決定である。

## Durable stateの比較

### Forge

[NorviaLabs/forge](https://github.com/NorviaLabs/forge/tree/d0bb0788e7c1fdfbe16291818c39293c1de755f7)
commit `d0bb0788e7c1fdfbe16291818c39293c1de755f7`はRust製、MIT licenseのbeta段階である。

- `forge-durable`はSessionごとのSQLite databaseにappend-onlyな`events`と`replay_checkpoints`を持つ。
- tool/modelの副作用前にintentを保存するrecord-before-side-effect、会話・tool intent/result・model response・
  HITL・task・subagent・compacted contextのreplay、不完了intentの検出、checkpoint以降のevent適用を実装する。
- `forge-core`のadapterはjournalをSession単位のpersistence境界へ閉じ込める。HenjiのHost-owned
  canonical transcript、provider向け派生projection、tool result identity、checkpointの分離と比較しやすい。

参照:

- [`forge-durable`](https://github.com/NorviaLabs/forge/blob/d0bb0788e7c1fdfbe16291818c39293c1de755f7/crates/forge-durable/src/lib.rs)
- [`forge-core` persistence adapter](https://github.com/NorviaLabs/forge/blob/d0bb0788e7c1fdfbe16291818c39293c1de755f7/crates/forge-core/src/persistence.rs)

### Crush、Goose、DvalinCode

- Go製の[Charmbracelet Crush](https://github.com/charmbracelet/crush/tree/bb33cee2d32780cb5afa31fc3aa815302b9f7443)
  commit `bb33cee2d32780cb5afa31fc3aa815302b9f7443`はSQLiteにSession、message、file snapshot、token・cost等を保存し、
  WAL、process lock、同時接続対策を持つ。mutable relational storeでありappend-only完全履歴正本ではない。
  licenseは確認時点でFSL-1.1-MITであり、直ちにMITと扱わない。
- Rust製の[Goose](https://github.com/aaif-goose/goose/tree/618d41ee2e01032e6c2874b1da467259ac3229af)
  commit `618d41ee2e01032e6c2874b1da467259ac3229af`はApache-2.0で、SQLiteにSession、message、usage ledger、thread、
  provider/model構成等を保存する。schema migrationと他agentからのSession importも持つが、conversation全置換や
  message削除を行うmutable storeである。
- awesome list上のDvalinCodeもsourceで確認したが、Session正本はSQLiteではなくJSONと
  `.journal.jsonl`だった。紹介文だけからstorage実装を推定しない。

### Prime Agent

Prime Agent commit `1eee2938b4eeb7a4d72e17035adda669a89b63de`のSession正本はSQLiteではなくJSONLである。
entryは`id` / `parentId`のtreeを形成し、message、tool result、model変更、compaction、branch summary、
extension state、child usage、Session lifecycle等を追記する。compactionは旧entryを削除せず、summaryと
`firstKeptEntryId`を持つentryを追加し、provider context構築時にactive branchを投影する。

IPython namespaceはSession artifact内の`kernel-state.dill`とmanifestへvariable単位でbest-effort snapshotする。
transcriptと作業用計算状態を別のpersistence lifecycleで扱う例である。Prime Agentの外部化・自己改訂境界は
[`externalization-reference-comparison.md`](externalization-reference-comparison.md)を参照する。

## Agent loopの比較

### 共通骨格と差分

`user input -> model request -> final`、または`tool calls -> tool results -> 次のmodel request`という最小骨格は
各harnessに共通する。差が出るのは、履歴の確定時点、toolの逐次・並列実行、steering/follow-upの取込み、
approvalでの停止・再開、compaction/retryの所有である。

- Codex公開App Server contractは永続conversationを`thread`、user処理を`turn`、assistant message、command、
  file change、tool call、compaction等を`item`として表す。`item/started`と`item/completed`間にapproval requestを
  挿入でき、`turn/steer`は新しいturnを作らず実行中turnへ入力を追加する。これは公開protocol上の
  状態機械であり、内部Rust loopの具体的制御関数まで確認したものではない。
- OpenCode V1は`SessionPrompt.runLoop`の`while (true)`でcompact済みmessageをstepごとに再読込し、
  assistant text/reasoning/tool partを実行途中からDBへ保存する。
- OpenCode `dev` commit `193de13a88d62a6409c6d385831180f1def527dc`の移行中V2は、SQLite上のdurable eventと
  user-input inboxを基礎に外側でqueued input、内側でtool continuationとsteerを扱う二重loopを持つ。
  local tool callを先にdurable eventへ投影してから実行し、provider stream終了後に全tool settlementを待つ。
  同一Sessionはcoordinatorが直列化し、別Sessionは並行できる。crash後の`pending` / `running` toolは
  黙って再実行せずinterruptedとして確定する。
- Pi、Zot、DeepSeek Harnessのloopはlocal snapshotで比較した。参照pathは本文末尾に固定する。

### Henjiへの示唆

- human gateの「どの操作を承認対象にするか」はinstruction、policy、workflow側へ置けるが、approval待ちの
  toolを安全に停止・再開・拒否する実行地点はruntime/loop境界に必要である。policyとenforcementを分けて接続する。
- Henjiのatomic turn commitと逐次実行を維持しつつ、未commit中のprovider request、tool
  requested/started/completed、cancel等だけをappend-only execution journalへ追記する折衷案がある。
  canonical transcriptは成功時に一括commitし、journalはcrash recoveryと診断証拠に使う。これは未採用である。
- tool call並列化の利点は独立したread/search等の待ち時間短縮である。安定性は物理的完了順より
  `callId`とresultの対応、modelへ戻す順序、依存関係の保持による。same-file write、生成物を読む後続call、
  test、Git操作、複数approvalなどは順序で意味が変わる。
- 部分並列化を再検討する場合は、同一responseに複数callがあるだけで並列可能とみなさず、tool
  componentに`parallel-safe`または`exclusive`相当の実行特性を持たせ、独立したread-only callだけを対象にする。
- Codex UIの`Explored`はRead/Search等の表示分類、`Ran`はcommand executionの表示分類であり、label自体は
  並列・逐次やsubagent起動を示さない。実際の並列性はitemのstarted/completed区間で確認する。

## 比較参照

- Henji: `v0/agent/core/loop.ts`
- Pi: `_refs/pi/packages/agent/src/agent-loop.ts`
- Zot: `_refs/zot/packages/core/agent.go`
- DeepSeek Harness: `_refs/deepseek-harness/packages/core/agent-loop/README.md`
- Codex: [App Server](https://learn.chatgpt.com/docs/app-server)、
  [Open Source](https://learn.chatgpt.com/docs/open-source)、
  [Subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents)
- OpenCode V1: [prompt.ts](https://github.com/anomalyco/opencode/blob/193de13a88d62a6409c6d385831180f1def527dc/packages/opencode/src/session/prompt.ts)、
  [processor.ts](https://github.com/anomalyco/opencode/blob/193de13a88d62a6409c6d385831180f1def527dc/packages/opencode/src/session/processor.ts)
- OpenCode V2: [Session API specification](https://github.com/anomalyco/opencode/blob/193de13a88d62a6409c6d385831180f1def527dc/specs/v2/session.md)、
  [runner](https://github.com/anomalyco/opencode/blob/193de13a88d62a6409c6d385831180f1def527dc/packages/core/src/session/runner/llm.ts)、
  [run coordinator](https://github.com/anomalyco/opencode/blob/193de13a88d62a6409c6d385831180f1def527dc/packages/core/src/session/run-coordinator.ts)

## 結論

Henjiのcanonical transcriptの完全性とatomic turn commitは、storage媒体やRAM materialization方式から分離できる。
長期Sessionの実測なしにSQLiteやevent journalを必須としない。採用する場合も、canonical transcript、
provider context projection、execution journal、toolの作業用stateを同じlifecycleへ混在させず、保存・復元保証を
個別に定義する必要がある。
