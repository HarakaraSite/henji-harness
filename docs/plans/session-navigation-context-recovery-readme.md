# Session navigation, explicit context recovery, and user-facing README plan

## Decision summary

**GO、初期implementation Human Gate待ち。**

Roadmap Step 83を一つのgateとして、必ず次の順で実装する。

1. **83a**: TUI内session picker、latest-only resume、current position、bounded read-only canonical history
2. **83b**: 本人確認付きmanual semantic compactionと、一つだけ永続するderived context checkpoint
3. **83c**: root READMEの利用者主導線への再構成とREADME-driven provider-free確認

過去turnからの継続、branch/fork/edit、automatic compaction、summary chain、Step 84の日常利用判定は追加しない。
各sliceは独立したfocused evidenceを持ち、83aがgreenになる前に83b、83bのinteraction/failure contractが
確定する前に83cへ進まない。実装、test、review、results/lifecycle更新は、この計画への別のHuman Gateまで
開始しない。

## Authority and verified baseline

正本:

- canonical input: `/tmp/planner-inputs/henji-session-navigation-context-recovery-readme.md`
- concept revision 35 / Roadmap Step 83
- input SHA-256: `e123e31f2008e05c15c6393eb8127a2550cfbedce4305b71c69f62885c2c04a0`
- verified HEAD: `d00b512978f68add58a29460010b4ffc38897b3f`
- repository `AGENTS.md`、`.handoff/handoff.md`、live source/tests/tasks/docs

確認済みbaseline:

- tracked treeはcleanで、既存untracked `_refs/*`だけがある。これらはuser-ownedとして変更しない。
- Step 82はauthoritative offline gate 624/624、review GO、Blocker/P1/P2 0でcommit済み。後続の
  provider-free representative acceptanceも本人判断でacceptedだが、repo内results/AGENTS/handoffは
  その前のsnapshotである。この計画では過去lifecycle記録を遡及更新しない。
- `session_store.ts`はworkspace digest partition、schema-v1 full canonical parent transcript、8 MiB file、
  256 valid sessions、namespace 512-entry scan、nonblocking index/session lock、synced temp + atomic renameを
  所有する。
- `tui_cli.ts`はDefinition/manifest prepare後、newならallocate、continue/exact sessionならopenし、
  handleをcloseする。new empty reservationはclose時にcleanupされる。
- `AgentSession`はsuccessful turnだけをfull transcriptへcommitし、failed/cancelled draftをrollbackする。
  planner child、live progress、provider view、pending editor textはrecordへ入らない。
- `context.ts`は各model request前にfull transcriptのdefensive copyを作り、65,536 estimated message
  bytes以上で古いtool-result textだけを49,152目標までmarker化する。canonical transcriptは変更しない。
- Step 82 controllerはeditor、active task、steering、follow-up、recovery fixed lanesとidle/busy、
  discard、cancellation、no-silent-loss contractを持つ。
- startup restoreは100 messages / 256 KiBのcontiguous tailだけで、full history viewerとTUI内session
  switchはない。`agent:sessions list`はmetadata-only JSON、exact confirmed deleteを持つ。
- root READMEは内部説明として正確だが、利用開始より開発commandと内部説明が先行する。

## Scope

In scope:

1. same-workspace persistent sessionのTUI list/resume
2. current session ID、agent、latest committed turnのbounded表示
3. full canonical parent transcriptのread-only bounded viewer
4. one explicit manual semantic-compaction path
5. one persisted active derived context checkpoint
6. semantic projection後に既存mechanical omissionを適用するprovider view
7. schema-v1 canonical session compatibility
8. user-first root READMEとprovider-free guided confirmation
9. focused/store/context/controller/process/PTY/topology/full-offline evidence

Out of scope:

- past-turn continuation、branch/fork/tree、rewind、history edit
- global/cross-workspace search、rename/tag/search/export/import、TUI delete
- automatic/background compaction、summary chain、multiple checkpoints、arbitrary context editor
- pending/in-flight restart recovery、tool side-effect rollback
- Definition/manifest/replay/execution-record content変更またはsession/summary漏洩
- provider/model/login/credential selector、usage UI、hard sandbox
- Step 84以降、dependency/lockfile、`_refs/`変更、commit/push/tag/publish/release

