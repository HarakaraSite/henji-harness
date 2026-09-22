# Increment 107 — async run contractの確定（計画上のIncrement B0）

ステータス: **計画（contract確定、実装はIncrement 108／109）**

計画日: 2026-09-22

関連: Increment 106（同期subagent削除）、Increment 108（Host責務分割）、Increment 109（非同期subagent実装）、
roadmap F02／F06／F12、[`henji-host-agent-worker.md`](../architecture/henji-host-agent-worker.md)。

## 目的

Host責務分割（Increment 108）と非同期subagent実装（Increment 109）の前に、両者が共有する最小の**async run
contract**を確定する。これは新しいdata-only contractであり、実装はIncrement 108以降で行う。

## run contract

### identity

- `runId`はchild `executionId`と同一の値とする。runとExecutionを別identityにしない。
- 各child runは`parentExecutionId`を持つ（親root Executionのidentity）。
- 各child runは`spawnCallId`を持つ（親turnでspawnを発行したmodel tool call identity）。
- childは自身のexact `DefinitionRevisionRef`を持つ。

### state

runのlifecycle stateは次のいずれかとする。

- `starting`: spawnがadmitされ、child Workerのadmissionがdurableになる前。
- `running`: child Workerが起動し、model/tool loopを実行中。
- `completed`: child turnが正常終了した。
- `failed`: child turnがfailureで終了した。
- `cancelled`: 明示cancelまたはparent cancel／failure／settleでchildがcancelされた。
- `interrupted`: child WorkerがHost観測不能に終了した（generation loss等）。

### canonical proposal

- parent root runは従来どおりcanonical proposalを生成できる。
- detached child runはcanonical proposalを生成しない。childのterminal resultはnoncanonical execution evidence
  としてのみsettleする。child resultをcanonical Sessionへ採用しない。

### durability ordering

- spawn成功応答は、child admissionがdurableになった後だけ返す。
- collect成功応答は、child terminal settlementがdurableになった後だけ返す。
- child cleanup failureは、既に有効なparent canonical commitを失敗させない。cleanup failureは記録するが、
  parentのcanonical adoptionをrollbackしない。

### readback

child evidenceから次をreadbackできる。

- exact `DefinitionRevisionRef`
- `runId`
- `parentExecutionId`
- `spawnCallId`
- terminal outcome（stateと、failure時のstructured error）

### 禁止する実装

- child Workerを一時Sessionへ結び付けて、通常のroot commit proposalを常にrejectすることでchild resultの
  代用にしない。
- child resultを親conversationへ自動挿入しない。collectのtool resultとして返された時だけ親contextへ入る。

## 対象外

- 実装（Increment 108／109）。
- mailbox、restart reattach、recursive spawn、swarm UI。
- cross-turn follow-up、durable addressable AgentInstance。

## 未確認事項

- child runのdurable evidenceをv7 historyのどのrecord種別へ保存するかは、Increment 109の実装で既存の
  noncanonical execution evidence境界に合わせて決める。
- child Worker cleanupの失敗記録先はIncrement 109で決める。
