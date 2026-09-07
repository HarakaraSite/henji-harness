# 通常利用 increment 9 — Web search citation links

ステータス: local実装、focused verification、コード／テストreview、authoritative offline gate完了。
production retained TUI human gateとユーザー受入は未実施。

## 利用者が必要とする動作

1. `web_search`のmodel-visible resultは、Sonar answerの`[n]`を対応するsource titleと直接URLを持つinline
   Markdown linkへ変換し、検索内だけで意味を持つ番号を親modelへ裸で渡さない。
2. source一覧も番号を参照せず、それぞれのtitleと直接URLだけで理解できる形式にする。
3. 親modelはinline source linkを対応する主張の近くへ使い、provider-localな`[n]`をfinalへ転載せず、
   検索結果にない具体的事実を追加しない。
4. provider raw response、annotation、parser transition、request count、usage、cost、cancelを診断可能な形で維持する。

## 根拠

- production Session `0aa262b8-724e-462c-9340-249703627b36`では、Sonar raw responseのanswerが`[n]`を使い、
  `message.annotations`が同じ順序のtitleとURLを持っていた。現行formatterはそのannotationを番号付きsource一覧へ
  変換するが、親modelはfinalへ`[8][31]`だけを転載し、利用者は対応URLを判別できなかった。
- 同じSessionでは検索を複数回実行しており、それぞれのtool resultで番号が1から振り直される。このため、番号を
  conversation全体のsource identityとして使うことはできない。
- 親finalはSonarが裏付けていない具体的予測も追加したため、直接linkの利用と、返された資料にない事実を
  追加しない規律を一緒に明示する。

## 実装範囲

- provider-neutralな`WebSearchResult.answer`の有効な`[n]`を、同じresultの`sources[n - 1]`を使う
  `[source title](<URL>)`へtool component内で正規化する。隣接する参照は空白で分ける。
- source一覧を番号なしのMarkdown link一覧にする。
- `web_search` descriptionとactive guidelineを現在のmodel-visible contractへ合わせる。
- 実際に観測した隣接・順不同の`[2][1]`をfocused testで固定し、直接URL、source順、raw evidenceの維持を確認する。

## 対象外

- 親model、Sonar model、search context size、backend、tool input schemaの変更。
- `web_open`、filter、retry、fallback、query書換え、検索回数制限。
- Web searchをmodel内包機能として維持するか、専用`AgentDefinition`へするかの決定。論点は
  `docs/experience/normal-use-inbox.md`へ記録し、具体的なagent化の必要性が観測された時点で比較する。
- directory再編と未参照fileの移動・削除。

## 検証

- focused web search suiteとactive guideline compositionを確認する。
- `v0:check`、format、lint、`git diff --check`を実行する。
- stable candidateのコード／テストreview後、authoritative offline `v0:gate`を一回だけ実行する。
- production human gateは別の明示承認後、新しいWorker generationで同じ二turnを実行し、finalに裸の`[n]`が
  なく直接URLがあること、検索結果にない具体的事実を加えないこと、実測usage・costを確認する。