## Before/after ownership

| State | Before | After |
|---|---|---|
| canonical transcript | schema-v1 `session.json` + `AgentSession` | unchanged; history/resumeの唯一の正本 |
| session list/open/lock | `DenoSessionStore`、startup/CLIのみ | same store contractをTUI navigation hostも利用 |
| active TUI session | startup factoryで固定 | prepared compositionを保持するhostがcurrent bindingを一つだけ所有 |
| restored display | startup tail only | startup tailは維持し、別のbounded canonical viewerを追加 |
| mechanical context | `prepareModelContext(full request)` | semantic projection後のrequestへ同じomissionを適用 |
| semantic checkpoint | none | repo-external stateのstrict companion record一つ |
| provider view | full canonical copy ± tool marker | checkpoint message + retained/new canonical turns ± tool marker |
| renderer | scrollback/live editor owner | metadata/modal page projectionのみ。identity/content ownerにしない |
| README | implementation/developer-first | quick start→daily flow→sessions→context→recovery/security→developer appendix |

## 83a: session navigation and read-only history

### Exact entry and idle contract

新しいdecoder events:

- `Ctrl-G` (`07`): session picker
- `Ctrl-T` (`14`): canonical history viewer
- `Ctrl-K` (`0b`): 83b context panel

既存key、CSI/SS3、50 ms Escape behaviorは変更しない。Ctrl-G/Ctrl-T/Ctrl-Kは次をすべて満たす場合だけ
acceptする。

- controller stateがidleでactive/cancelling turnがない
- editor byte length 0
- active-task、steering、follow-up、全recovery laneがempty
- discard confirmationがない
- compaction operationがない
- sessionがstructurally available

拒否時はtext-free statusだけを表示し、editor/history/pending/sessionをbyte-identicalに保つ。Ctrl-Gと
Ctrl-Kはpersistent modeだけで利用可能。`--no-session`ではrefuseし、Ctrl-Tだけprocess-local committed
historyを閲覧できる。

### Picker

Ctrl-Gでcurrent workspaceの`store.list()`を呼ぶ。provider/model、credential、tool、session commitは0。

- ordering: existing `updatedAt desc, id asc`
- 1 page最大8 entries
- 80 columns以上でshort ID、agent、updated time、turn/message count、current/resumed/mismatch状態を一行表示
- selected entryのfull UUIDをheader/detailに表示し、short-prefix collisionでも識別可能にする
- invalid record/checkpointはentryにせず`skipped invalid: N`へ集約する
- Up/Down: selection、Left/Right: page、Enter: exact selected UUID resume、Escape: cancel
- current rowのEnterはsession/lockを開き直さないno-opで元画面へ戻す
- picker中のprintable/Enterはordinary taskへ流さない

Current new empty reservationはstore listにrecordがなくてもhostが一つのsynthetic current rowとして表示する。
listだけではsession、JSON、lockを新規作成しない。

### Exact switch transaction

TUI navigation hostはstartupでvalidate済みのprepared Definition/runtime composition、store、current
handle/session/checkpointを所有する。

1. selected full UUIDを`openExisting()`してtarget session lockを取得
2. canonical record、workspace、selected agent、companion checkpointをstrict validate
3. 同じprepared compositionからtarget `AgentSession`をmaterialize
4. targetが完全にreadyになった後、old current session/handleをclose
5. old close成功後だけcurrent bindingをtargetへ交換
6. bounded restored tailとnew current-position projectionを表示

Failure contract:

- agent mismatch、busy、invalid/not found、I/O、checkpoint corruptionではtargetをcloseし、old
  binding/editor/pendingを保持する
- new sessionまたはdifferent sessionへのfallback、agent変更は0
- target construction前の失敗でold lockは維持する
- old close failureではtargetもcloseしfatal sanitized failureへ進む。二つのactive bindingを残さない
- successful switchでold sessionがempty reservationならexisting close cleanupでdirectory/lock ghostを除去
- viewer/picker output failureはterminal failure pathへ入り、session close/restoreの既存precedenceを維持する

