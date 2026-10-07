# HenjiとPi OpenCode Zotの機能比較とcontext整理の検討

調査・議論日: 2026-10-07

状態: 機能比較と利用者との検討記録。個別incrementへの採用・実装は未承認。

Pi・OpenCode・Zotの参照を更新し、Henjiの今後の機能拡張候補を比較した。その後、token節約とcacheの
仕組みを確認し、context整理と履歴参照の関係を検討した。利用者は実装を開始しないと明示している。

議論の中心は、回答品質と作業の継続に必要なcontextを優先し、詳細なtool結果をDBへ保持したまま、
modelには結論・必要な根拠・詳細への参照を渡すcompaction案へ移った。cacheは必要な共通contextの
再利用による費用・時間の削減に使い、hit率そのものを目的にしない。

未採用候補の正本は[通常利用メモ](../experience/normal-use-inbox.md)に置く。本記録は今回の比較と議論の
根拠をまとめる。構想・architecture・roadmapの変更、background要約、履歴toolやcompactionの実装を
採用したものとして扱わない。

## 比較対象と参照版

| 対象     | 調査対象のcommit                           | 位置付け                           |
| -------- | ------------------------------------------ | ---------------------------------- |
| Henji    | `009cb47a9431be651f64a90918228fd42d161596` | 現行sourceと担当領域の正本文書     |
| Pi       | `b30a6dd779340f7bc2f3ffa60f4c0a5f914ba9ae` | `earendil-works/pi`のmain snapshot |
| OpenCode | `ecc4916b5a9608c30e6dd58a67f2137b594407ca` | `anomalyco/opencode`のdev snapshot |
| Zot      | `d1e278ee2400cc686983c9b1f7949bd905501e39` | `patriceckhart/zot`のmain snapshot |

参照更新の選択・取得・license・変換規則は[_refs README](../../_refs/README.md)を参照する。三参照は
default
branchのsourceを2026-10-07に更新したもので、最新release同士の比較ではない。snapshotは
Git管理外なので、別checkoutでは記録したcommitから取得する。

公式APIのcache・reasoning仕様は2026-10-07時点の説明として扱う。OpenAI
APIの料金・保持仕様を、そのまま ChatGPT
sign-in経路の利用枠へ換算することはできない。実際のcache
hit率や三参照の節約量を示す benchmarkは今回の比較にはない。

## 機能比較と拡張候補

Henjiは、provider/tool loop、instructions・skills、外部tool・hooks、async
child、独立CoreとTUI、 canonical/non-canonical履歴とcontext
attributionを既に持つ。参照の機能数をそのまま導入目標にせず、
人間の通常利用で何が不足するかを比較する。

| 領域               | Pi                                                | OpenCode                                                           | Zot                                              | Henjiとの比較                                                               |
| ------------------ | ------------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------ | --------------------------------------------------------------------------- |
| 指示・skills       | instructions、skills、prompt templates、extension | rules、skills、primary/subagent設定、plugin                        | instructions、skills、subprocess extension       | 基盤はHenjiにもある。本文の必要時読込みは既存の節約策                       |
| resourceの再読込み | `/reload`でresource・extensionを再読込み          | 設定・plugin・toolの供給経路がある。Piと同じreload操作とは扱わない | `/reload-ext`でextensionを再起動・registry再構築 | 会話やdraftを保った実効構成の再構築はF27候補                                |
| 履歴・Session      | tree・branch・再開・export                        | Session・child Session・fork関連API                                | timeline・export/import・fork・tree              | Henjiの強みは会話採用と実行記録を分けたDB履歴。tree/forkの有用性は保留      |
| 子への委譲         | subagent extension等で組み合わせる                | Taskとchild Session                                                | background swarmと追加message・監視              | Henjiにもasync childはある。途中報告・追加指示・待機の改善はA24             |
| token・cache usage | usageと費用を集計。warming分も記録                | messageのtoken・費用情報                                           | provider usage・cache情報                        | Henjiのrequest単位usage保存・readbackはA29候補                              |
| context整理        | 自動・手動compaction、branch summary              | 自動compactionと独立したtool-output prune                          | 自動・手動compact                                | Henjiは既存の自動省略・自動compactionを停止済み。A3で再検討                 |
| コード内での集計   | codemodeからtoolを呼び、結果を加工                | MCP codemodeはexperimental                                         | codemodeからtoolを呼び、結果を加工               | ファイル・API結果の集計はrun_typescriptで既に可能。登録tool呼出しに差がある |
| MCP                | 組込み。toolの公開方式を選択                      | 組込み。codemodeはexperimental                                     | MCP bridgeはopt-inのexample extension            | 一般MCPは将来候補。具体的に必要な連携から判断する                           |
| LSP                | extensionによる追加などを検討可能                 | diagnostics統合。LSPは既定無効、専用toolもexperimental             | 今回は標準の同等経路を確定していない             | CLIのtype check等で困る具体例があるかを先に見る                             |
| 画像入力           | file・画像の入力とread                            | image/file partsを扱う                                             | clipboard・画像入力等                            | HenjiではP9。transcript・provider encoding・表示を含む候補                  |
| 人間への選択肢提示 | extension UI                                      | question tool                                                      | extension UI等                                   | 小さな選択を扱う操作の比較材料。一般的な追加承認flowの採用を意味しない      |
| 外部からの操作     | RPC・TypeScript SDK                               | server・SDK                                                        | RPC・Go SDK                                      | HenjiにもHTTP/SSEとCLIがある。外部protocol拡張は別の利用目的で判断          |

