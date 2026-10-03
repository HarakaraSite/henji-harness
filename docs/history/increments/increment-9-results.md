# 通常利用 increment 9 — 実装結果

ステータス: local実装、focused verification、コード／テストreview、authoritative offline gate、
production retained TUI human gate、ユーザー受入完了。

## 成立した動作

- model-visibleな`web_search` resultは、Sonar answer内の有効な`[n]`を同じresponseの
  `message.annotations[n - 1].url_citation`に対応する`[source title](<URL>)`へ変換する。隣接・順不同の
  `[2][1]`も、直接URLを持つ二つのlinkとして読み取れる。
- source一覧も番号を使わず、titleと直接URLを持つMarkdown linkの順序付き一覧として返す。複数のsearchで
  それぞれ番号が1から始まっても、親modelへconversation-globalに見える裸の番号を渡さない。
- active guidelineは、親modelへinline source linkを対応する主張の近くで使い、provider-localな`[n]`を
  finalへ転載せず、返された資料が裏付けない具体的事実を追加しないよう求める。
- provider raw responseとannotationは正規化前のままevidenceへ保存する。model、backend、tool input schema、
  request budget/count、cancel、parser transitionは変更していない。
- Web searchをmodel内包機能とするか専用`AgentDefinition`とするかは決定せず、設計論点として
  `docs/experience/normal-use-inbox.md`へ記録した。

## 検証

- web search focused suite: 5 passed、0 failed。main → Sonar → main、隣接・順不同citationの直接link化、番号なし
  source一覧、source順、未加工raw evidence、error、budget exhaustion、cancellationを確認した。
- Definition/current-code focused suite: 14 passed、0 failed。新guidelineが`web_search`を持つdefault parentだけへ
  一回合成され、plannerと空Registryへ入らないことを確認した。
- `v0:check`、format 112 files、lint 109 files、`git diff --check`: 成功。
- stable candidateへauthoritative offline `v0:gate`を一回実行し、通常57、provider compatibility 10、filesystem
  6、bash output 11、web search 5の合計89 testsが成功した。
- focused verificationとoffline gateはprovider-free responseだけを使い、credentialを読まず、新しいprovider
  requestを行っていない。

## コード／テストreview

- Session `0aa262b8-724e-462c-9340-249703627b36`の実response、承認済みproduct動作、formatter、active
  guideline composition、focused testを照合した。
- 正規化はtool result作成時だけにあり、`WebSearchResult`、backend seam、provider parser、evidence、tool schema、
  model、context size、request accountingを変えていない。
- 既知のsourceへ対応するmarkerだけを直接linkへ変え、provider response自体を事実検証済みへ格上げしない。
  productionで親modelがlinkを正しく使い、未裏付けの事実を追加しないことはhuman gateで確認する。
- 未解決Blocker/P1/P2は0。

## Production human gate

2026-09-08、code変更後のWorker generation `8f35a761-fbdc-4f0d-82f6-d0a1ab97e7b2`、Session
`dd984286-a8bb-41ae-b177-b0e49f30d150`で、increment 8と同じ二turnと、予測根拠をURL付きで求める三turn目を
production retained TUIから実行した。

- 四回の`web_search` tool resultはSonarのlocal citationをすべてtitle付き直接linkへ変換し、親finalにも裸の
  provider-local `[n]`はなかった。一turn目は公式Deno 3 roadmapが未公開であることを公式URLとともに回答した。
- 二turn目は、公式情報がないことを前置きし、追加内容を確認済み仕様ではなくDeno 2.xの傾向からの推測として
  表示した。三turn目は八つの固有URLを予測領域ごとに示し、根拠が弱かったWasm GC、V8 snapshot、cold start
  等の具体論を落とした。URLはDeno 3仕様そのものではなく予測に至る過去の傾向を支えるものとして扱った。
- 三turnのprovider requestは5 + 5 + 1の合計11、すべてHTTP 200。Sonar四回は1,467 tokens、$0.03347、mainを
  含む合計は36,791 tokens、$0.065888075、各turnの所要時間は約17.9秒、24.6秒、8.8秒だった。readbackでは
  追加provider requestを行っていない。
- Geminiが根拠不足時にも妥当そうな予測を補完する傾向は残るが、推測表示と利用者の根拠確認に応答できることを
  確認し、利用者はこの通常利用結果を受け入れてWeb searchを完成と判断した。