### Current position

Host/sessionからimmutable projectionだけをrendererへ渡す。

```ts
{
  sessionId?: string;
  agent: 'default' | 'planner';
  committedTurn: number;
  messageCount: number;
  mode: 'new' | 'resumed' | 'none';
}
```

main status/headerではshort IDと`turn N latest`を表示し、full UUIDはpicker/history headerで確認できる。
session identityをDefinition、manifest、replay、provider requestへ追加しない。

### Canonical history index and viewer

`parseCausalTranscript()`のgrammarをsingle-sourceのturn index helperへ発展させ、validator、history viewer、
83b boundary selectionが同じ結果を使う。各completed parent turnはinitial user、assistant/tool batches、
optional one steering user、finalまたはterminal resultのmessage rangeを持つ。

Viewer contract:

- entry時はlatest committed turn
- Up/Down: previous/next bounded page、Home: oldest page、End: latest page
- Escape: viewer終了、latest conversation positionへ戻る
- Enter/printableはsubmit/edit/branchしない
- header: full session ID、agent、`turn X/N`、page、`read-only`
- one page: source UTF-8最大8,192 bytes、escaped terminal output最大32,768 bytes、
  最大`min(16, rows - 5)` content rows
- oversized message/tool resultはscalar-safe byte chunksへ分割する
- causal labelsは`user`、`steer`、`assistant`、`tool>`、`tool<`
- C0/C1、bidi、tab、newlineはexisting terminal escaping boundaryを再利用する
- controllerへfull transcript copyを渡さず、session-owned transcriptからbounded page projectionだけを返す

Viewer operationはprovider fetch、credential resolution、tool、event、commit、checkpoint write、pending input生成を
0とする。latest以外からのsubmit API、selected-turn resume API、branch/edit operationは作らない。

## 83b: explicit context recovery

### Persistence choice

Canonical `session.json`はschema-v1のまま維持する。checkpointはsame workspace partition配下の新しい
`contexts/` companion namespaceに置き、canonical session pathとは分離する。

```text
<workspace-partition>/contexts/<session UUID>.json
```

```ts
interface SemanticContextCheckpointV1 {
  readonly contextSchemaVersion: 1;
  readonly sessionId: string;
  readonly createdAt: string;
  readonly sourceProfileId: string;
  readonly coveredThroughTurn: number;
  readonly retainedFromTurn: number; // coveredThroughTurn + 1
  readonly summary: string;
}
```

- canonical compact UTF-8 JSON + trailing LF
- maximum file bytes 16,384
- summaryはnonblank、well-formed、NUL-free、maximum 12,288 UTF-8 bytes
- exact keys/order、canonical timestamp、known profile、safe integer boundaries
- same session ID、selected profile、current causal transcriptとexact correlateする
- missing companionはcheckpointなし、corrupt/unknown versionは`session_invalid`
- listはcompanionもvalidateし、invalidは`skippedInvalid`へ含める。metadataにsummaryを出さない
- old schema-v1 sessionをそのまま読み、silent rewriteしない
- old binaryは新しいsibling namespaceを無視し、full canonical `session.json`を読み続ける

Store operationはexisting index/session-lock ownershipを拡張する。install/replaceはexact session lock保持中に
mode 0600 synced sibling temp + atomic renameを使う。rename成功前のfailureはprevious checkpointを
byte-identicalに保つ。checkpoint history/backup chainは保持しない。

Deleteはcanonical sessionを削除した後にcompanionを削除する。companion removal failureはsanitized I/O failureを
返すが、canonical sessionのないorphanをactiveにしない。allocate/listはindex lock下でbounded orphan cleanupを
行い、companion namespaceも512-entry scan ceilingを持つ。

### Admission and byte-aware retained-boundary policy

Ctrl-Kは上記idle contractを満たすcurrent persistent sessionだけでcontext panelを開く。

Panelは次のbounded metadataだけを示す。

