# Increment 107 — async run contractの確定（計画上のIncrement B0）

ステータス: **計画（contract確定、通常・批判的レビュー反映済み。実装はIncrement 108／109）**

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
- childは自身のexact `DefinitionRevisionRef`を持ち、これがchildの実行identityである。child executionの`agent`
  fieldはcanonical Sessionを持たないnoncanonical executionのlane labelとして扱い、Definition identityの代用に
  しない（`agent`は`'default'|'planner'`の既存unionのままとし、child identityは`definition` refと
  `parentExecutionId`でreadbackする）。
- childの`sessionCorrelation`はparent Sessionと区別できる値にする（`canonicalSessionId`を持たない）。
  child executionをparentの`/recall`候補に混入させない（recallはcanonical Sessionに属するnoncanonical
  executionだけを対象にする）。

### child Definition選択authority

- child専用の`subagent:<name>` slotを再導入しない。`subagent`はDefinition roleではなく、Execution間の親子関係で
  ある（Increment 106）。
- 親Definitionは利用可能なasync agent名を明示的に宣言する。Host configはnameからexact `DefinitionRevisionRef`へ
  のcatalogを持つ。activation identityは`agent:<name>`系とし、builtin plannerは`agent:planner`のroot-runnable
  Definitionとして扱う。
- Hostは親Worker generation開始前にname→exact refを解決し、data-only catalogを親へ渡す。spawn時にmodelが
  任意pathや未解決selectorを渡す方式にしない。

### state

runのlifecycle stateは次のいずれかとする。architectureのlifecycle／outcome／adoption軸
（[`henji-host-agent-worker.md`](../architecture/henji-host-agent-worker.md)）と混同しないよう、既存軸への
mappingを併記する。

| run state | 意味 | 既存軸へのmapping |
| --- | --- | --- |
| `starting` | spawnがadmitされ、child Workerのadmissionがdurableになる前。呼出側から観測しない内部状態 | lifecycle=active, outcome=unknown |
| `running` | child Workerが起動し、model/tool loopを実行中 | lifecycle=active, outcome=unknown |
| `completed` | child turnが正常終了 | lifecycle=settled, outcome=completed |
| `failed` | child turnがfailureで終了 | lifecycle=settled, outcome=failed |
| `cancelled` | 明示cancelまたはparent cancel／failure／settleでchildがcancelされた | lifecycle=settled, outcome=cancelled |
| `interrupted` | child WorkerがHost観測不能に終了した（generation loss等） | lifecycle=settled, outcome=interrupted |

- 合法な遷移は`starting → running → {completed, failed, cancelled, interrupted}`。`starting`から直接
  `cancelled`／`interrupted`へ遷移し得る（admission durable前のcancel、起動失敗）。terminalは
  `{completed, failed, cancelled, interrupted}`で、terminalからの遷移はない。
- child Workerは`starting`の間にHostが起動する。admission durable後、Worker起動に失敗した場合は`interrupted`
  とする（child実行を開始できなかった事実を記録し、親turnを自動failureにしない）。
- `starting`でHostがcrashした場合、次回reconcileで`interrupted`としてsettleする（reattachしない。V1対象外）。

### spawn／collectのplacementとcorrelation

- `spawn_subagent`／`subagent_status`／`collect_subagent`／`cancel_subagent`はWorker内でmaterializeする
  model-visible toolである。toolはdata-only Worker→Host requestを発行し、Hostがrun admission、exact Definition
  解決、child Worker supervision、status/cancel、durable evidence/resultの返却を行う。tool call ID、`runId`、
  `parentExecutionId`、`spawnCallId`でcorrelateする。
- spawn成功応答は、child admissionがdurableになった後だけ返す。応答は`runId`を返す。admission durable前に
  child Workerを起動してはならない。
- collect成功応答は、child terminal settlementがdurableになった後だけ返す。collectは対象childが`running`なら
  terminalまで待ってよい。collectは`runId`単位でone-shotとし、同じ`runId`への複数collectは同じterminal resultを
  返す（idempotent）。collectのtool call identityは親execution evidenceへ記録する。
- parent turnがcollect前に正常settleした場合、未collect childはcancelしてsettleする。完了済み・未collect childは
  evidenceとして残すが、parent contextへ入れない。
- child executionのsettlementはHostが駆動する。child Worker自身にsettleさせない。

### canonical proposal

- parent root runは従来どおりcanonical proposalを生成できる。
- detached child runはcanonical proposalを生成せず、terminal resultをnoncanonical execution evidenceとして
  settleする。child executionはcanonical Sessionへ採用しない。
- collectされたchild resultは、親turnのtool resultとしてのみcanonical Sessionへ入り得る。child execution自体の
  noncanonical性は、親turnのcanonical採用を妨げない。

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

### parent settle／replacement時のchild遷移

- parent cancel時、未完了childをcancelしてsettleする。
- parent failure時、未完了childをcancelしてsettleする。
- parentがcollectせず正常settleした場合も未完了childをcancelする。
- Session close、forced interruption、Worker replacementでもchild Workerを残さない。
- parent Worker replacementでchild registryが失われる場合、未完了childは`interrupted`としてsettleする。

### 禁止する実装

- child Workerを一時Sessionへ結び付けて、通常のroot commit proposalを常にrejectすることでchild resultの
  代用にしない。
- child resultを親conversationへ自動挿入しない。collectのtool resultとして返された時だけ親contextへ入る。
- childを`/recall`候補にしない。

## 対象外

- 実装（Increment 108／109）。
- mailbox、restart reattach、recursive spawn、swarm UI。
- cross-turn follow-up、durable addressable AgentInstance。

## 未確認事項（Increment 109で確定する）

1. child Worker RPC routing: `WorkerCorrelation`に`runId`／`parentExecutionId`をどう載せるか。
2. cancel伝播: parentからchild列挙とcancelを行う経路。
3. child Workerのsession identity: `correlation.session`、`initialTranscript`、`nextTurn`、`modelSelection`。
4. child budget/limits（Increment 106で共有child budgetを削除済み）。
5. child terminal evidenceのv7 history record種別（既存noncanonical境界に合わせる）。
6. child cleanup failureの記録先。
7. spawn/collect RPCのwire schema（Increment 108はwire変更を対象外とするためIncrement 109が所有）。
8. collectされたchild resultの親context内での表現（tool result本文の形式）。
