# 通常利用 increment 8 — Web search grounding

ステータス: **完了（2026-09-27、現行仕様で受入確認）。**

## 利用者が必要とする動作

1. 親agentは、currentまたは外部情報を調べるとき、bare keywordやBoolean列ではなく、必要な情報を示す
   具体的なquestionを`web_search`へ渡す。
2. Sonarはsearch resultで裏付けられた内容だけを回答し、答えが見つからない場合や近いが一致しない結果しか
   ない場合は、その不足または不一致を明示する。
3. 親agentは、tool resultにない主張を確認済み事実として補わず、使用したsource URLを最終回答の対応する
   主張の近くへ示す。推論を加える場合は推論と明記する。
4. increment 7で成立したHenji-owned tool、交換可能backend、main → Sonar → main、citation順、request count、
   evidence、cancellation、credential非記録を維持する。

## 根拠

- Session `59a37c41-5f6d-4607-a700-39be01f857cd`のproduction利用では、二turnで`web_search`を7回実行し、
  mainとSonarの交互実行、全HTTP 200、140件のannotation、回答継続を確認した。
- 一方、追質問への最終回答はsource URLを表示せず、Sonarが公式なDeno 3 roadmapを確認できないと返した後も、
  親modelが将来topicを確認済みのように断定した。mechanismは成立したが、groundingは利用者の目的を満たさなかった。
- [Perplexity公式Prompt Guide](https://docs.perplexity.ai/docs/sonar/prompt-guide)は、Sonarのsearch retrievalを
  user messageだけが形成し、system messageは検索後の回答規律へ効くと説明する。具体的なquestionをuser
  messageへ置き、system messageではsearch resultだけで答え、不足またはnear missを明示することを推奨している。
- [Perplexity公式Search Filters](https://docs.perplexity.ai/docs/sonar/filters)は、`low`をcost-efficientなdefault、
  `medium`をgeneral query向けの中間設定、
  `high`を詳細調査向けとする。初期production利用では調査taskに`low`を使っていたため、Henjiの通常検索を
  `medium`へ変更する。

## 実装範囲

- `v0/agent/tools/web_search.ts`
  - Sonar requestへgrounding用system messageを追加する。
  - modelが生成したqueryは書き換えず、具体的なquestionとしてuser messageへそのまま渡す。
  - `web_search_options.search_context_size`を`medium`へ変更する。
  - active tool guidelineへ、具体的question、source URL、検索結果不足、推論表示の規律を追加する。
- 既存のfocused suiteで、Sonar request bodyとdefault parentだけへのguideline合成を確認する。
- architecture、roadmap、normal-use inbox、increment result、handoffを現在形へ更新する。

## 対象外

- 親modelまたはSonar modelの変更。
- `web_open`、page fetch、search filter、tool input schemaの追加。
- OpenRouter `openrouter:web_search` server tool、別backend、retry、fallback、query自動書換え、検索回数制限。
- directory再編、未参照fileの移動または削除。increment 8のproduction受入後に、entrypoint、dynamic load、task、
  public exportを含む参照調査から別計画を作る。

## 検証

- focused: Sonar requestがgrounding system message、exact user query、`medium`を持つ。
- focused: default parentのsystem instructionに新しいtool guidelineが一回だけ入り、plannerには入らない。
- regression: main → Sonar → main、ordered citation、raw evidence、request accounting、error、budget、cancelを維持する。
- stable candidateのreview後、authoritative offline `v0:gate`をcoordinating ownerが一回実行する。
- production human gateは別の明示承認後、新しいWorker generationで曖昧な調査taskを一回実行し、具体的query、
  source URL、不足と推論の区別、実測usage・costを確認する。


## 現行状態の完了整理（2026-09-27）

9・69を反映したB04-Sで、具体的な調査質問、Sonar結果を使う親の回答と直接source
linkを確認した。旧裸番号citationは9で置換済み。
根拠は[配置binary・実provider E2E](e2e-001-132-2026-09-27.md)と、利用者のincrement文書を完了へ整理する指示。
当時の未実施・未確認の記録は履歴として保持し、現在の完了状態とは区別する。
