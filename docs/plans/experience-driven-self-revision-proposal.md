# Henji experience-driven self-revision 構想・進め方 改訂案

ステータス: レビュー用提案（draft）。承認済みの概念、実装計画、Human Gate、または実装認可ではない

確認日: 2026-09-05

基準点: commit `f8b2496434c3cde7b642021713e23f2f25d46d90`

この文書は、実際の利用経験を起点に構想と進め方を改訂する短い提案である。次の利用者判断と
実製品経路での確認に戻せる形に限定し、文書作成以外の作業を認可しない。

## 1. 先に結論

### ユーザーが確認したプロダクト定義

> 使う中で得た経験から、指示・スキル・実行方法まで改良していくagent harness。

この定義でいう改良の対象は、AGENTS.md や skill の文章だけではない。モデルへの入力、context
の選択と圧縮、loop、tool、delegation、model の使い方、そして必要なら実行可能な TypeScript Definition
や runtime の実装方法までを含む。目的は、Henji が多くの種類の agent を配布することや、
モデルの重みを訓練することではなく、通常の利用で見つかった困難や有用な成功を次の利用に生かすこと
である。

### この文書で提案する中心軸

Henji の自己改訂を、将来の遠い機能ではなく、次の経験ループとして説明する。

```text
通常の実利用
  → 観測された困難 / 成功
  → 原因の仮説
  → 改訂候補
  → 条件を揃えた結果比較
  → 次の通常利用での採用確認
  → 次の経験
```

「自己」は、全段階が無人であるという意味ではない。Henji の実運用経路と読み返し可能な証拠を
使って候補を提案・生成できることを中心に置き、観測、提案、編集、比較、採用の自動化水準は段階ごと
に決める。完全自律の適用はこの定義からは導かれず、新しい権限としても扱わない。

## 2. 何を改訂し、何を維持するか

今回の提案で改訂する軸は次の三つである。

| 改訂する軸                       | 提案する置き方                                                                                                  |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| 自己改訂の位置付け               | resident agent 等の遠い将来機能ではなく、実利用と経験比較を結ぶ製品の中心軸にする。ただし最初の実証は小さく行う |
| executable Definition の位置付け | 合成可能な Definition は主目的ではなく、改訂候補を実行可能な形で試すための手段とする                            |
| proof の順序                     | Stages 1–3 の accepted foundation は維持し、Stages 4–7 の順序変更はこの提案が採用された場合だけ別途判断する     |

改訂対象を AGENTS.md や skill だけに狭めず、指示、skill、context、loop、tool、delegation、model、
実行コードまで観測に応じて候補にする。事実を覚える、指示・skill を改訂する、実行可能な挙動を
改訂する、という三分類は入口であり、固定順序や恒久的 allowlist ではない。ここで維持するのは、
既存の作業権限、product-first 方針、Human Gate の要否、trusted-local の境界である。新しい承認制度、
一般 hardening、権限表はこの提案から導入しない。

## 3. 経験をどう扱うか

### 3.1 対象は実際の利用から得る

最初の改訂サイクルは、ユーザーが実際に経験した次のいずれかを一つ選ぶ。

- 「この作業で同じ説明や確認を何度も行った」など、明確な困難。
- 「同じ種類の作業が短く、少ない介入で完了した」など、再利用したい成功。
- 結果、操作、表示、context、tool、delegation のどこに人間の負担が残ったか。

未観測の provider variant や、想像上の compaction memory loss を最初の対象にしない。context の
compaction では、どの model input が選ばれたか、どの boundary で圧縮されたか、summary を含めて
何が次の request に入ったかが変わり得る。この変動は観測の文脈として記録するが、例示した 「memory
を失う」現象を Henji の defect と断定しない。

### 3.2 三つの分類は入口であり、順番ではない

| 分類                     | 例                                                                | 次に取り得る改訂                                         |
| ------------------------ | ----------------------------------------------------------------- | -------------------------------------------------------- |
| タスク上の事実を覚える   | workspace の命名、既知の制約、前回の判断                          | session/context に短い事実を残す                         |
| 指示・skill を改訂する   | 手順、説明、tool の使い分けを明確にする                           | AGENTS.md、skill、prompt/context projection を候補にする |
| 実行可能な挙動を改訂する | loop の順序、tool composition、delegation、model 選択、実行コード | Definition、runtime、context/compaction の実装候補にする |

