# Durable historyとcontext rebuildの概念整理

ステータス: 構想・architecture・roadmapを更新するための議論整理。個別incrementの計画、実装認可、
SQLite採用決定ではない

確認日: 2026-09-12

## 目的

Henjiの会話・実行履歴を何として残し、人間とAIがどう参照し、改訂されたinstruction等をどう次の実行へ
適用するかを整理する。目的は過去の実行を完全に再現することではなく、次の二つである。

1. 当時Henjiが観測できた実行内容と、その判断に関与したAgent側の状態を、後から振り返る材料として残す。
2. 人間の明示操作により、改訂されたresourceから新しいAgentの実効状態を構築し、後続executionへ適用する。

## Product上の価値

Henjiには、相互に関係する二つの価値がある。

- **自己改訂可能なagent**: 通常利用の経験を解釈し、instruction、skill、Agent Definition、tool等の
  改訂候補生成へAIが関与できる。
- **アトミックな履歴**: 会話の正本へ採用するturnを原子的に確定しながら、cancel、failure、途中の
  tool result等を観測記録として失わない。

アトミックな履歴は自己改訂を支える基盤だが、通常利用の信頼性、診断、履歴参照においても独立した価値を
持つ。目指す関係は、「履歴の正本を壊さずに、自分を改訂できるagent」である。

## 履歴と会話の正本

### Durable history

durable historyは、Hostが取得・記録できたexecution evidenceと、そのexecutionを解釈するためのcontext
attributionを保持する。

- user input、assistant output、Hostが受け取れるthinking/reasoning出力
- tool call/result、provider evidence、進捗、終了状態
- completed、cancelled、failed、interrupted等のoutcome
- 使用したAgent側の基底設定、会話revision、明示projection、実行中に読み込んだresourceや観測情報
- canonical採用、`/recall`、将来の`/rebuild`による関係

「実際に起きたことすべて」を保証する言葉にはしない。crashや外部effectによりHostが観測できなかった事象は
あり得る。

### Canonical conversation

canonical conversationはdurable history全体ではなく、Hostが正常完了と会話への採用を確定したturnを
順序付きで並べた会話上の正本である。ここでいう正常完了は、回答内容の正しさや利用者の満足を意味しない。
期待と違う回答も、正常に完了して採用され、その後の改訂材料になり得る。

canonical採用はturn全体を単位とし、途中状態だけを採用しない。turnへ含めるmessage、tool interaction、
projectionの具体的範囲は、storage設計時に決める。

### 二つのcommit

- **storage commit**: evidenceを消失させないため、SQLite等のstorageへdurableに保存する物理的commit。
- **canonical adoption**: 成功したturnを、以後の通常会話へ引き継ぐ正本として採用する意味上のcommit。

cancelled/failed executionもstorage上ではdurableに保存できる。そのため、storageの説明以外では
`uncommitted`より`non-canonical`を使い、「保存済みだが会話へ未採用」であることを明示する。

## 状態を表す独立した軸

executionを一つの`committed/uncommitted`だけで分類しない。

- lifecycle: `active` / `settled`
- outcome: `completed` / `cancelled` / `failed` / `interrupted` / `unknown`等
- conversation adoption: `canonical` / `non-canonical`

active executionもまだcanonicalではないため、`settled non-canonical execution`と`non-canonical`全体は同義では
ない。tool effectの有無も別軸であり、canonicalに採用されなかったことから外部effectがなかったとは推定しない。

## 人間向けhistory viewとmodel context projection

人間は、canonical/non-canonical双方を履歴全体として参照できる必要がある。将来のhistory viewはchat
transcriptだけでなく、execution/attempt、outcome、tool activity、context attribution、projection、transitionを
識別できる表示とする。

Markdown renderer、tool call summary/detail inspector、status表示等はSurfaceの表示責務である。保存された
内容やcanonical状態をrendererが変更しない。

modelへ渡すcontext projectionはhistory viewとは別責務である。過去executionから既定で引き継ぐ会話履歴は
canonical conversationだが、現在execution内で得たtool result等は同じexecutionの後続model requestへ渡る。
概念上の入力は次のようになる。

```text
canonicalな過去会話
  + activeなAgent側の基底設定
  + 現在execution内で得た文脈
  + /recall等で明示選択されたprojection
  + 現在のtaskとruntime input
```

## `/recall`

`/recall`は、人間がsettled non-canonical executionを選び、その保存内容を次の一つのtaskへ明示的に投影する
Host operationである。

- source executionをcanonical化、resume、自動retryしない。
- sourceの内容が正しいと人間が承認したことを意味しない。
- source identityと実際のprojection内容をtarget executionからreadbackできるようにする。
- targetが成功した場合もsourceはnon-canonicalのままにする。
- 「一度だけ」はprojectionを投入する対象taskを意味する。同じtask内の各model requestでは利用できる。
- targetから生成されcanonical採用された回答は通常の会話として後続へ残り得る。

projection本文そのものをcanonical turnへどこまで含めるかは未決である。

## InstructionとAgent状態の来歴