- current session/full committed turn count
- existing checkpoint active/none
- existing covered-through / retained-from
- proposed covered range / retained range
- current provider-view estimate
- `one provider request; canonical history remains unchanged`

Admissionはturn数や独自prefix ceilingではなく、production OpenRouter adapterと同じstable wire encoder、
exact 77,824-byte serialized-`messages` ceiling、256 KiB full request-body ceilingを使う。
`openrouter_model.ts`のmessage encoder/ceilingをinternal single-source helperとして再利用し、
semantic codeへ近似encoderを複製しない。

Fixed bounds:

- retained suffixは少なくともlatest complete parent turn一件を含む
- next ordinary draft reserveはNUL-free well-formed text最大4,096 UTF-8 bytes
- reserveのwire known answerはvalid draftで最大のJSON expansionとなるU+0001を4,096回含むsynthetic
  next-user messageをsame encoderへ通して固定する
- installed checkpoint messageのserialized wire contributionは最大16,384 bytes
- persisted summaryは最大12,288 UTF-8 bytesだが、raw boundだけでwire admissionを判断しない

N completed turnsに対し、Nが2以上の場合だけcandidate `coveredThroughTurn = C`、
`retainedFromTurn = C + 1`を、`1 <= C <= N - 1`の範囲で`C = N - 1`からdescending orderで調べる。
少なくとも一つのoriginal turnをcoverし、latest complete turn一件以上をretainする。replacementでは
`C`がexisting covered-throughよりstrictly大きいcandidateだけを調べる。

同じcurrent canonical history、system instruction、tools、worst-case 4,096-byte next draft、mechanical omission、
wire encoderを使い、comparison baselineを一つ作る。Initial installではno-checkpoint canonical view、
replacementではcurrent active checkpoint viewをbaselineとする。各candidateについて次をすべて満たす最初、
すなわち最大coverageを選ぶ。

1. exact summarizer system promptと、original canonical turns `1..C`から作るexact user envelopeを
   `tools: []`でencodeしたsummary requestが77,824-byte messages ceilingと256 KiB body ceiling内
2. current system instruction、16,384-byte checkpoint-message wire reserve、canonical turns
   `C+1..N`、worst-case 4,096-byte next-user draftから作るderived requestをsemantic projection後に
   existing mechanical omissionへ通した結果が両ceiling内
3. reserveを使ったcandidateのserialized `messages` bytesがcomparison baselineよりstrictly小さい

Older checkpoint/summaryはcandidate generationへ入力しない。毎回original canonical turns `1..C`を
summary sourceとし、summary-of-summary、incremental chain、truncation、partial-prefix推測は0とする。

N < 2、candidateがない、strict byte reductionがない、またはreplacementでcovered boundaryを前進できない
場合は、credential resolution、provider request、checkpoint writeを0として
`no useful fitting compaction`を表示し、canonical historyとexisting checkpointをbyte-identicalに保つ。
editor上限4,096 bytes超のnext draftはこのcompaction保証外であり、existing adapter refusalとStep 82 recovery
contractを維持する。

Panel keys:

- Enter: exact confirm and start
- `v`: current summaryのbounded read-only view
- Escape: request/writeなしでcancel

### Summary operation

Runtimeはalready-selected provider/profileからdedicated semantic summarizerをmaterializeする。
`runAgentTurn`は使わず、tool registryを渡さない。

Exact summarizer framing:

```text
You are generating a semantic context checkpoint for Henji Harness.
Summarize only the supplied canonical parent-turn prefix.
Preserve user goals, decisions, constraints, unresolved work, relevant file or state facts, and explicit uncertainty.
Do not introduce credentials, startup instruction or skill text, absolute state paths, or facts that are not present in the supplied messages.
Return exactly one compact JSON object with keys in this order: {"schemaVersion":1,"summary":"..."}.
Return no Markdown, tool call, or extra text.
```

One user-message contentは次のobjectをexact shown key orderで`JSON.stringify()`したcompact JSONとし、
trailing LFを付けない。

