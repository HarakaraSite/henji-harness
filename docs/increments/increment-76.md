# Increment 76 — 保存Sessionの閲覧と現行Definitionでの継続

ステータス: **実装完了（Human Gate承認済み。roadmap／architecture変更適用済み）**

基準commit: `093a14be`

計画日: 2026-09-18

Human Gate承認: 2026-09-18。設計（閲覧＝Worker 0個・ref照合なし、継続＝現行Definition・切替記録）を承認。
roadmap F18とarchitecture該当節の文面を適用済み。lazy activationを本incrementに含める。digest範囲変更は
別increment提案として扱う。

対象: 通常利用メモB4。`/sessions`は一覧できるが、保存Sessionを開くと
`session resume failed; current session unchanged`となり、canonical履歴を通常利用で参照・継続できない。
原因は「履歴閲覧」と「Worker起動による継続」が同一の入口（`WorkerHostSession.open`）に混ざり、その先頭で
保存Definition refと現行refのexact一致を要求していること。

## 利用者が必要とする動作

- 保存Sessionを開いて、canonical/non-canonical履歴を閲覧できる（Workerを起動しない）。
- 保存Sessionを現行Definitionで継続でき、次のturnを生成できる。切替は記録され、過去turnのattributionは
  変わらない。
- 上記はproduction TUIの実経路で確認できる。
- Henji binaryを更新しても、過去Sessionの閲覧・継続が不能にならない。

## 原因（evidence）

- `worker_tui_session.ts`の`switchTo`は`store.openExistingWorker`→`openHost`→`WorkerHostSession.open`を呼ぶ。
  `WorkerHostSession`のコンストラクタが`record.definition`と選択`definition`の`sameRef`を要求し、不一致で失敗する
  （`v0/agent/worker/worker_host_session.ts:244-253`）。
- 保存Sessionの`builtin/default` digestはbuildごとに異なる。digestは
  `{resourceId, role, apiContract, embeddedRuntimeSha256}`のSHA-256で（`managed_resource_ref.ts:57-75`）、
  `embeddedRuntimeSha256`はbinary同梱ランタイム全体のハッシュ（`build_henji.ts:47-81`）。TUIやstorageの修正でも
  変わる。
- `SessionNavigationHost.switchTo`はliveな`session`を返す契約で、「閲覧のみ」の経路が無い
  （`session_navigation.ts:78-82`）。`/history`（F05）は現在Session限定。
- storeには`readWorker(id)`（recordのみ、Worker非起動）がある（`sqlite_history_store.ts:3347`）が、pickerに
  接続されていない。
- architectureのadmission invariant（`henji-host-agent-worker.md:583-589`）はlive generation/commitの条件で
  あり、過去履歴の閲覧とは無関係。これが入口条件へ流用されている点が欠陥。

## 採用する設計（承認済み）

実装量ではなく、素直さ・整合性・追跡可能性を優先する。操作を契約レベルで分離し、generation 0個を第一級に
扱い、切替を明示的に記録する。

1. **操作を契約で分離する**
   - `view_session`（保存transcript/履歴を返すだけ。Workerを起動せず、Definition refを解決・照合しない）と
     `continue_session`（現行Definitionでgenerationを起動）を、navigation契約・presentation intent・
     controller・hostで別操作にする。pickerは両方を明示的に提供し、閲覧と継続を暗黙に同一化しない。
2. **generation 0個を第一級にする（lazy activationを素直に）**
   - `WorkerHostSession`を「open＝未起動」「最初のsubmit＝起動」に分割する。`open`はWorkerを起動しない。
     表示に必要な情報はrecordと解決済みDefinitionから組み立て、Worker起動後に確定値で置き換える。
     proxyで継続経路を隠さず、0個/1個generationの状態を型とフローに出す。
3. **切替を明示的に記録する（追跡可能性）**
   - modelの`session_model_changes`と対称に、Definition切替のdurable record
     （effectiveFromTurn、changedAt、from ref、to ref）を追加し、readbackとSurface表示を作る。
   - 過去turnの`turnExecutions` attributionは不変。切替は「いつ・何から・何へ」を後から追える形にする。
   - 同一revisionの再開（restart）はtransition recordを作らない。refが変わるときだけ記録する。
4. **不変条件を正しい位置に置く**
   - open時のref一致要求を削除する。admission（lock＋base state revision＋generation identity）はlive
     generationにだけ適用し、そのgenerationのDefinition refはsessionの**現行binding**と一致することを検証する。
   - builtin/externalで扱いを分けない。externalは現行binding（人間がactivateしたrevision）で継続し、
     builtinは現行bundled revisionで継続する。どちらも切替として記録する。