比較の入口はPiの[機能案内](../../_refs/pi/packages/coding-agent/docs/index.md)・
[extensions](../../_refs/pi/packages/coding-agent/docs/extensions.md)、OpenCodeの
[agents](../../_refs/opencode/packages/web/src/content/docs/agents.mdx)・
[tools](../../_refs/opencode/packages/web/src/content/docs/tools.mdx)・
[LSP](../../_refs/opencode/packages/web/src/content/docs/lsp.mdx)、Zotの
[README](../../_refs/zot/README.md)・[extensions](../../_refs/zot/docs/extensions.md)である。
Henjiの現行範囲は[roadmap](../roadmap.md)と
[architecture](../architecture/henji-host-agent-worker.md)を参照する。

### 比較で挙がった候補の整理

初期比較ではA29、A24、F28、F27、A3を主な検討候補とし、画像入力、MCP、codemode、LSP、人間向けの
小さな選択操作を利用目的に応じた候補として挙げた。実装順序や採用を確定したものではない。

その後の利用者との議論で、token節約に関する候補の評価を次のように修正した。

| 当初の説明                                  | 今回の整理                                                                                                                        |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| コード内で加工して必要な結果だけmodelへ返す | run_typescriptで基本部分は実現済み。新規候補として広く挙げすぎた                                                                  |
| tool定義の遅延公開とprefixの安定化          | 二つを分ける。遅延公開は大量のMCP tool等で効きやすいが、Henjiでの効果は未測定。prefixの安定化は必要な内容を維持できる範囲で考える |
| 保存する履歴と次回modelへ渡す履歴の分離     | 利用者が検討を希望。DBの原本、軽量context、IDからの再取得を一体で考える                                                           |
| usageの保存                                 | 節約策そのものではなく、費用とcontext整理の効果を把握するA29の候補                                                                |

既存判断も維持する。`/jump`・`!command`は候補から除外済み、`/btw`は対象外、Session
tree/forkは保留、
swarm全体は時期尚早である。A27の自動retryは保留し、現行の手動`/recall`を維持する。
登録toolをコードから呼ぶ差分の説明だけで、取り下げ済みA30を再採用したことにはしない。

## 三参照のtoken節約の仕組み

入力token削減、prompt
cacheによる処理の再利用、通信量・model往復の削減は別の効果である。
並列tool実行そのものがtoken削減になるとは限らず、子への委譲で親contextが小さくなっても、
全agentの合計tokenが減るとは限らない。

### Piの情報量とcacheの制御

- compactionは既定ON。直近約20,000tokenを保持し、古い部分を構造化した要約へ置き換える。
  要約用requestでもtool結果を各2,000文字へ短縮し、要約処理への巨大な再入力を抑える。
  要約生成では`cacheRetention: "none"`を指定する。
- read/bash等は既定2,000行・50KiBを基準に出力を区切る。readのoffset/limitや、保存した大きな出力の
  部分取得で必要な情報へ戻れる。
- MCPの既定公開方式はcodemode。個々のschemaを最初から全件提示せず、検索・詳細確認から利用する。
  deferredでは検索で選んだ定義を次のmodel
  requestへ公開する。directは常時宣言する方式である。
- MCP
  server説明が変わった場合、過去のprefixを書き換えず新しい説明を会話へ追加する。
- codemodeは登録toolの連続呼出しと中間結果の加工を行い、明示出力だけをmodelへ渡す。
  store/loadでIDやcursor等を保持できる。MCP以外でのcodemode利用はtool選択による。