```ts
{
  schemaVersion: 1,
  operation: 'semantic_context_checkpoint',
  coveredThroughTurn: C,
  retainedFromTurn: C + 1,
  turns: [
    {
      turn: 1,
      messages: [/* exact canonical Message values in causal order */],
    },
    // ...
    {
      turn: C,
      messages: [/* exact canonical Message values in causal order */],
    },
  ],
}
```

`turns`はoriginal canonical turns `1..C`を一回ずつ含み、steering user messageとassistant/tool
call/resultをcanonical causal orderのまま保持する。Session ID、workspace/state path、checkpoint summary、
system instruction、skill text、Definition/manifest/replay dataはenvelopeへ加えない。

- `ModelRequest.systemInstruction`: literal prompt above
- `ModelRequest.transcript`: compact envelopeを含むexact one `user` text message
- `ModelRequest.tools`: exact `[]`
- accepted result: exact compact JSON `{"schemaVersion":1,"summary":"..."}`
- unknown/duplicate/reordered keys、tool call、blank/malformed/NUL/oversized summaryをreject
- selected profile、production `stream: true`、`max_completion_tokens: 1024`
- timeout 30,000 ms
- external/model request 0 or 1、retry/fallback/reconnection 0
- credential resolutionはconfirm後のgenerate/fetch直前だけで、panel entry/admission previewでは0

Generation中のcontroller stateは`compacting`とする。

- Escape/Ctrl-Cはcancelをrequestし、second Ctrl-Cはexisting 2-second contractに従いsettlement後exit
- SIGTERM/SIGHUPはcancel、settle、exit 143/129
- editor/pending laneはemptyを維持し、inputをordinary taskにしない
- cancellationはprovider body cleanupを待ってreadyへ戻る
- cleanup failureはfatalで、session/runtime reuseをpoisonする

Strict result validation後、install前にactual summaryから次のexact checkpoint messageを構築する。

```text
[henji-context-checkpoint:v1]
covered-through-turn: <C>
retained-from-turn: <C+1>
summary:
<summary>
```

Roleはexact `user`、content kindはexact `text`。数値はcanonical base-10、prefix/version/line breaksは
上記literal bytesとする。Actual checkpoint messageのwire contributionが16,384 bytes以下であることを確認し、
current system instruction、canonical retained suffix、worst-case 4,096-byte next draftを含むrequestを
semantic projection、existing mechanical omission、same wire encoderの順に通して77,824-byte messages
ceilingと256 KiB body ceilingを再検証する。さらに、そのactual candidateのserialized `messages` bytesが
request前と同じcomparison baselineよりstrictly小さいことを要求する。

Actual-summary ceiling/reduction admission failure、generate failure、timeout、cancel、invalid/oversize、
persistence failureではcheckpointをinstallせず、canonical historyとprevious checkpointをbyte-identicalに
保つ。Actual summary取得後にnonbeneficialと判明した場合はprovider request 1、checkpoint write 0である。
Durable renameだけがinstall pointであり、その後のrenderer failureではrollbackせず、restart後にinstalled
checkpointを表示する。

### Canonical execution seam and provider view composition

`v0/agent/loop.ts`をcanonical execution seamとする。`AgentTurnOptions`へinternal optional pure
`projectParentRequest(request)` portを追加し、各parent model stepで次をexactly once実行する。

1. full canonical transcript/draft、canonical tools/system instructionから`ModelRequest`を構築
2. optional parent projectorを呼ぶ
3. returned defensive requestへexisting `prepareModelContext()` mechanical omissionを適用
4. existing request-budget admission後にmodelへ送る

Projectorはinputを変更せずfresh requestを返す。event delivery、`LoopOutcome.transcript`、commit callback、
`AgentSession.committedTranscript`、schema-v1 persistence、history viewerはfull canonical transcriptだけを
使い、projected requestを観測または保存しない。

Checkpoint-aware persistent parent sessionだけがprojectorを渡す。Checkpointなしparent、planner child、
`runAgent` one-shot compatibility、normal `agent:run`、`--no-session` TUIはprojectorを省略し、
existing request/fake-wire bytesを不変にする。Planner delegation childへparent checkpointを継承しない。

Checkpoint-aware projectorは各parent requestで次を行う。