5. **維持するもの**: managed resource load時のcontent digest検証、turnごとのbuild/Definition attribution、
   live generationのadmission。

### digest範囲の扱い（別項目）

builtin Definitionのdigestがランタイム全体のハッシュに依存するため、無関係な修正でも全Sessionのrefが変わる。
design 1〜4でこれは障害にならなくなるが、恒久的には「Definitionのclosure内容とcontract」を識別する値に
直すのが妥当（externalの`canonicalDefinitionRevisionBytes`と同じ形）。revision identityの意味を変えるため、
別incrementで提案する。本incrementには含めない。

## 正本変更（適用済み、2026-09-18）

利用者承認に基づき、次の文面を適用した（詳細な差分案は本incrementの計画時に提示済み）。

- `docs/roadmap.md`: durable AgentInstanceとrevision transition節の冒頭を、F16/F17は後続、保存Sessionの
  閲覧と現行Definitionでの継続は通常利用に必要（Increment 76）として更新。F18を**部分実装**へ更新。
- `docs/architecture/henji-host-agent-worker.md`: 閲覧はgeneration/admissionの対象外でref照合不要、継続は
  保存ref一致を要求せず明示的durable transitionとして記録、保存refが現行binaryに無い場合は現行bindingで
  継続、を追記。
- digest範囲変更は本incrementに含めない（別increment提案）。

### 実装計画

素直さ・整合性・追跡可能性を優先し、次の順で実装する。

1. **contract/stateの整理**
   - navigation契約に`view_session`（read-only、Worker非起動）を追加し、既存`switchTo`/`resume_session`を
     `continue_session`として現行Definition継続の意味に整理する（保存ref一致要求を削除）。
   - presentation intentとcontrollerに閲覧と継続を分けて配線する。
2. **hostのlazy化**
   - `WorkerHostSession`をopen（未起動）と`ensureStarted`（最初のsubmit）に分割する。open時のref一致
     チェックを削除する。未起動時の表示情報はrecord＋解決済みDefinitionから構築し、起動後に置換する。
3. **切替record**
   - Definition切替のdurable record（effectiveFromTurn、changedAt、from ref、to ref）をsession storeへ追加し、
     commit時にrefが変わった場合だけ記録する。readback（session CLI/inspect）とSurface表示を用意する。
4. **admissionの再配置**
   - 既存のadmission（lock＋base state revision＋generation identity）に、generationのrefがsessionの
     現行bindingと一致する検証を加える。閲覧経路はadmissionを通らない。
5. **testと検証**
   - focused test: 閲覧でWorker 0個、継続で切替recordが残る、restartではrecordを作らない、過去
     `turnExecutions`不変、admissionが不正generationを拒否する。
   - production TUI（tmux、隔離XDG）: `/sessions`から閲覧、続行、切替のreadback/表示。
6. digest範囲変更は別increment。

## 対象外

- digest範囲の変更実装（別increment）。
- durable AgentInstance identity、Instance単位writer ownership（F16/F17）。
- candidate生成・採用（F19〜F22）。
- 非canonical executionの閲覧拡張の新機能（既存`/history`の範囲を超えるもの）。
- 過去recordのmigration、互換read、旧形式converter。

## Verification

- focused test:
  - 保存refが現行と異なるSessionを閲覧すると、transcript/historyが表示され、Workerが起動しないこと
    （generation 0個）。
  - そのSessionを継続すると、新turnが現行Definitionで実行され、Definition切替record（from/to/effectiveFromTurn/
    changedAt）が追加され、sessionの現行bindingが更新され、過去turnの`turnExecutions`が変わらないこと。
  - 同じrevisionでの再開（restart）では切替recordを追加しないこと。
  - live generationのadmission（base state revision不一致、または現行bindingと異なるrefのgenerationのcommit拒否）
    が維持されること。
  - 切替recordのreadback（session CLI/inspect）とSurface表示。
- production TUI（tmux、隔離XDG）: `/sessions`から過去Sessionの閲覧（Worker 0個）、続行、切替recordの表示、
  binary更新後も閲覧・継続できること。
- type check、format、lint、`git diff --check`。authoritative `v0:gate`は安定候補で1回。

## 規模見積り

閲覧経路、継続経路、hostのlazy化、切替record、admission再配置、test、TUI検証で**6〜10開発日相当**。
digest範囲変更は別途。

## Human Gate

- 承認（2026-09-18）: 「閲覧（Worker 0個・ref照合なし）」と「継続（現行Definition・切替記録）」の分離、
  roadmap/architecture変更、lazy activationを本incrementに含めること、digest範囲変更を別incrementとすること。
