# Increment 37 — 外部情報調査のtool・source選択instruction

ステータス: **完了（Human Gate実施・context課題を分離）**

基準commit: `d570ace0`（Increment 34・35の未commit変更がworking treeにある）

対象機能: F02、F06（将来のF24候補の観測入力）

## 利用者が必要とする動作

- 現在または外部の情報を求めるtaskで、対象identityやcanonical sourceがまだ確立していなければ、
  workspace全体の探索や推測したURLへの`curl`より先に`web_search`をsource発見に使う。
- ユーザーがcurrent repository、local file、または直接のcanonical URL/APIを指定した場合は、その明示sourceを
  先に使い、必要のないsearchを追加しない。
- 外部sourceだけで完遂できるtaskでは、software engineering workspaceが存在するという理由だけで`pwd`、
  repository、sibling repository、handoffを調査しない。
- `web_search`でidentity/canonical sourceを発見した後、変化の速い一覧や正確な現在値には、発見した
  直接の公式source/APIを使う。search resultを自動的な最終正本とは扱わない。
- 独立したread-only取得は、意味が判別できる別tool callとして同じmodel stepにまとめる。一方の結果が
  次の対象・query・fallbackを決める場合は順次行う。

## 根拠と確認済みの現在地

- 通常利用で「giteaの直近10件のPR」を求めたとき、modelは対象identityとcanonical sourceを確立する前に
  workspace、sibling repository、handoff、通常利用メモを探索し、複数のHTTP endpointを試行した。
  `web_search`は14番目のtool callで初めて使われた。
- その最終回答は、対象を`go-gitea/gitea`と解釈し、取得時刻と並び順を示した上で、古い
  search resultより新しいGitHub公式API snapshotを優先しており、回答側のsource判断は適切だった。
- 現行Henji共通instructionは、既存sourceで現在・外部の問いが未解決なら`web_search`を使うよう求める。
  `web_search`のactive guidelineも現在・外部情報への利用を求めるが、外部対象の発見時にlocal探索や
  推測URLより先に使う優先規則はない。
- `read`のline windowとactive guidelineはIncrement 4、`bash`全出力readbackはIncrement 5、取得済みresultの再利用と
  調査終了はIncrement 23、bash workspace開始directoryはIncrement 25で実装済みである。これらは変更しない。
- 変更対象はmodel向けinstructionであり、external serviceのAPI・response contractは変えない。そのため、
  新しい外部仕様の推測は必要ない。

## 実際のproduct経路

```text
web_search Tool.promptGuidelines
  → Registry.promptGuidelines()
  → instruction:active-tool-guidelines
  → built-in default AgentComposition
  → Worker model request
  → OpenRouter system message / OpenAI Responses instructions
```

`web_search`を持つbuilt-in default rootだけがtool固有guidelineを受ける。plannerは`web_search`を持たないため、
このguidelineを合成しない。Henjiはmodelが返したtool callsを既存loopで実行し、同じmodel stepの複数callも
個別のcall/resultとして記録する。本Incrementはこの実行機構を変えない。

## Product contract

- `web_search` active guidelineの先頭でtask sourceを選択する。直接指定されたlocal/canonical sourceと、
  identity未確立の外部taskを区別する。
- identity未確立の外部taskでは、`web_search`を最初のsource-discovery toolにする。workspaceの存在だけを
  理由にlocal探索せず、発見前に`bash`/`curl`でendpointを推測しない。
- 直接のlocal source、会話内で確立済みのcanonical source、ユーザー指定URL/APIがある場合は、それを
  優先する。searchを必須の前処理にしない。
- searchはidentityとcanonical sourceの発見に使える。発見後の正確な現在値は直接のcanonical sourceから取得し、
  search resultと不一致なら取得時刻と不一致を明示する。
- 独立したread-only callは同じmodel stepへまとめるよう促すが、result依存のcall、source discovery後の
  canonical fetch、failure後のfallbackは順次に行う。Hostはcallの並べ替え、並列化、禁止をしない。
- 現行のqueryの具体性、inline source link、未解決・推論の明示、取得済みresult再利用、credential許可境界は維持する。
- これはmodel判断を改善するinstructionであり、未知語、local tool、`curl`、複数tool callを機械的に拒否する
  routerやruntime policyは追加しない。