1. checkpoint boundaryをcurrent canonical transcriptへ再検証
2. canonical turns `1..coveredThroughTurn`をderived viewだけでliteral checkpoint user message一件へ置換
3. canonical turns `retainedFromTurn..latest committed/draft turn`をexact append
4. system instructionとtoolsをbyte-identicalに保持

```text
canonical/history: T1 T2 T3 T4 T5 T6 T7 T8 + draft T9
semantic view:     CHECKPOINT(T1-T4) T5 T6 T7 T8 + draft T9
provider view:     same semantic view, eligible old tool resultsだけ必要ならmarker化
```

Covered originalsとcheckpoint messageを同時送信しない。Same-turn user、assistant/tool batches、steeringは
canonical draftへだけappendされ、projectorはその時点のcomplete canonical draftから各step再生成する。
Successful T9はfull canonical historyへappendし、failed/cancelled T9はcanonical history/checkpointの
どちらも変更しない。

`ContextMetrics`はexisting fieldsを維持し、immutable checkpoint metadataとcanonical/semantic byte observationを
追加する。checkpointなしでは既存値をbyte-for-byte相当で維持する。ready statusはactive/inactive、
covered boundary、final estimateだけを表示し、summary textは`v`だけで閲覧する。

## 83c: root README and correlation

`README.md`を次の順へ再構成する。

1. **Start here** — pre-alpha/trusted-local、exact Deno 2.9.4 on PATH、repo-root portable `agent:tui`
2. **Read startup orientation** — workspace/agent/profile/session/instruction/skills/request-time credential/trusted-local tools
3. **Daily editing** — multiline/history/path/submit
4. **While work is running** — streaming/progress/steering/follow-up/cancel/recovery/discard
5. **Sessions and history** — Ctrl-G picker、latest-only resume、current position、Ctrl-T viewer
6. **Manual context recovery** — Ctrl-K、one provider request、canonical history保持、confirm前に示すbyte-aware retained range、failure/restart
7. **Exit and recovery** — normal exit、Ctrl-C/D、restart guarantees/non-guarantees
8. **Security and stored data** — plaintext session/summary、request-time credential、trusted-local tools、no hard sandbox
9. **Known limits** — no branch/edit/search/auto-compaction/pending restart recovery、original historyと4 KiB
   next-draft reserveをlive adapter ceiling内へ収めるuseful projectionがない場合のcompaction refusal
10. **Provider-free guided confirmation**
11. **Developer/reference appendix** — test tasks、corpus、sentinels、plans/results/archive/references

User-path commandは`deno task --quiet --config deno.v0.json ...`のportable formを使い、個人環境のabsolute
Deno pathを主導線へ置かない。READMEのkey/display/errorはTUIと同じconstants/projectionsまたはfixtureで
correlateする。未実装のlogin/model picker/branch/auto-compaction/sandbox/install/publishを現機能として書かない。

## Files and responsibilities

- `v0/agent/session_store.ts`: companion checkpoint codec/store、bounded namespace、list/open/delete/orphan
- new `v0/agent/session_history.ts`: single-source causal turn indexとbounded history page
- `v0/agent/openrouter_model.ts`: stable internal wire-message/body measurement helperとexact 77,824-byte
  ceiling。provider wire behaviorは不変
- `v0/agent/loop.ts`: canonical request construction後・mechanical context preparation前のoptional pure
  parent projector
- new `v0/agent/semantic_context.ts`: checkpoint、dynamic boundary search、literal prompt/envelope/result codec、
  semantic projector