- 実装は素直さ・整合性・追跡可能性を優先する（実装量を理由に近道しない）。
- digest範囲変更を別incrementとして提案する際は、改めて用途と差分を提示する。

## 実装状況（2026-09-18、途中）

実装済み（継続経路と追跡）:

- `worker_host_session.ts`: open時の保存Definition ref一致要求を削除。workspace/agentのbinding一致検証は残す。
  継続時のgenerationは現行解決済みDefinitionで起動する。
- `worker_tui_session.ts`: `bindRecord`は保存refを解決せず、現行selectionで継続する（agent roleのみ検証）。
  `--continue`の候補探索はagent一致（最新Session）。`--session`/`switchTo`の保存ref一致要求を削除。
- `layout.ts`: pickerの`mismatch`ラベルを`unavailable`から`revision change`へ（継続可能であることを表示）。
- 切替の追跡: 新規schemaは追加しない。既存の`turnExecutions`（turnごとのdefinition）と`canonical_turns`の
  `definition_json`が単一authorityとして「いつ・何から・何へ」を保持し、`session.definition`が現行bindingを
  持つ。`session_model_changes`との対称で別recordを追加すると二重authorityになり、また既存v6 recordの検証を
  壊すため、既存durable dataからの導出を採用した。
- 検証（実経路、source TUI、tmux、実state DB）:
  - 過去buildのSession `375ca4e7`（保存digest `cc214791…`）を`/sessions`から開くと、`resume failed`なく
    履歴が復元された。
  - そのSessionでturnを生成すると、`session.definition`が現行digest `e28fe12a…`へ更新され、
    turn 1〜2が`cc214791…`、turn 3が`e28fe12a…`として`canonical_turns`に残った。過去turnのattributionは不変。
- focused test: `tests/v0/increment_76_definition_transition_test.ts`（2件、`v0:test`へ追加）。保存refと異なる
  現行Definitionでのopenが成功し、workspace/agent不一致は引き続き拒否されることを確認。
- `v0:check`/`fmt`/`lint`と影響範囲のtest（TUI群、increment-40）はpass。authoritative `v0:gate`は
  安定候補で1回 exit 0。

実装済み（閲覧経路）:

- 閲覧経路（read-only、Worker 0個、ref照合なし）を実装した。pickerで`v`を押すと、選択Sessionの
  human historyをread-only overlayとして開く。`human_history_open/page/detail/search` intentにoptional
  `sessionId`を追加し、adapterが `admitted.sessionId ?? currentPosition.sessionId` を読む。active sessionの
  bindingは変えず、Workerも起動しない。`controller_overlay`の`viewSession`から`controller.startHumanHistory(id)`
  を呼ぶ。`layout.ts`のpickerに`v view history`を表示。
- 検証: focused test `tests/v0/tui_controller_overlay_test.ts`（`v`で`viewSession`が選択idで呼ばれ、resume
  しないこと）。実経路（source TUI/tmux）で、`/sessions`→`v`が選択Sessionの履歴overlayを開き、footerの
  active sessionが不変のままであることを確認。installed binary（再build・配置済み）でも`/sessions`→`v`の
  閲覧と、過去Sessionのresume（`resume failed`なし、active sessionが選択Sessionへ切替）を確認。
- 既存testの契約更新: `increment_33_managed_definition_test.ts`の「保存exact refでのreopen」を新契約
  （現行選択Definitionでreopenし、明示selectionはそのrevisionを評価する）へ更新。
- lazy activation: pickerで保存Sessionを選ぶと、`worker_tui_session.ts`の`LazyWorkerSession`（`TuiActiveSession`
  実装）としてactive sessionになる。recordとhandleを持ち、Worker generationは0個。transcript/position/model/
  historyはrecordから返す。submit・model選択・recall・rename等のlive操作で初めて`openHost`を呼び、現行Definitionで
  generationを起動する。`navigation.switchTo`が`LazyWorkerSession`を返し、`currentHost`は`TuiActiveSession`型に
  なる（`WorkerHostSession`は同interfaceを満たす）。startupの`--session`/`--continue`と`createNew`はeagerのまま。
- 検証（lazy）: focused test `tests/v0/increment_76_definition_transition_test.ts`の
  「opens a stored session lazily and starts the Worker on first submit」で、`capsuleFactory`呼出回数が
  switch時は増えず（Worker 0個）、最初のsubmitで増えることを確認。実経路（source TUI/tmux）で、picker選択で
  active sessionが保存Sessionへ切り替わりtranscriptが復元され、submitでturnがcommitされることを確認。
- 閲覧overlay（`v`）はlazyとは別に、active bindingを変えないread-only閲覧として残す。

注記: digest範囲変更（builtin Definition digestをランタイム全体からDefinition closure内容へ）は別increment。
