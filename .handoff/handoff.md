# Handoff

## Records

### Henji Harness two-plugin spike

- 状態: Discovery revision 2で承認された`model-adapter`と`task-planner`の実装スパイクbriefを受領済み。まだ実装計画、provider/model選定、依存導入、実装、testは開始していない
- 次: plannerが`docs/spikes/model-adapter-task-planner.md`を読み、`docs/plans/model-adapter-task-planner.md`へ実装計画を一件だけ作成してHuman Gate 2で停止する
- 正本: `docs/spikes/model-adapter-task-planner.md`
- 注意: これはv1計画でも自己改訂の実証でもない。計画ではprocess isolation、versioned JSONL Envelope、`endpointId + operationId` broker、Deno権限・timeout・message/output size境界を具体化する。provider/modelは利用者確認なしに決めない

## Checkpoints

## 2026-08-18 14:12 JST

- 実行エージェント: Codex
- 作業トピック: Henji Harness two-plugin spike
- 実施: ai-dev repositoryを初期化し、承認済みスパイクbriefとrepository規約を受領した
- 次: plannerが実装計画一件だけを作成し、Human Gate 2で停止する
- 注意: Gate 2前は実装、依存導入、test、provider/model選定を行わない