## 実装slice

### Slice A — Instructionとdeterministic verification

1. `v0/agent/tools/web_search.ts`のactive guidelineを、task-source選択、identity未確立時のsearch-first、
   external-only taskのlocal非探索、canonical current sourceへの後続、独立/依存callの区別を含む内容へ更新する。
2. 既存のquery/citation/grounding規律を保ち、tool description、schema、backend、Registry、agent loop、providerは変更しない。
3. guidelineの意味要素、defaultへの一回だけの合成、plannerへの非混入、Worker/directと両provider wireの既存同一性を
   focused testで確認する。offline fixtureはinstruction配送を確認し、確率的なmodelのtool選択成功の代替にしない。
4. focused test、`v0:check`、`v0:fmt`、`v0:lint`、`git diff --check`を実行する。stable candidateで
   authoritative `v0:gate`を一回だけ実行し、Slice Aの区切りで停止する。

### Slice B — Production tool-selection Human Gate

1. 新しいWorker generationのproduction retained TUIで、local targetを指定しない「Giteaの直近10件のPR」taskを一回実行する。
2. tool traceと最終回答から、最初のsource discoveryが`web_search`であり、それより前にworkspace、sibling、handoff、
   推測endpointを探索していないことを確認する。
3. 対象identityを明示し、変化の速いPR一覧は発見した公式のcanonical source/APIから取得し、取得時刻、
   並び順、対応する直接linkとともに回答することを確認する。
4. 必要な取得を省いていないか、不要なlocal探索が減ったかを利用者が判断する。modelが必ず同じ
   tool sequenceを返すことや固定call数は合格条件にしない。

利用者の指定に従い、各sliceの完了時に停止する。

## Slice checkpoint

### Slice A — 完了（2026-09-12）

- `web_search` active guidelineを、最初にtask sourceを選ぶ構成へ更新した。明示されたlocal file・
  current repository・canonical URL/APIは直接使い、identity/canonical source未確立の外部・現在情報taskは
  `web_search`を最初のsource-discovery toolにする。external-only taskではworkspaceの存在だけを理由に
  repository、sibling、handoff、推測endpointを調べない。
- discovery後の変化の速い一覧・正確な現在値は直接のcanonical sourceから取得し、取得時刻または
  search resultとの不一致を示すようにした。独立したread-only取得は同じmodel step、result依存の
  取得とfallbackは順次とする区別も追加した。
- 既存の具体的query、inline source link、未解決と推論の明示はそのまま維持した。tool description、
  schema、backend、Registry、agent loop、provider、planner構成は変更していない。
- focused確認は`current_code_test.ts` 15件、Increment 16 instruction component 4件、Increment 7 web search 5件が
  成功した。新規律がdefaultへ一回合成され、plannerへ入らず、Worker/directと両provider wireの既存同一性を
  維持することをdeterministicに確認した。
- `v0:check`、`v0:fmt`、`v0:lint`、`git diff --check`が成功した。stable candidateのauthoritative `v0:gate`は
  計画どおり一回だけ実行し、全176 testが成功した。
- offline fixtureはmodelの確率的なtool選択を証明しない。production retained TUIの一回の実調査と利用者判断は
  Slice Bに残し、本checkpointで停止した。

### Slice B — Human Gate未達（2026-09-12）

- current sourceのproduction retained TUIを隔離したXDG rootで起動し、新規Session
  `4e622da1-b770-450c-b3cc-a399707b193b`から、local targetを指定しない「Giteaの直近10件のPR」taskを
  OpenRouter `deepseek/deepseek-v4.1-flash`へ一回実行した。turnは7 model step、10 tool call、7 provider
  requestで正常完了し、全provider responseはHTTP 200だった。
- 最初のtool callは`web_search`ではなく`bash`であり、current workspaceのGit remote、Git config、directoryを
  調べた。続いて`bash`でhandoffを読み、workspace remoteから得たForgejo hostのAPI endpointを推測して
  `curl`した。全10 callが`bash`で、`web_search`は0 callだった。このため、最初のsource discoveryと
  external-only taskのlocal非探索というHuman Gateを満たさない。