- Anthropicではsystem・tool定義・会話にcache markerを置く。通常OpenAI
  Responsesではsession由来keyや retentionを扱うが、ChatGPT
  sign-in・専用Codexの送信項目は別である。

Piの特徴的な処理には、次の二つがある。

**cache
warming**は、期限前の追加requestでcacheを維持する処理である。global設定の既定はstreamingで、
idle中の継続はopt-in。catalogがTTLを付ける標準対象はdirect
Anthropicであり、OpenAI/Codexが一律に
warmingされるわけではない。料金・継続確率から見積もった節約が追加費用を上回る条件で実行する。
これは有料の追加処理で、実測の節約保証ではない。

**CodexのWebSocket
continuation**は、auto等の経路で利用可能な接続と履歴・設定の一致条件を満たすと、
previous_response_idと追加inputだけを送る。条件が崩れると全文送信へ戻る。通信量を減らす仕組みであり、
modelの論理contextや課金入力が追加分だけになることを意味しない。

根拠: [compaction](../../_refs/pi/packages/coding-agent/docs/compaction.md)、
[MCP公開方式](../../_refs/pi/packages/coding-agent/docs/mcp.md)、
[codemode](../../_refs/pi/packages/coding-agent/docs/codemode.md)、
[出力の区切り](../../_refs/pi/packages/coding-agent/src/core/tools/truncate.ts)、
[Anthropic adapter](../../_refs/pi/packages/ai/src/api/anthropic-messages.ts)、
[Responses adapter](../../_refs/pi/packages/ai/src/api/openai-responses.ts)、
[warming](../../_refs/pi/packages/coding-agent/src/core/cache-warmer.ts)、
[TTLのcatalog設定](../../_refs/pi/packages/ai/scripts/generate-models.ts)、
[Codex差分送信](../../_refs/pi/packages/ai/src/api/openai-codex-responses.ts)。

### OpenCodeの要約と古いtool結果の省略

- 自動compactionは既定ON。古い会話の要約と、予算に合わせた最近の履歴を組み合わせる。
  要約用tool出力も各2,000文字に短縮する。
- tool-output pruneは要約と独立した機能で、今回のsnapshotでは既定OFF。
  有効時は最新user
  span等を除外し、対象となる直近のtool出力約40,000tokenを保護する。
  古い出力の省略候補が約20,000tokenを超えると、本文を保存したままcompacted
  markerを付け、 次のmodel
  requestで短い省略表示へ置き換える。skillの結果は保護する。
- 大きなtool出力は既定2,000行・50KiBで区切り、保存fileからgrepやreadで部分取得する。
- system先頭と会話末尾のmessageにprovider別cache指定を付ける。OpenAI等ではsession
  IDをkeyとして使う。 requestのtool定義は名前順へ揃える。
- MCP codemodeはexperimental
  flagで有効になる。標準設定で全toolをコード内から扱う機能とは区別する。

根拠:
[compactionとprune](../../_refs/opencode/packages/opencode/src/session/compaction.ts)、
[省略後のrequest投影](../../_refs/opencode/packages/opencode/src/session/message-v2.ts)、
[既定設定](../../_refs/opencode/packages/web/src/content/docs/config.mdx)、
[出力の区切り](../../_refs/opencode/packages/opencode/src/tool/truncate.ts)、
[provider cache指定](../../_refs/opencode/packages/opencode/src/provider/transform.ts)、
[request構成](../../_refs/opencode/packages/opencode/src/session/llm/request.ts)、
[codemode登録](../../_refs/opencode/packages/opencode/src/tool/registry.ts)。

### Zotのcodemodeと履歴の保持

- interactiveの自動compact閾値は既定85%。古い履歴を要約し最近のmessageを残す。
  今回確認したserializerではtool結果本文の個別短縮を行わず、要約用requestが大きくなり得る。
- read/bashのmodel向け出力は既定2,000行・50KiBで区切る。
- codemodeはopt-in。通常modeは直接のtool定義も残し、only
  modeはコード経由へ寄せる。
  inline定義の予算は既定約3,000tokenで、0なら検索による発見だけにできる。
  中間tool結果は個別のmodel
  messageにせず、明示出力だけを返す。store/loadの状態も維持できる。
- MCP bridgeは組込み既定機能ではなくexample extension。最初はloader
  toolだけを提示し、 検索で一致したschemaを必要時に公開する。定義のdisk
  cacheやserverの休止はLLMのprompt cacheと別である。
