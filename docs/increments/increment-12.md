# 通常利用 increment 12 — 同一Session内のOpenRouter model/effort切替

ステータス: 完了

## 利用者が必要とする動作

- production TUIの同じHenji Sessionで、idle時に`/model`からroot OpenRouter modelを検索・選択する。
- model選択時はそのmodelのcurated default effortへ移り、`/effort`ではmodelを変えずeffortだけを選択する。
- 選択は次のroot turnから有効で、そのturnの全model stepとtool loop中は固定する。
- delegated plannerはrootの選択を継承せず、固定planner defaultを使う。
- `/sessions`は保存済みSessionのactive model/effortを表示し、resume時にconversationと一緒に正確に復元する。
- model情報のない旧Sessionは現在のroot defaultで再開し、その移行を一度だけ人間へnoticeする。

model/effort選択はDefinition revisionではなくSession runtime overrideである。provider切替、dynamic provider
catalog、planner選択UI、自動retry/fallbackはこのincrementの対象外とする。

OpenRouterの現行[Reasoning Tokens documentation](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens)
は、reasoning contextを複数turnで維持する場合にassistant messageの完全な`reasoning_details` sequenceを変更せず
返すこと、および対応するreasoning model間で同じ構造を使えることを定める。このためHenjiはSSE/JSON responseの
detailsをassistant messageのprovider stateとして保存し、tool continuationと後続turnでそのまま再送する。

## Curated catalog

catalogはrepository-owned TypeScript module `v0/agent/provider/openrouter_model_catalog.ts`に置き、UIはproviderへ
一覧requestを送らず検索する。root defaultとplanner defaultはともに
`deepseek/deepseek-v4-pro-0813` / `high`である。

| model | model選択時のdefault effort | `/effort`の選択肢 |
| --- | --- | --- |
| `qwen/qwen3.8-max-0902` | `xhigh` | `auto`, `xhigh`, `high`, `medium`, `low`, `minimal` |
| `qwen/qwen3.8-flash` | `auto` | `auto` |
| `deepseek/deepseek-v4-pro-0813` | `high` | `auto`, `max`, `high`, `low` |
| `deepseek/deepseek-v4-flash-0731` | `high` | `auto`, `max`, `high`, `low` |
| `openai/gpt-5.6-sol` | `medium` | `auto`, `max`, `xhigh`, `high`, `medium`, `low`, `none` |
| `openai/gpt-5.6-luna` | `medium` | `auto`, `max`, `xhigh`, `high`, `medium`, `low`, `none` |
| `z-ai/glm-5.3` | `max` | `auto`, `max`, `high`, `low` |
| `z-ai/glm-5.3-flash` | `max` | `auto`, `max`, `high`, `low` |
| `google/gemini-3.8-flash` | `medium` | `auto`, `high`, `medium`, `low` |
| `meta/muse-spark-1.3` | `medium` | `auto`, `max`, `xhigh`, `high`, `medium`, `low`, `minimal` |
| `x-ai/grok-4.6` | `high` | `auto`, `xhigh`, `high`, `medium`, `low` |

旧active defaultのGemini 3.7 Flashはcatalogとdefaultから除いた。過去のplan/result文書は当時の実行証拠なので
書き換えない。

## 実装

- OpenRouter requestはexplicit effortを`reasoning.effort`として送る。`auto`はparameterを省略する。
- OpenRouter responseの`reasoning_details`をassistant messageのprovider stateへ保持し、tool continuationの次requestへ
  元の配列順で戻す。conversation表示には出さないが、Sessionとprovider evidenceでは保持する。
- Host / Worker protocolへidle-onlyな`select_model` / `model_selected`を追加した。Workerのstable root model routeを
  選択後のadapterへ置換し、planner routeはplanner defaultのままにする。
- Session schema v3は`activeModel`、`modelChanges`、`turnModels`を保存する。選択自体もdurable commitし、各turnの
  commit proposalには、そのturnで固定されていたselectionをattributionする。
- semantic context checkpointはOpenRouter内のmodel切替で再利用する。`sourceProfileId`はcheckpoint生成元のprovenance
  として変更しない。
- startup orientation、Session picker、Worker manifest、execution artifact、provider request evidenceは実際の
  model/effortを表示または記録する。

## 実装前のprovider probe

利用者が認めたcredentialをrequest時だけ使い、簡単な固定question/tool loopで11 modelを確認した。

- non-stream tool loop: 11/11成功。
- production同型SSE parser: 11/11で有効responseを確認。`qwen/qwen3.8-flash`の一回目の第二requestだけが
  120秒timeoutとなり、挙動確認の即時一回再試行は1.3秒でHTTP 200と`[DONE]`を返したためcatalogに残した。
- usage reportで確認できた費用は約USD 0.0243。timeout requestの費用はprovider responseがなく不明。
- credential値とAuthorizationはprobe output、repository、文書へ保存していない。

一回のtimeoutを理由にproductへ自動retry/fallbackは追加していない。

## 検証

focused testは、catalog/default/search、effort wire、reasoning detailsのJSON/SSE保存とtool continuation、
同一Worker Sessionでの二回のmodel切替、planner default固定、turn attribution、一覧metadata、exact resume、旧v2
Sessionのdefault移行とone-shot notice、model/effort picker操作を確認した。

- Increment 12 focused test: 3 passed。
- Worker foundation: 40 passed。
- 実production経路: isolated state root `/tmp/henji-increment12-live-a0c10d05d8d9990d`で2 external requestを実行。
  turn 1はroot default `deepseek/deepseek-v4-pro-0813` / `high`で`HENJI_ROOT_OK`、同じSessionのturn 2は
  `qwen/qwen3.8-flash` / `auto`へ切り替えて`HENJI_SWITCH_OK`を返した。Session v3とexecution artifactの
  turn attributionは一致し、両artifactのplanner modelはplanner defaultのままだった。
- authoritative `v0:gate`: 2026-09-08 JSTに一回実行し成功。check、format、lint、99 testsが通過した。

実経路のcredential値とAuthorizationはstdout、artifact、repository、本文へ記録していない。
