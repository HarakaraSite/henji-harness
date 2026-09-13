# 非同期・並行subagentの参照実装比較

調査日: 2026-09-13

## 位置付け

通常利用メモA7の採否判断に使う参照実装調査である。Henjiへの採用、architecture・roadmap変更、
実装認可を意味しない。現行Henjiのdelegated plannerは親Execution内の同期的なtool callである。

## 比較

| 参照実装 | 親の継続・複数child・合流 | cancel・失敗 | concurrency・budget | durable identity・帰属 | Henjiとの対応 |
| --- | --- | --- | --- | --- | --- |
| [Codex Subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents) | 複数の独立agent threadを生成し、main agentが結果を集約する。spawn、follow-up、wait、interrupt、closeとthread観測がある | 実行中agentの停止とthread closeを区別する | Sessionあたりの同時thread数を設定できる。child別token hard budgetは確認できない | thread単位の表示・summaryはあるが、再起動をまたぐdurable journal契約は確認できない | 人間向け操作体験が近い |
| [OpenAI Agents API — multi-agent](https://developers.openai.com/api/docs/guides/agents-api/multi-agent)、[Sessions](https://developers.openai.com/api/docs/guides/agents-api/sessions) | coordinatorがchildをcreateし、message、wait、interruptを明示的に行う。childは独立contextで並行動作し、親が結果を統合する | 現在turnのinterruptとchild handleのcloseを分ける。cancel後も既存Session/itemを保持する | `max_concurrent_subagents`があり、親を上限から除外する。usageは取得できるがchild別hard token budgetは確認できない | Session、subagent、turn、itemにidentityがあり、parent/requester/childを相関できる。切断後は保存済みitemから回復するがstream event自体は再送しない | agent固有のfork/join、操作、履歴、帰属を一つの契約に持ち、総合的に最も近い |
| [LangGraph Functional API](https://docs.langchain.com/oss/python/langgraph/functional-api)、[Persistence](https://docs.langchain.com/oss/python/langgraph/persistence) | taskがfutureを直ちに返し、複数起動後も親処理を続け、`result`/`await`で明示的に合流できる | 公開契約で確認できるcancelは主にhosted run単位。再開時は成功済みtask resultをcheckpointから再利用する | `max_concurrency`、timeout、retry policyがあり、token budgetはapplication側である | checkpoint、pending write、task ID/name/errorを保持する。entrypoint再実行型なので未完了の外部作用には別の意味付けが必要 | fork/joinとcheckpoint reuseのprimitiveとして有用だが、agent conversationと採用境界は自前になる |
| [Temporal Child Workflows](https://docs.temporal.io/develop/go/workflows/child-workflows)、[Cancellation](https://docs.temporal.io/develop/go/workflows/cancellation) | childごとのfutureを返し、複数開始後に任意の時点で待てる。親完了前にchild startedのdurable記録を待つ契約がある | child単位cancelと、親終了時のterminate/request-cancel/abandonを明示的に選ぶ | Worker slot、Task Queue、service limit、timeout/retryを持つ。token概念はない | Workflow ID/Run IDと親history内のstarted/completed eventをdurableに保持する | durable lifecycle、親終了時方針、cancelの強い参照だがlocal agent harnessへ直接導入するには重い |

[OpenAI Agents SDKのorchestration](https://developers.openai.com/api/docs/guides/agents/orchestration)も、
manager-as-tools等のin-process委譲・合成patternとして確認した。ただしdurable fork/joinの正本としては
上記Agents APIより弱いため補助参照とする。

## 将来採用時に決める最小論点

1. childを親と別Executionにし、`parent_execution_id`、child task ID、attempt IDを保持するか。
2. `wait all`、`wait any`、指定child待機、完了通知と結果本文のmodel context投入をどう分けるか。
3. 親の正常完了、cancel、failure時にchildをterminate、cancel要求、継続のどれにするか。
4. 親を除く同時child数、共有またはchild別のmodel request/token/time budgetをどう所有するか。
5. create/message/wait/interrupt/resultとchildのmodel/tool evidenceをどのExecutionへ帰属させ、最終Turnへ
   何をcanonical採用するか。
6. shared workspaceで並行writeを許すか。外部作用開始の可能性があるchildを証拠なしに自動再実行しない
   境界をどう定めるか。

## 比較から得た現在の判断材料

Henjiに最も近い単一参照はOpenAI Agents APIのcoordinator・独立subagent・明示的な
create/wait/interrupt/close・child別history/attributionである。人間向け操作はCodex Subagents、durableな
child lifecycleとparent-close semanticsはTemporal、futureとcheckpoint reuseはLangGraphを補助参照にできる。

現行の同期planner handlerを単に非同期Promiseへ置き換えるだけでは、child Executionの帰属、join、再起動、
canonical採用は定義できない。A7を採用する場合は、通常利用で得た具体的な並行作業を入口に上記論点を
architectureとroadmapへ戻して決める必要がある。