- Anthropicではcache markerを付け、tool結果の追加で以前のuser
  messageを書き換えないようにしてprefixを保つ。 Bedrockにもcache
  point指定がある。
- OpenAIの通常Chat Completionsとnative Codexでは送信項目が異なる。native
  CodexのkeyはStreamごとに
  新しく生成するため、Piの会話単位の安定keyとは異なる。ただし、この差だけでcache
  missとは断定しない。 今回のnative Codex
  adapterにはWebSocketの差分continuationはない。

根拠: [compact](../../_refs/zot/packages/core/compact.go)、
[interactive](../../_refs/zot/packages/agent/modes/interactive.go)、
[read](../../_refs/zot/packages/agent/tools/read.go)・[bash](../../_refs/zot/packages/agent/tools/bash.go)、
[codemode](../../_refs/zot/docs/codemode.md)、
[MCP bridge](../../_refs/zot/examples/extensions/mcp-bridge/README.md)、
[Anthropic adapter](../../_refs/zot/packages/provider/anthropic.go)、
[Codex adapter](../../_refs/zot/packages/provider/openai_codex.go)。

### Henjiで既にできること

run_typescriptはファイルを直接読み、fetchで取得したデータを処理して、必要な結果だけ返せる。
JSON/JSONL/CSVの集計・変換、大きなcommand出力をfileへ書いてから加工する用途を既に案内している。
read
window、searchのcount・集計、bash_outputの部分取得、skill本文の必要時読込みもある。

Pi・Zotとの差は、コードから登録済みtoolをtools.xxx()で呼べる点である。Henjiのrun_typescriptには
現在その入口がなく、Denoのfile
APIやfetchを直接使う。ファイル集計におけるtoken節約を未実装とは扱わない。

HenjiのResponses adapterには明示的cache
key/retention指定がないが、providerの自動cacheはあり得る。
usageを保存していないため、実際のhit率・消費の主因は判定できない。