- `v0/agent/context.ts`: projected requestへのexisting mechanical omissionとmetrics。semantic ownershipは持たない
- `v0/agent/session.ts`: parent projector/checkpoint-aware state、bounded history/state snapshot、compaction settlement
- `v0/agent/runtime.ts`: same-profile no-tool summarizerとprepared-composition reuse
- `v0/agent/tui_cli.ts`: persistent session host、switch transaction、checkpoint hydration
- `v0/tui/input.ts`: Ctrl-G/T/K events
- `v0/tui/controller.ts`: picker/history/context modal stateとidle/busy/cancel
- `v0/tui/render.ts`: bounded panelsとcurrent-position projection
- new `tests/v0/agent_session_navigation_test.ts`: navigation/index/page
- new `tests/v0/agent_semantic_context_test.ts`: prompt/result/provider-view
- existing store/context/session-TUI/controller/render/process/topology suites: persistence/lifecycle/PTY/nonleakage
- `deno.v0.json`、offline topology test: exact leaf ownership/permissions/order
- `README.md`: user-first document
- Step 83 results、`AGENTS.md`、handoff: authorized implementation/review/acceptance evidenceだけを記録

## Verification and gates

### 83a focused gate

- list ordering/bounds/current synthetic row/skipped invalid/agent mismatch
- busy/not-found/I/Oとexact no-fallback
- target-open/materialize/old-close transaction、current no-op、empty reservation cleanup
- nonempty editorと全pending/recovery/busy状態の拒否、text不変
- causal turn index including steering/tool-terminal
- 8 KiB/32 KiB/page-row bounds、multibyte/control/bidi/large result escaping
- viewer provider/credential/tool/commit/submit/write counts 0
- no branch/rewind/selected-turn submission surface
- 80x24 PTY picker/history/latest return、terminal restoration

### 83b focused gate

- checkpoint codec known answers、16 KiB file boundary、unknown/corrupt refusal
- old schema-v1 byte compatibility、no rewrite
- atomic install/replace/failure rollback/orphan/delete/512-entry bounds
- same-wire encoder known answers、77,823/77,824/77,825 messages boundaries、256 KiB body boundary
- dynamic candidate ordering、latest turn一件以上retain、replacement boundary strict advance
- N=0/1のrequest/write 0、candidate `1 <= C <= N-1`
- reserve candidateがbaselineよりstrictly小さいbyte-reduction admission
- tiny prefix + 16,384-byte reserveとnonbeneficial replacementのrequest/write 0、previous checkpoint不変
- 4,096-byte worst-case draft reserve、16,384-byte checkpoint-message wire reserve
- long original canonical sessionのlargest-fitting boundary、no-useful-candidate pre-provider refusal
- large final/tool responseを含むretained suffixのpre-compaction refusalまたはfitting boundary
- actual short/max/escape-heavy summaryのpost-generation admissionとold-checkpoint rollback
- actual summaryがbaseline以上へexpandする場合のrequest 1/write 0、previous checkpoint不変
- literal prompt/user-envelope/checkpoint-message independent known-answer bytes
- fake-fetch bodyのexact messages、`tools: []`、model、`stream: true`、completion tokens 1024、request 1
- success/invalid/oversize/failure/timeout/cancel/cleanup、retry/fallback 0
- canonical transcript equality before/after install/restart
- summary + recent + new exact composition、covered-message duplicate 0
- semantic-first/mechanical-second omission、adapter limits
- same-turn fake-wire semantic viewとcanonical event/outcome/commit/persistence/historyのexact divergence
- no-checkpoint parent、planner child、one-shot/CLI compatibility fake-wire byte equivalence
- post-compaction worst-case reserved next turnのadapter admissionとfake final canonical commit
- subsequent success commit、failed/cancelled noncommit、original-history replacement
- summary/session contentのstatus/error/stdout/stderr/events/Definition/manifest/replay leakage 0
- restart hydration、corrupt/new checkpoint fail-closed

### 83c and closure gate

- README command/key/display/recovery correlation
- portable documented-command process check
- current session store/context/session/TUI/editor/pending/cancellation/streaming/Steps 81/82 suites
- `v0:check`
- `v0:fmt`
- `v0:lint`
- `git diff --check`
- central permission topology
- authoritative `v0:gate`

Permission topology:

- pure navigation/semantic/context/controller leaves: no permissions
- store/persistent TUI leaves: existing exact disposable `/tmp` read/write
- PTY: existing exact `/usr/bin/script`
- provider-free guided fixture: exact disposable `/tmp` read/writeとfixed Deno/script childだけ。credential env/netなし
- production `agent:tui` permissionsは変更しない
- local/offline taskからproduction `agent:tui`/`agent:run`、credential-file task、provider network、
  production stateへのedgeを作らない