会話とtool実行だけでは、「何が起きたか」は分かっても「なぜその判断になったか」を十分に振り返れない。
各executionを、その判断に関与したAgent状態と結び付ける。

対象候補には次を含む。

- Henji共通instruction、agent role、workspace `AGENTS.md`
- 利用可能だったskill catalogと、実際に読み込まれたskill
- Henjiが所有または観測できるsystem instruction
- Agent Definition
- modelへ提示したtool name、description、input schema等のtool contract
- modelへ渡した、またはtoolにより観測した環境情報
- canonical conversation revisionと`/recall`等のprojection

存在していたresource、発見されたresource、実際に読み込まれたresource、modelへ渡された内容を区別する。
環境全体をsnapshotせず、Henjiが判断材料として供給・観測した範囲を記録する。後から内容を振り返る必要が
あるinstructionやtool contractは、現在のmutable fileへのpathだけに依存しない。

このattributionは再現性の保証ではない。過去Worker、依存module、OS、filesystem、外部service状態、toolの
外部effectを再構築することは目的にしない。

## Context generation

`context generation`は、将来の`/rebuild`によって構築・有効化するAgent側の基底設定を表す概念候補である。
各executionは、使用したgenerationと相関する。ただしgeneration IDだけでmodel input全体を表さない。

各executionにはgenerationに加え、少なくとも次の動的入力が存在する。

- execution開始時に参照したcanonical conversation revision
- 明示的なprojection
- execution中に読み込んだresource
- execution中に得たtool resultと環境観測

`AgentWorkerGeneration`というprocess/isolate lifecycleと、ここでいうAgent側の基底設定revisionを同じ概念と
みなすか、別identityにするかはarchitecture上の未決事項である。

## `/rebuild`

`/rebuild`は、再解決の対象として定めたresourceから新しいAgentの実効状態を構築し、後続executionへ適用する
人間向けHost operationの候補である。単なるfile reloadではなく、contextを再構築して適用する意味を持つ。

想定する流れは次のとおりである。

```text
context C1で通常利用
  -> 期待との差を観測
  -> instruction等を改訂
  -> 人間が/rebuildを実行
  -> context C2を構築・有効化
  -> 後続executionをC2で実行
```

対象resourceと実際に更新できる範囲は未決である。workspace instructionとskillに加え、Agent Definitionや
tool contract/implementationも候補に含む。toolを対象にする場合、modelへ提示するcontractと実際にdispatch
するimplementationの対応を定める必要がある。

採用する場合のarchitecture案は次である。

- active executionの途中では切り替えず、execution間の境界で新状態を適用する。
- 新しい基底設定の構築に成功してからactive generationを切り替える。
- 構築失敗時は旧generationを維持する。
- canonical conversationと未送信draftを維持し、過去turnの内容やattributionを書き換えない。
- context transitionをHost-ownedなdurable eventとしてsource/target generationと相関させる。

これらは`/rebuild`の具体的incrementを採用する前に確定する設計案であり、現行実装の保証ではない。

cancel/failed executionのtool effectとしてresource fileが変更された場合、その変更自体は既に外部副作用として
存在する。`/rebuild`は、対象resourceの現在内容を新しいAgent状態へ取り込む境界であり、source executionの
canonical化、既に生じた副作用の承認または取消しを意味しない。

## 自己改訂との接続

履歴とcontext attributionにより、人間とAIは、どのAgent状態で何が起きたかを振り返れる。人間の指示を契機に
AIがresourceの改訂候補生成へ関与し、人間が明示的に採用または適用した後、次の通常利用で変化を経験する。

`/rebuild`を採用する場合、それは改訂候補の生成そのものではなく、対象resourceの現在revisionを後続executionへ
適用するactivation境界になる。candidate保存・承認・managed revisionへのpromotionと、native resourceの現在内容を
再解決する操作が同じflowになるかは、対象resourceごとのarchitectureで決める。

## 求めないもの

- 過去Workerまたはmodel内部状態の再現
- 同じ回答の再生成や決定論的replay
- dependency、binary、OS、filesystem全体のsnapshot
- 外部service状態の再現
- tool外部effectのrollback
- 完全なevent captureを前提にした説明

## SQLite設計前の未決事項

1. `task`、`execution`、`turn`、`model request`の正確な関係。
2. canonicalへ採用するturnの内容とatomicな単位。
3. execution evidenceをどの時点・粒度でdurableにするか。
4. context generationが所有する基底設定と、execution単位の動的inputの境界。
5. `/rebuild`対象resourceと、各resourceのselection/activation authority。
6. `/recall` projection本文をcanonical turnへ含める範囲。
7. human history viewから各execution、context、projection、transitionをどう辿るか。
8. 現行Session JSONを発展させるかSQLiteを採用するかを含む物理schemaとmigration。

SQLiteは候補であり、この整理自体から採用を導かない。採用する場合も、durable history、canonical adoption、
model context projection、resource revision、toolの外部作業状態を一つの曖昧な`messages`状態へ混在させない。