根拠: [run_typescript](../../v0/agent/tools/run_typescript.ts)、
[Responses adapter](../../v0/agent/provider/openai_responses_model.ts)、
[A29](../experience/normal-use-inbox.md#a29--request単位のtoken-usagecache再利用量の保存とreadback未採用メモのみ)。

## cacheの仕組みとcontextへの影響

prompt
cacheは、入力を処理したmodelの内部状態であるKV状態をprovider側で保持し、同じprefixを
再処理する計算を省く仕組みである。回答の使い回しではない。cached入力もcontextの一部として参照される。
料金・最初の出力までの時間は減らせるが、context使用量がその分消えるわけではない。
[OpenAI公式説明](https://developers.openai.com/api/docs/guides/prompt-caching)

### agentで長い共通部分ができる理由

Henjiはrequestごとに、その時点の履歴をmodelへ渡す。新しい指示やtool結果だけが追加される間は、
以前の指示・会話・tool結果が長い共通prefixになる。

```text
request 1: [instruction・tool定義・過去の会話] [指示1]
request 2: [instruction・tool定義・過去の会話] [指示1] [tool結果]
request 3: [instruction・tool定義・過去の会話] [指示1] [tool結果] [追加結果]
```

例えば共通10,000tokenと追加500tokenがあり、共通部分が全てhitした場合、入力全体は10,500token、
cached入力は10,000token、新しく処理する入力は500tokenである。入力全体が500tokenになったとは解釈しない。

### 最低長と有効期限

2026-10-07時点の代表例は次の通り。最低長はinstruction単体でなく、cache対象prefix全体で数える。

| provider/model                  | 最低長                    | 有効期限                             |
| ------------------------------- | ------------------------- | ------------------------------------ |
| OpenAI GPT-5.6以降              | 1,024 visible input token | 最後の書込み・再利用から最低30分     |
| OpenAI GPT-5.5                  | request設定による         | 通常約30分、最大24時間               |
| 以前のOpenAI modelのin_memory   | request設定による         | 未使用になって通常5〜10分、最大1時間 |
| 対応OpenAI modelの24h           | request設定による         | 通常約30分、最大24時間               |
| Claude Opus 5.5・Sonnet 5.5等   | 512token                  | 既定5分、指定で1時間                 |
| Claude Sonnet 4.6・4.5          | 1,024token                | 同上                                 |
| Claude Opus 4.6・4.5、Haiku 4.5 | 4,096token                | 同上                                 |

OpenAIの以前のmodelではtool・画像・reasoning等の設定で最低長が変わる。OpenAI側のhidden
contentは GPT-5.6以降のvisible
input最低長へ含めない。Claudeの期限はrequest開始から数え、再利用で更新する。
[OpenAI公式仕様](https://developers.openai.com/api/docs/guides/prompt-caching)・
[Claude公式仕様](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)

### 固定instructionと履歴変更

cache breakpointは保存・再利用するprefixの終端、TTLは保持期間を表す。cache
keyは関連requestの振分け・
識別を助ける値であり、同じkeyだけでhitは保証されない。OpenAI
GPT-5.6以降はroutingを自動で扱い、 keyはcache最適化に必須ではない。

同じinstructionを各requestの先頭に置き、後ろへ履歴を足す構成は再利用に適する。履歴を要約・省略しても、
変更箇所より前の共通部分は再利用候補にできる。ただし実際のprefixにはproviderの内部指示・tool定義等も
含まれるため、instructionの文字列だけが同じでもhitは保証されない。

```text
前回: [固定prefix] [1] [2] [3]
次回: [固定prefix] [1・2の要約] [3] [4]
       共通候補      ここから変更
```

共通1,024tokenの後ろがxxxとyyyで違っても、その位置まで保存・再利用できるcacheの区切りがあればhit候補と
なる。1,024tokenは最低長であり、一致しただけで必ずhitする単位ではない。期限、model、関係する設定、
利用可能な区切りも影響する。

先頭の1・2を外して3から送ると、3の本文が同じでも「1・2を踏まえて処理した3」のKV状態はそのまま使えない。
新しいprefixのcacheを作り、その後のrequestで再利用する。毎回履歴を動かす方式と、区切りでまとめて
整理する方式は、この作り直しの頻度も異なる。

### thinkingの引継ぎ

表示用thinkingとproviderへ戻す推論状態は別の情報である。HenjiのResponses
adapterは返されたreasoningを 含むoutput
itemsを保存し、同じprovider/modelへの後続requestへ再送する。
[Henjiのreplay](../../v0/agent/provider/openai_responses_model.ts)

OpenAIではcurrent_turnが進行中の依頼、all_turnsが利用可能な過去の依頼のreasoningも対象にする。
GPT-5.6系はall_turnsが既定で、以前のmodelはcurrent_turnが既定。送信payloadに含まれることと、
providerがmodelのcontextへ採用することは分ける。
[OpenAI reasoning仕様](https://developers.openai.com/api/docs/guides/reasoning)

Claudeもtool-resultを返すときにthinkingを引き継ぐ。過去turnのthinkingを保持するかはmodelにより異なる。
この取扱いも履歴prefixの一致に関係する。
[Claude thinking仕様](https://platform.claude.com/docs/en/build-with-claude/thinking)

## contextの質を優先する整理方針

利用者は、cacheに当たることよりもmodelが必要な情報を使えるcontextを重視する方向を示した。
改善したい具体例として、DeepSeekが無駄な探索を繰り返さないことを挙げた。重複探索の原因や改善効果は
この議論だけでは確定していない。

cached
tokenにも費用がかかり、context容量を使う。hitのために無意味な文字列を足したり、必要な指示更新を
避けたりすることは、作業に必要な情報を扱いやすくする目的に合わない。回答品質への影響は、主に
modelへ渡す内容をどう変えるかで評価する。

cacheとcontext量の釣合いは次のように考える。

- 直近のtool結果を使っている間は、履歴を維持する意味がある。
- 巨大なデータは、最初からrun_typescript等で必要な部分を返すと、後から履歴を書き換えずに済む。
- 用件が完了し後続と関係が薄くなったら、詳細結果をcontextから外す候補にする。
- 結論・利用者判断・必要な根拠・未解決事項は、後続作業への引継ぎとして残す。

「4ターン目だから切る」「全ての完了tool結果を即座に落とす」といった固定規則は決まっていない。
1・2ターンで用件が完了し3・4が別の用件なら、以前の詳細が不要になる可能性は高まる。同じ作業の
続きなら、必要な情報を選び直す。

```text
2ターン目: [instruction] [1] [2]
3ターン目: [instruction] [1] [2] [3]
4ターン目: [instruction] [1・2の結論と参照] [3] [4]
5ターン目: [instruction] [1・2の結論と参照] [3] [4] [5]
```

これは整理の概念例である。4ターン目への切替を既定にするものでも、background要約を意味するものでもない。

## DBの詳細へ戻れるcompaction案

利用者が示した案は、tool結果が残るDBを活かし、contextに参照IDを残して、modelにIDから読むtoolを持たせる
構成である。今回のcompactionの要点は、保存した詳細を保持しながら、通常requestには必要な結論・根拠と
詳細への参照を渡すことにある。

Henjiはmessage本文、tool call/result等のsemantic記録、実効構成、context
attributionをDBへ保存する。 semantic
recordにはIDがあり、execution・ordinal・contentへの対応がある。canonical会話と
non-canonical実行の区別も維持する。この基盤は、後のmodelが根拠を再取得するための材料になる。
[schema](../../v0/agent/history/history_schema.ts)・
[semantic model](../../v0/agent/history/history_semantic_model.ts)・
[保存責務](../architecture/henji-host-agent-worker.md#新dbの保存責務)

ここで参照する原本は、Henjiが実際に保存したtool引数・返却結果である。tool自身が返さなかったfile全文や
外部の最新状態まで、DBに存在すると仮定しない。

### 通常contextと詳細参照の役割

通常contextに残す情報の概念例:

```text
調査対象: ○○の不具合
結論: 原因は△△の処理
根拠: 該当file・箇所、観測した結果
後続への引継ぎ: 採用した方針と未解決事項
詳細: 元のtool call/resultを読める参照ID
```

具体的なID形式、必要なmetadata、要約のschemaは未決である。DBのoccurrence
IDやexecutionとcallの組は
既存A3で検討している候補。IDにtool名・対象・短い要点を添える案は、modelがどれを読むか判断するための
説明になる。裸のIDだけを残す方式との差は利用で比較する。

必要時の参照toolは、IDから原本または必要な範囲を取得する入口として考える。IDを知らない場合の検索と、
既知IDの読取りは別の用途である。history_search/history_readという名前も既存A3の仮案であり、APIを
確定したものではない。人間が失敗実行を次taskへ投影する/recallとも役割を分ける。

回答は調査結果の要約として使える可能性があるが、自然言語の最終回答だけで必要な根拠が全て残るとは
決めない。根拠の所在がなくなると再探索を誘発し得るため、後続に必要な情報と参照をどう残すかを検討する。

### 要約の作成時点と切替時点

必要になった時点で要約する方式と、backgroundで要約を準備して必要時に切り替える方式は別案である。
background方式は切替の待ち時間を減らせる可能性がある一方、使わなかった要約にも費用がかかる。
常時backgroundで動く機構は、今回の議論では採用していない。

どちらでも、cacheへの影響が生じるのは次のmodel
requestに渡す履歴を置き換えた時点である。
要約を準備しただけで通常requestのprefixが変わるわけではない。

## 今後判断する事項

検討の中心はA3とF28を接続するcontext整理と履歴参照であり、A29は費用・再取得・cacheの効果を把握する
材料として関係する。現行の自動compaction停止を覆す採用や、専用履歴toolの実装指示はまだない。

| 判断事項          | 今回の議論で残った問い                                                                  |
| ----------------- | --------------------------------------------------------------------------------------- |
| 整理の契機        | 用件の完了をどう判断するか。token量や次の作業との関係をどう使うか                       |
| 残す内容          | 結論・根拠・参照ID・利用者判断・未解決事項を何から作るか                                |
| 原本の参照        | IDで読む単位、部分取得、対象説明、ID不明時の発見方法                                    |
| tool callとの対応 | 結果本文を軽量化しても、呼出しと結果の対応や因果構造をどう維持するか                    |
| reasoning         | provider/modelが必要とする推論状態と、整理するtool結果の関係                            |
| 適用範囲          | 通常requestへの投影と、DBの原本・canonical/non-canonical・checkpoint・attributionの分離 |
| 作成時点          | 必要時の整理で足りるか。backgroundの準備に実利用上の利点があるか                        |
| 効果の確認        | 回答品質、目的達成、不要な再探索、再取得の負担、合計token・費用をどう比較するか         |

cache
hit率だけでは成否を判定しない。要約・warming・子・履歴再取得を含む費用と、実際の作業結果を
比較できることが重要である。実provider
call、採用increment、具体実装は別途利用者が判断する。

関連する正本:
[A3](../experience/normal-use-inbox.md#a3--context-strategyの外部化f02f06将来のf24候補)、
[A29](../experience/normal-use-inbox.md#a29--request単位のtoken-usagecache再利用量の保存とreadback未採用メモのみ)、
[F28等のroadmap](../roadmap.md#durable-historyとcontext適用)、
[自動省略を停止したIncrement 29](../history/increments/increment-29.md)。