観測された need が code に直接あるなら、skill を先に通過させる必要はない。逆に、単なる事実を runtime
の改訂へ拡大しない。分類は原因仮説を整理するためであり、変更を許す permanent allowlist ではない。

### 3.3 改訂候補の大きさ

一回のサイクルでは、観測された outcome を変える最小の artifact を候補にする。skill だけで解消
するなら code を変えず、context 選択、tool、loop、delegation、model、Definition の原因なら必要な
seam だけを候補にする。依存更新だけは自己改訂の本体としない。

## 4. 最小の経験記録と証拠

経験記録は、新しい schema、database、dashboard を要求しない。通常の diagnostic / evidence と
相互にリンクできる短い文書一つで十分である。最低限、次を読み返せるようにする。

1. 達成したい利用者 outcome。
2. 実際の observation または user feedback。
3. request、raw response、SSE、provider metadata、parser transition、tool event、runtime outcome、
   request count 等の evidence への参照。
4. 原因についての hypothesis と、まだ確定していない点。
5. 変更した artifact または提案した revision。entry ref だけでは依存の同一性を示せないため、変更した
   source / dependency version、または lineage 未解決であることも記録する。
6. baseline と候補の比較条件・結果。
7. 次の通常利用で adoption をどう観測したか、または何が未確認か。

原因特定に必要な raw diagnostic evidence は repository policy に従って保存・読み返し可能にする。
credential 値と Authorization は記録しないが、それ以外を仮想的な private-data 懸念だけで省略しない。
経験記録そのものは結論の代替ではなく、次の比較で同じ因果を追えるようにするための index である。

## 5. 成功の判定

成功は「一回コードが生成できた」「定義や test が増えた」ではない。元の task の目的を人間が
production 経路で完了でき、改訂の前後で少なくとも次の実用的な差を説明できることを判定材料にする。

- 同じ種類の作業での繰り返し作業が減ったか。
- 人間の介入回数、手戻り、待ち時間、作業時間、または provider 費用が減ったか。
- もともとの困難が解消したか、または成功した使い方を次の通常利用で再現できたか。
- 改訂の原因と結果を evidence で追え、未解決の副作用を隠していないか。

baseline と候補は、task、必要な入力、model、context/compaction 状態など比較に影響する
条件を明示する。ただし、統計的 benchmark suite や固定回数の provider run を完了条件にはしない。
一回の成功は一般的な改善を証明しない。反復利用での有用性が確認できるまでは、候補は「この条件で
確認された」と記録し、一般化を主張しない。

## 6. 現在の基盤と未確認事項

### 6.1 Accepted Host / Worker 方向

accepted な
[`Henji Host / Agent Worker アーキテクチャ概念`](../architecture/henji-host-agent-worker.md) を
self-revision の実行基盤として維持する。trusted-local の executable TypeScript `AgentDefinition` は
built-in / external とも同じ Deno Web Worker route で評価し、Worker は live
composition、turn/context semantics、compaction、semantic event、commit proposal を担う。Host は
terminal / Surface、lifecycle、durable session store、proposal validation / commit を担い、UI を
Worker に移さない。Host store 成功後だけ committed とし、effect の暗黙 rollback / replay はしない。

この分離は候補を実行し結果と evidence を保持するために有用だが、wire schema、恒久的 I/O placement、
migration、resident service をこの文書で確定しない。

### 6.2 現在の実装で確認できる seam

- [`worker_agent_api.ts`](../../v0/agent/worker_agent_api.ts) は `ExecutableAgentDefinition` と、
  model、registry、system instruction、maxSteps、manifest / resolved definition を含む Worker-local
  composition の seam を公開する。標準 factory は `eventSink` option を composition
  に組み込まず、event の配線は runtime / Host 側にある。
- [`worker_runtime.ts`](../../v0/agent/worker_runtime.ts) は一つの ephemeral Worker generation 内で
  固定された loop / context semantics、turn、cancellation、checkpoint、effect observation、commit
  proposal を扱う。
- [`worker_host.ts`](../../v0/agent/worker_host.ts) は Definition revision と session record
  を突き合わせ、 Host store の成功、ack、settlement、close/reopen を所有する。実装上、同じ session
  を別 revision へ 透過的に切り替えることは許していない。
- [`worker_execution_artifact.ts`](../../v0/agent/worker_execution_artifact.ts) は turn ごとの
  protocol trace、 revision、Manifest、provider evidence ID、store、ack、settlement を Host-owned
  artifact として結ぶ。