83a、83b、83cごとにfocused gateとresultsを固定し、前sliceのfailureをREADME変更で隠さない。最終owner gateは
repository-defined authoritative full offline gateを一回実行する。

## Human Gates and acceptance

1. **Initial implementation Human Gate**: source/tests/tasks/README/results/lifecycle changesだけを許可する。
2. **Provider-free representative Human Gate** after review GO:
   - dedicated deterministic fixture
   - same workspaceの二session
   - Ctrl-G exact resume、Ctrl-T causal history/latest return
   - Ctrl-K preview/cancel、fake-summary install、same checkpointでrestart
   - one subsequent fake successful turn、canonical history unchanged
   - pending loss、ghost/lock、provider/network/credential activity 0
3. **Optional real-provider Human Gate**: offline Step 83 completionには不要。実行直前にexact seeded session/task、
   selected profile、最大external/model request 1、timeout 30 seconds、retry/fallback/rerun/follow-up 0、
   repo-external credential経路を提示する。費用上限はその時点の公式provider/model価格から計算して本人承認を
   得る。credential値は読まず、tool callとordinary continuationは行わない。subsequent real turnは別承認とする。

Step 84の10-task daily useとalpha-readiness判断は別gateである。

## Rollback

- checkpoint write前はcode/docs/tasksを一括revertでき、data migrationはない
- canonical `session.json`はschema-v1のため、Step 82 binaryへ戻してもfull history/resumeを維持する
- older binaryはcompanionを無視し、pre-Step-83 full/mechanically reduced contextを送る
- Step 83再適用時はstill-correlated companionだけをvalidate/reuseする。orphanはboundedにignore/cleanupする
- rollbackはin-flight compaction requestやpending editor textのprocess restart preservationを保証しない
- automatic destructive cleanup/downgrade rewriteは行わない

## Completion conditions

Step 83は次をすべて満たした場合だけcompleteとする。

- 83a、83b、83cの順でfocused gatesがpass
- revision-35 success criteria 1-9にdirect observationがある
- implementation reviewと許可されたclosureがBlocker/P1/P2 0
- authoritative offline gateとpermission topologyがpass
- provider-free representative acceptanceを本人が明示accept
- READMEとactual TUIにknown command/key/display/recovery mismatchがない
- explicit optional real-provider Human Gate以外のprovider/network/credential operationが0

## Planning assumptions and stop conditions

Planner-owned How:

- retained boundaryはsame OpenRouter wire encoderで選ぶ最大coverage candidate
- candidateは一つ以上のturnをcoverし、comparison baselineよりserialized messagesをstrictly縮小する
- latest complete turn一件以上をretainする
- next-draft guaranteeはworst-case-encoded 4,096 UTF-8 bytes
- checkpoint-message wire reserveは16,384 bytes
- keysはCtrl-G/T/K
- checkpointはschema-v1 canonical recordと分離したone-entry companion

これらはrevision-35のWhy/What、success criteria、対象外を変更しない。No useful fitting candidateまたは
actual-summary post-generation admission failureではtruncate、summary chain、auto compactionを発明せず、
old checkpointとcanonical historyを不変にしてrefuseする。

実装中に次が判明した場合はscopeを広げず停止し、再planningまたは本人判断へ戻す。

- schema-v1 canonical sessionをsilent rewriteしないとatomic checkpointを成立させられない
- open/materialize/close順でold binding保持、ghost/lock 0、no-silent-fallbackを同時に満たせない
- bounded history pageがfull transcript copyまたはunbounded renderer outputを必要とする
- same wire encoderを使うdynamic admissionでも、original canonical historyからsummary chainなしに
  useful fitting boundaryを選べない
- semantic-first/mechanical-second viewがcovered originalとsummaryを重複送信する
- Step 82 pending textを失わずidle-only navigation/compactionをgateできない
- implementationがDefinition/manifest/replay/provider wire、Step 84、real-provider gateへscope拡大を必要とする