- provider evidenceをreadbackし、新しいsource-selection guidelineとcredential境界が最初のsystem messageへ
  配送され、同じrequestで`web_search` toolも利用可能だったことを確認した。未配送やtool欠落ではなく、modelが
  ambient workspaceを対象identity確立の入口として選んだ結果である。
- 最終回答自体は、対象を`forge.harakara.site`のpublic identity `littleisland`と明示し、公式Forgejo APIから
  取得時刻、`sort=recentupdate`、直接linkを伴う8件のPRを示した。ただしユーザーがlocal targetを指定していない
  taskをcurrent remoteへ結び付けたため、期待した対象発見経路ではない。
- credential値とAuthorizationの露出はなかった。一方で、credentialを求められていないのに`~/.config`の名前と
  environment variable名を調べており、配送済みのcredential境界にも従っていない。
- 証拠は`/tmp/henji-increment-37-acceptance-b3kQMl`に保持している。Session、Worker execution、provider evidenceは
  それぞれ`session.json`、`worker-executions/9e3a2d72-181e-41ec-84ab-d95ae1b03604.json`、
  `provider-evidence/014be4f7-215a-46f5-b102-5c82d8b7d662.json`からreadbackできる。
- 現行instructionだけでは選択したmodel/taskでproduct動作を成立させられない実証となったため、停止条件に従って
  追加変更を行わず停止した。最小の次案は、ambient working directoryやGit remoteはユーザーが指定した
  current repositoryとは見なさないことを明文化し、長いactive guidelineをsource-selectionと取得・groundingの
  複数ruleへ分けてsalienceを上げた上で、production Human Gateをもう一回だけ行うinstruction-onlyの補正sliceである。
  Host routing、tool contract、providerの変更は引き続き対象外とする。

## 完了判断（2026-09-12）

- 利用者は、Slice Bで観測したlocal探索を`web_search` guidelineだけの問題として補正せず、repository contextの
  与え方として別途検討すると判断し、本Incrementを完了とした。
- Slice BのHuman Gateが当初期待したtool sequenceを満たしたことにはしない。Slice Aのinstruction変更と
  deterministic verification、Slice Bのproduction実行・証拠readbackまでを本Incrementの成果とし、観測した未達を
  そのまま結果として保持する。
- ambient repository identityとtask targetの区別をmodelへどう配送するかは、本Incrementの追加sliceにはせず、
  `docs/experience/normal-use-inbox.md`の未採用候補へ分離した。

## 当初の完了条件

- identity未確立の外部・現在情報taskでは`web_search`がsource discoveryに先行し、外部だけで完遂できるなら
  無関係なlocal workspaceを探索しない。
- 明示的なlocal/canonical sourceを指定されたtaskはそのsourceを優先し、`web_search`を無条件の必須前処理にしない。
- 発見用searchと、変化の速い値のcanonical source取得を区別し、sourceと取得時点を最終回答で読める。
- 独立したread-only取得と、結果依存の取得/fallbackを区別できる。
- guidelineがactive `web_search`を持つdefaultへ一回だけ合成され、planner、tool schema、backend、Host/Worker protocol、
  provider adapterは変わらない。
- deterministic verification、一回のauthoritative `v0:gate`、production retained TUI Human Gateが完了する。

## 対象外

- Host/Registryによるtool callの強制routing、禁止、書換え、重複検出、cache、自動retry、fallback。
- `search`/`fetch`の分離、`web_open`、新tool、HTTP client、並列tool executor、tool schema/resultの変更。
- model別prompt、provider/model/effort、step/request/tool call上限、Sonar backend、search context size、citation formatterの変更。
- credential許可境界の変更、task対象の認証済みservice利用、credential内容の確認。
- 一般的なinstruction外部化、self-revision candidate生成・採用、architecture、roadmapの変更。
- installed binary置換、commit、push、tag、publish、release。

## Human Gateと停止条件

- この初期計画に対する利用者の明示承認前は、code、test、build taskを変更しない。
- 利用者は2026-09-12に初期計画を承認した。
- 承認後はSlice Aを実装・検証して停止する。Slice Bのlive provider実行は、Slice Aの結果報告後の
  利用者の続行指示を待つ。
- instructionだけで上記動作を改善できない実証、またはHost routing、tool contract、provider、外部API、
  architecture、roadmap、受入水準の変更が必要となった場合は、実装を止めて観測結果と代案を利用者へ返す。