- [`context.ts`](../../v0/agent/context.ts) は model request の input projection と local compaction
  heuristic を示す。これは provider tokenizer の実測や、一般的な memory-loss defect の証拠ではない。

### 6.3 Foundation と real-provider gate の位置付け

Stages 1–3 の
[`provider-free implementation result`](./agent-worker-foundation-proof-stages-1-3-results.md)
は、built-in / external の common Worker route、Host durability、checkpoint boundary を確認した。
functional review と offline gate が green でも、real-provider Human Gate の 代替ではない。

その後の
[`real-provider gate blocker corrections result`](./agent-worker-real-provider-gate-corrections-results.md)
は、launcher config、production SSE、execution artifact / 読み返し口を provider-free
で補正した。ここで残る通常の実provider gate
は、[`corrections plan の task cost / 実行条件`](./agent-worker-real-provider-gate-corrections.md#7-後続human-gateのtask-cost)
に従う built-in 1 turn と external 1 turn（各 read 一回、planner なし、期待 request 4）であり、
self-revision trial に拡張しない。Corrections plan §7を元に新しい実行 package
を準備し、別途承認を得て から gate を行う。

## 7. 現在の限界を誤って約束しない

現在の Definition API が model、registry、system instruction、maxSteps を組み合わせられることは、
Henji が経験から自己改訂できることの証明ではない。loop と compaction は現状 Worker runtime に固定
され、Definition から独立した composable policy として公開されていない。特に次を明記しておく。

- loop と compaction の意味は現在 Worker runtime に固定されている。external example の `maxSteps: 4`
  は loader / common path の確認であり、意味のある self-improvement の証拠ではない。
- `DefinitionRevisionRef` は現在 entry の specifier、byte 数、entry hash を相関する。entry
  自体の不一致は 起動時に拒否するが、transitive import graph や依存の変更をすべて検出する identity
  ではない。
- 保存済み binding と entry ref が一致しなければ、同じ session を別 revision へ透過的に切り替えて
  resume できない。依存の全体を追跡して durable upgrade する仕組みもまだない。
- durable な `AgentInstance` と `AgentWorkerGeneration` の replacement / migration はまだない。
  restart だけで同一 session の durable upgrade が完成するとは約束しない。
- 新規 session の次の通常利用で変更の効果を確認できても、それは新規 session での採用確認にすぎず、
  durable Instance migration の証明ではない。

これらの限界を越えるには、generation replacement、migration、dependency lineage、または resident
Host の別計画と、実製品経路での確認が必要になる。self-revision の最初の cycle はこの約束をしない。

## 8. 提案する進め方

### Step 0 — 現在の候補と限定受入れを分離する

現在 review 済みの Host / Worker 候補を維持し、Corrections plan §7を元に real-provider 受入れ
package を 別途準備する。package と実行には新しい承認が必要であり、self-revision trial
へは拡張しない。この提案は gate の入力、cost、prompt、provider
条件を書き換えず、実行・承認もしない。

### Step 1 — 最初の実経験を一つ選ぶ

通常利用で観測された具体的な困難、または繰り返し使いたい成功を一つ選び、最小の経験記録を作る。
compaction の仮想 defect、未観測の provider failure、将来欲しい機能を最初の対象にしない。記録には、
人間が何を完了したかったか、どの操作で困ったか、どの evidence があるか、どの条件が変動したかを書く。

### Step 2 — 一つの改訂 cycle を計画する

baseline、原因仮説、候補 artifact、比較する次の通常利用を一つの plan に束ねる。候補が skill、
AGENTS.md、context、実行コードのどれであっても、必要な変更だけを対象にする。bootstrap のために外部
Codex や人間がファイルを作成・編集した場合は `developer-assisted` と明示し、それを Henji 自身の
self-revision の証拠に数えない。

役割は少なくとも次のように記録する。

- author: 改訂の意図、baseline、比較条件を定義する。
- generator: 改訂候補を作る。Henji、外部 Codex、人間のいずれかを明示する。
- evaluator: evidence と結果を baseline と比較する。
- applier: 候補を次の通常利用へ反映する。自動化水準と human involvement を明示する。

全役割を一度に自動化しなくてもよい。実運用経路と読み返し可能な証拠から Henji が候補を提案・生成する
ところを、最初の製品固有の目標とする。

### Step 3 — 次の通常利用で adoption を比較する

候補を適用した後、同じ目的の通常利用で、元の困難または成功の再現性を観測する。新規セッションを使う
場合はその事実と revision binding を記録し、同一セッションの移行とは表現しない。結果が改善、
不変、悪化、または判断不能のいずれであっても、条件と evidence を経験記録へ追記する。

### Step 4 — 経験に応じて反復する

一回の成功で一般化せず、同じ種類の利用で有用性が続くかを人間の必要に応じて観測する。複数 cycle
が必要になった場合だけ、経験記録の検索、候補の lineage、比較の再現性、Instance replacement 等の
追加設計を別途提案する。Stage 4 replacement、第2の Surface、resident Host、mailbox/schedule は、
最初の cycle の前提条件ではない。

## 9. 参照した固定 snapshot と適用範囲

これらは design の比較材料であって、Henji が同じ機能や authority を採用した証拠ではない。commit は
repository の [`_refs/README.md`](../../_refs/README.md) に記載された pinned snapshot で固定する。

- [Pi coding-agent README](../../_refs/pi/packages/coding-agent/README.md) と
  [compaction docs](../../_refs/pi/packages/coding-agent/docs/compaction.md)、pinned commit
  `a69bef789bc95abf0acee16f7b4660b70b650bb9`。extension hook、context file / tool、authoring、
  session、compaction の比較材料であり、経験からの自動改訂の証明ではない。
- [Zot extensions](../../_refs/zot/docs/extensions.md) と [RPC](../../_refs/zot/docs/rpc.md)、pinned
  commit `9b7bb6a4f36bc8c8deb2cc5796a8f557f4fb7479`。subprocess lifecycle、message boundary、reload
  の比較材料であり、Deno Worker の security boundary や同一 session upgrade を意味しない。
- [OpenComputer Agent README](../../_refs/opencomputer/agent/README.md) と
  [agent source](../../_refs/opencomputer/agent/src/index.ts)、pinned commit
  `d54f2c239a293216ff13f069ffc1ed7b853f9761`。per-call の input/model/tool/subagent
  選択を示すが、経験起点の自己改訂ではない。managed gateway / secret semantics は採用しない。
- [Cloudflare chat continuation](../../_refs/cloudflare-agents/packages/agents/src/chat/continuation-state.ts)、[recovery engine](../../_refs/cloudflare-agents/packages/agents/src/chat/recovery-engine.ts)、[turn queue](../../_refs/cloudflare-agents/packages/agents/src/chat/turn-queue.ts)、pinned
  commit `2f957bc2a3ffb7aee14792bb3cb658ad3176ed93`。continuity、recovery、queue
  の比較材料であり、managed runtime や learning を前提にしない。
- [Cloudflare Sandbox SDK](../../_refs/cloudflare-sandbox-sdk/packages/sandbox/src/sandbox.ts) と
  [command client](../../_refs/cloudflare-sandbox-sdk/packages/sandbox/src/clients/command-client.ts)、pinned
  commit `664d8e36d22f2b8f286a9cac90551113afdb316c`。named identity と physical execution seam
  の比較材料であり、自己改訂や Henji の trust boundary とは解釈しない。

OpenComputer の reactive authoring、Pi の extension / compaction、Zot の RPC、Cloudflare の
continuity は、それぞれ局所的な mechanism の参考である。Deno の basic tool-loop example
も背景資料であって、 自己改訂の先例ではない。会話で確認した user example
は概念上の意図の証拠に使えるが、実装主体や実行
条件が不明な例は技術的証拠・再現性の根拠にはしない。upstream の最新状態もこの proposal
の根拠にしない。

## 10. 未決定事項と次の一手

未決定の選択は最初の実経験を見てからでよい。

- 最初の対象とする、実際に観測した困難または繰り返し使いたい成功は何か。
- 原因仮説は、事実、指示・skill、context/loop、または実行可能な挙動のどこにあるか。
- generator / applier のどこまでを Henji に任せ、どこを developer-assisted と明示するか。
- 新規セッションの比較で十分か、durable replacement が必要か。

推奨する次の一手は、Corrections plan §7を元に新しい real-provider 受入れ package
を準備し、別途承認を 得た Human Gate を self-revision trial
と分離して行うことである。その後、通常利用で一つの具体的な
経験記録を作る。採否、最初の経験、実装計画への分解は、次の利用者判断と別の承認済み計画で決める。
この draft は accepted concept、既存 plan/results、Human Gate
を置き換えず、実装、provider、credential、 production state の操作を認可しない。
