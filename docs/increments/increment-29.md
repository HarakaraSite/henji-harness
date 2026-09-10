# 通常利用 Increment 29 — 自動context変換の停止

ステータス: **完了**

## 利用者が必要とする動作

- modelが一度取得したtool resultを、固定byte閾値によるrequest直前の変換で失わない。
- 長期Session向けのContext Strategyを設計し直すまで、Henjiが自動でsemantic checkpointを生成しない。
- commit済みの完全なcanonical transcriptと、既存checkpointによるprovider向け投影は維持する。

## 根拠となる実行証拠

- 現行のprovider-neutral context変換は、実tokenizerではなくserialized JSONのUTF-8 byte数を使い、
  65,536 bytesで開始して49,152 bytesを目標に、古いtool resultを
  `[older tool result omitted for context]`へ置換する。
- 2026-09-10のDeepSeekによるForgejo API概要調査ではstep 4からこの変換が始まり、最大34件のtool resultが
  省略された。modelは省略をreasoning内で認識し、同じ文書を繰り返し取得した。provider evidenceは
  `580408a3-8dcb-4fda-9d87-1f28635e5afe`である。
- 同workspaceの保存済みprovider evidence 66件中19件に省略markerがあり、8件には同一引数のtool call重複、
  6件には省略を認識したreasoningがあった。Qwenの長時間調査もstep 5から最大32件を省略していた。
- 同じ65,536-byte閾値は、次のuser turnを開始する前にsemantic summaryを自動生成する判断にも使われる。
  現在、コンパクションが必要な長さのSessionは通常利用でまだ観測されていない。

## Product動作

- `prepareModelContext()`はproviderへ渡すrequestのdefensive copyと既存の観測metricsだけを作り、message、
  tool result、provider replay stateを変更しない。
- root、planner、同一turn内のすべてのmodel stepで、semantic checkpointがなければcanonical draft全体、
  checkpointがあればsummaryと正確なcanonical suffixをそのままprovider adapterへ渡す。
- user submit前の自動semantic summary request、checkpoint proposal、automatic-compaction noticeを発生させない。
- 保存済みcheckpointの読込、Sessionとの相関、provider向けsemantic projection、明示的なcompaction APIは残す。
- OpenRouter adapterが持つmessages 5 MiB／complete request 6 MiBの送信上限は変更しない。上限時はtool
  resultを黙って置換せず、既存の明示的なfailureとする。OpenAI Responses adapterは同じlocal byte上限を
  現在持たないため、そのprovider経路へ新しい上限を追加しない。

## 実装計画

1. request直前のtool-result置換を除き、defensive request preparationを内容同一の処理へする。
2. `AgentSession`とproduction `WorkerGeneration`のpre-turn automatic compactionを停止する。
3. 自動処理を前提にするstatus文言とtestを、非変換・非自動生成のproduct動作へ合わせる。
4. focused test、type check、format、lint、`git diff --check`を実行し、差分review後に安定候補を確認する。

## 成功条件

- 65,536 bytesを超える複数step turnでも、前stepまでに得たtool resultが次のmodel requestに完全に残る。
- 長いcommit済みSessionへのuser submitで、summary用provider requestを先行させず通常turnを開始する。
- canonical transcript、既存checkpointのsemantic projection、provider hard limitを変更しない。
- context statusが64 KiBを自動変換上限として表示せず、tool resultの省略件数も表示しない。

## 対象外

- 新しい自動コンパクション、model別context-window判定、tokenizer、summary strategy
- Context Strategyの外部component化、revision管理、比較・採用・rollback
- SQLite、append-only Session storage、tool result参照と再取得tool
- canonical transcript schema、既存checkpointの削除またはmigration
- 構想、architecture、roadmapの変更

## 承認

- 利用者は2026-09-10、長期Session向けContext Strategyを別途設計するまで、request直前の機械的省略と
  pre-turnの自動semantic compactionを停止する方針を承認した。
- 完全なcanonical transcriptをSessionの正本として保持し、既存checkpoint投影を維持する。

## Roadmap差異

- 利用者は2026-09-10、`docs/roadmap.md`のF04を、保存済みsemantic checkpointの読込・投影を維持しつつ、
  自動checkpoint生成はIncrement 29で停止中という現行状態へ更新することを承認した。

## 実装結果

- model request直前のtool-result置換を削除し、`prepareModelContext()`を内容同一のdefensive copyとbyte観測に
  限定した。root、planner、複数model stepで同じ経路を使う。
- `AgentSession`とproduction `WorkerGeneration`からpre-turn automatic compactionの発火経路を削除した。
  長いcanonical履歴でもsummary requestやcheckpoint proposalを先行させず、user turnを直接開始する。
- 明示的なsemantic compaction API、保存済みcheckpointの読込、summary＋正確なcanonical suffixの投影、投影を維持した。
- ready statusは旧`64K`自動変換上限と省略件数を表示せず、現在のcontext byte量だけを`ctx N KiB`で示す。
- Context Strategyの外部化、SQLite等のappend-only正本、stable tool-result参照とread-only再取得toolは、
  `docs/experience/normal-use-inbox.md`へ未採用候補として保存した。

## 検証結果

- focused context testは4件成功。長いSessionで自動summaryを呼ばないこと、summary failureがsubmitを妨げないこと、
  既存checkpointがsummary＋正確なsuffixを投影すること、旧64 KiBを超えるtool resultが次のmodel stepへ完全に残ることを
  確認した。
- Worker foundation testは42件成功。長い履歴の直接commit、user-turnだけのrequest count/evidence、既存checkpointの
  reopen、automatic noticeが出ないことを確認した。
- TUI conversation testは11件成功。旧64 KiB上限・省略件数表示を除いたstatusを確認した。
- type check、196 filesのformat、193 filesのlint、`git diff --check`、offline `v0:test`が成功した。
- 差分reviewで未解決findingはない。live provider、real-TTY、browser E2Eは対象外のため実行していない。
