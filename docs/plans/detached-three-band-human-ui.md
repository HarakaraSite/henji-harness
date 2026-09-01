# Detached three-band human UI

**GO. Human Gate 2 pending. Implementation is not authorized.**

## Recommendation

Roadmap Step 83Rはdependencyを追加せず、一つのneutral presentation boundary、core側TUI host
adapter、retained main-screen UIを導入する。通常画面は常に次の三領域として構成する。

1. 可変高の作業・会話log
2. 通常一行でboundedに上へ伸びるinput
3. exact一行のstatus/footer

Steps 81〜83のruntime、session、context、cancellation、credential、provider wire、persistence、terminal
settlement契約は変更しない。Human Gate 2承認後は、内部sliceごとの本人確認を置かず、実装、focused/PTY
test、authoritative offline gate、bounded review、finding closure、統合候補作成まで連続して進める。成功条件10
だけは統合候補完成後の一回の本人実画面Human Gateまでpendingとする。

## Planning base

- canonical input: `/tmp/planner-inputs/henji-detached-three-band-human-ui.md`
- input SHA-256: `e765fd216faa746aae80046408b702dbafd90048e26e5081056a3c04b2925de7`
- concept revision 37 / roadmap Step 83R
- base: `main` / `39d020c7a2706fbc8686185a31c32f1e7e936aca`
- Step 81 plan: `docs/plans/portable-launch-startup-orientation.md`, SHA-256
  `6000e27210305845032e74f2ccecc04ce1c03b6f6c1e84e30beed673ea251a09`
- Step 82 plan: `docs/plans/daily-editor-no-lost-input.md`, SHA-256
  `a0be3aedc6e3612b123cdf92073dd3e4febf4da61d21323d4d7d113a9614d0fa`
- Step 83 plan: `docs/plans/session-navigation-context-recovery-readme.md`, SHA-256
  `9d9de998764fe465c928f772c0ec9948b2980f10456ec55a072979fdd2670050`
- authoritative baseline: `v0:gate` 664/664、topology 2/2、check/fmt/lint/diff green、final
  Blocker/P1/P2 0
- `.handoff/handoff.md`の既存変更を保持する。user-owned untracked `_refs/*`は変更、stage、削除、更新しない。
  `_refs/pi/`と`_refs/zot/`だけをread-only参照とし、dependencyにはしない。

現在承認されているのはplanningとread-only reviewだけである。Human Gate 2前にproduct/test/task/dependency
変更、provider/network/credential操作、persistent product state変更、本人実画面確認、commit、push、tag、
publish、releaseを行わない。

## Live current dependency and ownership

```text
AgentSession / loop / AgentEvent / session store / context
             │ domain objects and types
             ▼
v0/agent/tui_cli.ts
  ├─ runtime、store、navigation transaction、terminalをcomposition
  ├─ AgentEventをrenderer.eventSinkへ直接bridge
  └─ editor、pending、path index、controllerをconstruct
             │
             ├──────────────────────────────┐
             ▼                              ▼
v0/tui/controller.ts                 v0/tui/render.ts
  AgentSession、LoopOutcome、          AgentEvent、LoopOutcome、Message、
  context/navigation/history型をimport RuntimeDisplayState、navigation/history型をimport
             ▲
             │
v0/agent/session_history.ts ──────────┘
  terminal escaping/historyPageTextをv0/tui/render.tsからimport
```

現行rendererはcompleted recordをmain-screen scrollbackへ追加しeditor/status blockをredrawするが、resize後の
reflow、source anchor、same-entry streaming updateを所有するretained causal logを持たない。startup orientationは
12行をprompt前に流す。controllerはUI操作とsession/navigation/context side effectを同時に所有し、
`session_history.ts -> tui/render.ts`のcore-to-UI reverse edgeもある。

再利用する既存契約は次である。

- `v0/tui/input.ts`: 65,536-byte scalar multiline editor、32件/256 KiB history、bounded decoder
- `v0/tui/pending_input.ts`: fixed steering/follow-up/recovery lanes
- `v0/tui/file_reference.ts`: bounded workspace-relative completion
- `v0/tui/terminal.ts`: idempotent acquire/restore lifecycle
- `v0/agent/`: successful-turn-only session、latest-only navigation、canonical history、semantic checkpoint authority
- assistant progress: 65,536 UTF-8 bytes / 256 updates per request
- tool progress: 8,192 UTF-8 bytes / 64 updates per call
- restored display: 100 messages / 256 KiB

## Target boundary and import direction

```text
Core/domain side
runtime · session · provider · registry · store · context · events
                    │ immutable facts/events + host operations
                    ▼
       v0/agent/tui_presentation_adapter.ts
       - core → presentation validation/sanitization
       - intent admissionとsession/context/navigation side effectを所有
       - runtime/provider/store objectをUIへ渡さない
                    │ PresentationProjection / PresentationEvent
                    ▼
       v0/presentation/contract.ts
       - data-only readonly types / finite enums
       - I/O、ANSI、agent/runtime/provider/store/TUI import 0
                    ▲
                    │ UiIntent / typed host result
UI side             │
v0/tui/state.ts · layout.ts · controller.ts · render.ts
input.ts · pending_input.ts · file_reference.ts · terminal.ts
       - editor、overlay、scroll/follow、keybinding、layout、ANSIだけを所有

Composition root only:
v0/agent/tui_cli.tsがadapterとconcrete TUIを接続する。
headless v0/agent/runtime_cli.tsはadapter、presentation reducer/renderer、v0/tuiへ到達しない。
```

機械的に固定するimport invariant:

- `v0/presentation/contract.ts`はproduct implementationをimportしない。
- core/domain/provider/Definition/tool/session/context/storageは`v0/tui/`、terminal、ANSI、layout、editor、overlayを
  importしない。
- `v0/tui/`はruntime/provider/registry/session/context storage implementation、`AgentSession`、`AgentEvent`、
  `LoopOutcome`、canonical `Message`をimportしない。
- `tui_presentation_adapter.ts`はagent/coreとneutral contractをimportできるがconcrete TUIをimportしない。
- productionで両側をimportできるのは`v0/agent/tui_cli.ts`だけである。
- `session_history.ts -> tui/render.ts`を除去する。coreはbounded canonical history dataを返し、escaping/framingと
  32 KiB terminal output admissionはadapter/UI境界へ移す。
- `agent:run`のtransitive import closureにはTUI、adapter、terminal、presentation reducer/rendererが0である。

## Neutral presentation contract

### Projection

`PresentationProjection`はdeep-frozen data-only snapshotとし、次のbounded display factだけを持つ。

- lifecycle: `starting | idle | busy | cancelling | compacting | recoverable_error | fatal`
- selected agent ID、optional short session identity、committed turn
- secret-free compact workspace label。absolute state pathは禁止
- fixed trust classとrequest-time credential-policy enum。credential presence/path/valueは禁止
- Step 83で許可済みのcontext estimate/checkpoint fact
- pending laneのkind/lifecycle/byte count。hidden textは禁止
- navigation/history/compaction availability、compact startup fact、stale resultを拒否するhost generation

model/provider instance、registry、store handle、`AbortController`、secret resolver、canonical transcript、raw error、
absolute file path、mutable collectionを含めない。

### Presentation events

`PresentationEvent`はfinite readonly unionとする。

- lifecycle/status transition
- user/steering log entry
- assistant begin/update/complete
- tool begin/progress/complete
- enumerated codeと固定文言だけのwarning/recoverable/fatal entry
- restored log batchとomission count
- session list、history page、compaction preview/result、session binding replacement
- operation cancellation/settlement

各eventはadapter生成のbounded opaque identityとgenerationを持つ。provider call IDはadapter-private correlation keyとし、
UI stateや表示へ出さない。unknown core eventはaffected turnごとに最大一つの固定`unsupported activity omitted`
warningへ落とし、payloadをstringifyせずside effectを合成しない。

### User intents

`UiIntent`はuser meaningを表すfinite readonly unionとする。

- ordinary submit、steering submit、one follow-up queue
- active cancellation、clean/signal exit
- session list、exact selected-session resume
- canonical read-only history page
- compaction preview、confirm/cancel、operation dismiss

editor mutation、local history、path completion、overlay selection/help paging、log scroll/latest、resizeはUI-local actionであり
境界を越えない。adapterはintentを再検証し、active-turn ownership、one steering/follow-up lane、latest-only resume、agent
match、lock、compaction idle gate、cancellation、commit、cleanupの既存core admissionを唯一のauthorityとする。

### Validation and sanitization

- caller-owned valueをsnapshotしてから検証する。
- non-plain、accessor-bearing、cyclic、over-bound、noncanonical、禁止NUL、mutable-shaped valueをUI delivery前に拒否する。
- dynamic textはterminal escaping前にUTF-8 byte boundを適用する。
- malformed adapter inputは固定sanitized failureへ変換し、raw exception/object stringifyを境界へ出さない。
- renderer/event sink failureは既存`EventDeliveryError`/`output_failure`へ接続し、cancellation/restore precedenceを維持する。

## Three-band UI state and layout

### Immutable state

`v0/tui/state.ts`へI/Oを持たないpure reducerを置く。

```text
UiState {
  projection/lifecycle
  log { entries, omittedCount, activeAssistantId?, activeToolIds }
  editor { EditorSnapshot, history mode }
  pending { fixed-lane snapshot }
  scroll { followLatest | anchored(entryId, sourceScalarOffset), newBelowCount }
  overlay { none | startupHelp | sessionPicker | history | compaction }
  statusFacts
  terminalSize
}
```

全transitionはnew stateを返し、canonical stateへのdispatch、terminal write、core side effectを行わない。prior stateと
caller inputの不変をdirect testする。

### Log identity and bounds

- 最大512 presentation entries / 256 KiB source display text。single text最大64 KiB。assistant/toolの既存のより厳しい
  boundsを優先する。
- oldest completed entryだけをevictし、active assistant/toolをevict/duplicateしない。capacity overflowはbounded omission
  marker/count一つで表し、overflow queueを持たない。
- user/assistant/tool/warning/recoverable/fatalをtext label/iconとstyleの両方で区別し、色だけに依存しない。
- assistant progressは一つのidentityをbegin/update/completeし、chunkごとのrowを追加しない。
- tool call/progress/resultは一つのidentityを使い、progress live portionだけを置換し、完了結果を残す。multi-toolは
  result arrival順にかかわらずcausal call順を保つ。
- tool argument、raw provider body/event、credential、absolute state pathをlogへ出さない。

### Layout, reflow, and scroll

`v0/tui/layout.ts`は`UiState`とbounded terminal sizeだけからpure layoutを作る。

- normal support boundaryは80x24以上。reported sizeは最大512 columns / 200 rowsへclampする。
- 80x24ではfooter exact 1 row、empty/short editor exact 1 row、multiline/wrap editor最大8 rows。editor growth前にlogを
  最低3 rows保持する。
- 80x24未満はdeterministic degraded layoutとし、3 rows以上ならfooter/inputを各1 row保持し、footer wrapやpanicより
  log detail省略を選ぶ。
- scroll anchorはrendered rowではなく`(entryId, sourceScalarOffset)`。width resize後も同じsource positionを回復する。
- follow modeはlatestを追う。PageUp/PageDownでanchored modeへ入り、新規出力でanchorを移動せずbounded new-below countを
  増やす。Ctrl-Lでlatestへ戻る。
- active entry updateやeditor height changeでanchorを移動しない。evictionでanchorが消えた場合はoldest surviving
  successorへ移し固定warningを出す。
- wrapped-row cacheはimmutable state外で`(entryId, revision, width)`にbindする。editor-only redrawはlog cacheを再利用し、
  progressは該当entryだけinvalidateする。width resizeだけがbounded logを一回scanできる。

### Renderer, input, footer

main-screen retained virtual viewportを使い、append-only event rowsやalternate-screen state model、external frameworkを
採用しない。frameはvisible log、input、footerを一体で描画し、width changeでbounded full reflow、height-only changeで
source anchorを維持する。redraw outputは128 KiB以下、layout sourceは256 KiB以下とする。cursor placementはeditor
layoutだけが決め、毎frame後に復元する。output failureはfatal settlement/terminal restoreへ送る。handled exit時はlive
progress/input/footerを片付け、SGR、scroll region、cursor、bracketed paste、raw modeを復元する。

idle、draft editing、anchored scroll、overlay open中にもresizeだけで即時re-layoutできるよう、terminal lifecycleが
UI-localなSIGWINCH/resize notificationを所有する。notificationはbounded/coalescedとし、terminal sizeを再読してpure
resize transitionを一回だけscheduleする。restore開始前にlistenerとpending callbackを解除し、restore後late redrawを0に
する。resize redraw failureは他のrenderer failureと同じfatal settlement/restore precedenceへ送る。core intent、session、
provider、event transcriptへSIGWINCHを渡さない。

Step 82のeditor/history/paste/multiline/path completion/fixed lanes/recoveryを維持し、decoderへPageUp/PageDown、Ctrl-L、
F1を追加する。CSI/SS3 splitと既存50 ms timeout boundaryを守る。既存Ctrl-G/T/K、Enter、Alt-Enter、Escape、
Ctrl-C/D、Ctrl-O/W/P/N/R、arrows、Home/End、pasteの意味は変えない。

footerはarbitrary status stringではなくfactから、次のpriorityで一行へ投影する。

1. fatal/recoverable warning、cancelling/compacting/busy/ready
2. discard/cancel/recovery action required
3. pending laneとnew-below indicator
4. active agent
5. short session/turnまたはno-session
6. compact help/context hint

lower priority segmentを先に落とし、各segmentをcontrol/bidi sanitizeとcell truncationする。footerはterminal widthへ
pad/truncateしnewlineを含まない。

## Startup and overlays

startup orientation 12行をordinary logへ流さない。first task前はlog areaへ最大2行だけを表示する。

- Henji、active agent、session mode/short identity、compact workspace label
- trusted-local boundary、`credentials checked only when sending`、`F1 help`

full startup factsはF1 overlayで表示する。startup credential read/provider fetch/tool executionは0のままにする。

overlayはbase editor、pending、log、scroll、footerを置換しない`UiState` childである。F1はnon-empty draft上でも開け、
draft/cursor/history position/scroll/pending/statusをexactに戻す。Ctrl-G/T/KはStep 83どおりidle、empty editor、pending
なしだけをadmitし、refusal時はbounded status以外を変えない。

- pickerのselection/pagingはUI-local、list/resumeはtyped intent
- historyはread-onlyでsubmit/edit/branch/rewindを持たない
- compactionはsettled/idle、explicit preview/confirm、一request、successful atomic checkpoint installを維持
- overlay text/paste/Enterをordinary submitにしない
- async overlayのlist/history/preview等のdisposable payloadはopening generationを持ち、dismiss/session replacement後の
  late resultをowned settlement後に無視する。ただしsession old-close後のbinding adoption、already-installed checkpoint、
  cancellation/fatal ownership等のauthoritative host transitionはstale overlay payloadではない。adapterがownershipを
  先に確定し、新generationの`session_binding_replaced`またはcheckpoint projectionを必ずreducerへ適用する。overlayが
  dismiss済みならmodal content/redrawだけを抑止し、footer/log/current bindingを旧sessionへ戻さない
- cancel/success/recoverable/fatal/session swap/output/input/EOF/signalをdirect testする
- successful switchだけtarget restored projectionへlogを置換しfollow latestへ戻す。session authorityはexisting
  irreversible old-close transactionに残す
- delayed resume→dismiss/abort/signalとpost-install compaction failureで、adapter current binding/checkpoint、UI session/
  checkpoint identity、next submit target、old/new close ownershipが常に相関することをdirect testする

## Ordered implementation slices

### Slice 1: neutral boundary and reverse-import removal

- `v0/presentation/contract.ts`を追加する。
- `session_history.ts -> tui/render.ts`を除去し、history indexingとpresentation escaping/framingを分離する。
- contract immutability/validation/sanitization/unknown-event testとexact import topology/mutation testを追加する。

Likely files: new contract、`session_history.ts`、必要なら`session_navigation.ts`、new
`presentation_contract_test.ts`、new `ui_boundary_topology_test.ts`。

### Slice 2: core-side adapter

- `v0/agent/tui_presentation_adapter.ts`を追加し、startup facts、`AgentEvent`、outcome、session position/history、
  navigation、context operationをneutral projection/event/resultへ変換する。
- provider call ID、store/session handle、abort owner、raw failureをprivateに保ち、intentをexisting core APIへadmitする。
- causal assistant/tool identity、bounds、unknown/malformed input、credential/error/path canary、all intent correlation、
  synchronous delivery failureとasync settlementをtestする。

### Slice 3: immutable retained state and pure layout

- new `v0/tui/state.ts`と`layout.ts`へlog、anchor、overlay、status、pure reducer/reflowを実装する。
- existing editor/pending/path completionをUI-local transitionとして再利用する。
- 80x24全state geometry、narrow degradation、input growth、multibyte cursor、scroll/resize、retention、footer priority、
  structural work boundsをdirect testする。

### Slice 4: renderer and typed-intent controller

- `render.ts`をretained virtual screenへ置換し、`controller.ts`からdirect core/session importを除く。
- decoderへscroll/latest/help keysを追加し、terminal lifecycle/failure precedenceを維持する。
- `terminal.ts`にUI-local bounded/coalesced SIGWINCH subscriptionとidempotent unregisterを追加し、idle/draft/anchor/
  overlay中もresize transitionを起動する。restore後callbackとlate writeを禁止する。
- streaming/tool same-entry update、stable bands、cursor/editor preservation、frame bytes/work、failure restoreをtestする。

### Slice 5: startup and overlay integration

- compact welcome + F1 detailsへstartupを変更する。
- Ctrl-G/T/Kをtyped intent/resultへ接続し、navigation transaction/checkpoint authorityを維持する。
- machine testと最終本人受入用にproduction controller/renderer/neutral adapterを使うprovider-free in-memory fake hostを
  通常製品導線と分離して追加する。
- overlay state restoration、no-submit、stale async result、exact session swap/cleanup、compaction atomicity、request 0をtestする。

### Slice 6: atomic production switch

- `tui_cli.ts`をprepared runtime、host adapter、concrete TUI間のsole composition rootにする。
- legacy direct event-to-renderer/session-to-controller production reachabilityを除去する。
- old production wiringはnew focused suites成功まで残せるが、final treeにmixed modeを残さない。test seamはtest-onlyかつ
  production selection不能にする。
- README、task/check/topology inventory、results/lifecycleをimplementation evidence後に更新する。

### Slice 7: verification, review, and candidate package

- focused matrix、authoritative `v0:gate`、check/fmt/lint/diffを実行する。
- import direction、input loss、session/context authority、terminal failure、sanitization、bounds、PTYを重点にindependent
  changed-lines reviewを行う。
- 一回のbounded plan-scoped finding closureと一回のnarrow re-reviewを既定とし、ownerがaffected suitesとfull gateを
  独立再実行する。
- final acceptance packageを作り、本人実画面Human Gate前で停止する。

## File and task topology

Likely production scope:

- new `v0/presentation/contract.ts`
- new `v0/agent/tui_presentation_adapter.ts`
- new `v0/tui/state.ts`, `v0/tui/layout.ts`
- `v0/agent/tui_cli.ts`, `session_history.ts`, 必要時のみ`session_navigation.ts`
- `v0/tui/controller.ts`, `render.ts`, `input.ts`, 必要時のみ`terminal.ts`, `pending_input.ts`,
  `file_reference.ts`
- `README.md`, `deno.v0.json`, focused tests/fixtures、topology/inventory、results/lifecycle

追加するbounded leaves:

```text
agent:ui-presentation:test
  deno test --no-prompt
    tests/v0/presentation_contract_test.ts
    tests/v0/tui_presentation_adapter_test.ts
    tests/v0/tui_state_test.ts
    tests/v0/tui_layout_test.ts

agent:ui-boundary:topology:test
  deno test --no-prompt
    --allow-read=deno.v0.json,v0/agent,v0/presentation,v0/tui,v0/domain.ts,v0/model.ts
    tests/v0/ui_boundary_topology_test.ts
```

first leafはpermission-free、secondはconfig、三source root、root core/provider nodes `v0/domain.ts` / `v0/model.ts`だけを
readする。testは`agent:run`から解決したproduction import graphがこのexact inventory外へ出た場合もfail closedにし、
各root/core/provider classからTUIまたはadapterへのreverse edge mutation、TUIからagent implementationへのedge、adapterを
迂回するcomposition edgeを拒否する。両leafを`v0:test`、`v0:check`、central source inventory、exact-once leaf
ownership、permission snapshot、mutation matrixへ登録する。production permissionとexisting PTY permissionを拡張しない。

## Required test matrix

| Area | Direct evidence |
|---|---|
| Contract/projection | deep immutability、primitive/data-only shape、bounds、forbidden object/key/accessor/cycle、sanitization、unknown fail-safe |
| Adapter identity | one assistant/request、one tool/call、progress replace、completion correlation、causal multi-tool order |
| Reducer/layout | prior-state immutability、全lifecycle、80x24三領域、one-line footer/input、bounded multiline、narrow/size clamps |
| Text safety | long/multibyte/control/bidi、fragmented stream、large result、rapid progress、terminal injection 0 |
| Scroll/resize | follow、anchor、new-below、latest、reflow、active update、eviction fallback、idle/draft/overlay SIGWINCH、coalescing/unregister |
| Editor/pending | growth/shrink、cursor、paste、history、path、steer/follow-up/recovery/discard、silent loss 0 |
| Overlays | F1/picker/history/compaction open/cancel/success/failure、late result、base restoration、accidental submit 0 |
| Authority | navigation mismatch/busy/invalid/I/O/close/swap/cleanup、compaction fake/cancel/atomic checkpoint、canonical transcript不変 |
| Failure | event/render/output/input/EOF/Ctrl-C/signals、active operation settlement、restore、late write 0 |
| Security | credential/path/raw-error canaryがprojection/state/log/footer/stdout/stderr/session/manifestに0、Bash noninheritance |
| Performance | unchanged-entry cache、one-entry invalidation、bounded resize scan、frame ≤128 KiB |
| Headless/topology | `agent:run` UI materialization/import 0、known answer不変、forbidden-edge mutations |
| Compatibility | `agent:tui`、agent/session flags、Definition/manifest/replay/session/context/provider wire不変 |

少なくとも新2 leaves、existing TUI/input/pending/file/PTY/portable/topology、session navigation/store/TUI、semantic
context/context/cancellation/tool progress/streaming/runtime/process、offline topology、check/fmt/lint、`v0:gate`、
`git diff --check`を実行する。`v0:gate`をauthoritative resultとし、real-provider acceptanceとcredential-file taskは
実行しない。

PTYはexisting `/usr/bin/script` permissionだけを使い、80x24各state、editor growth、split PageUp/PageDown/F1と50 ms
boundary、scroll/new-below/latest、idle/draft/anchored/overlayのresize-only通知、streaming中の
80x24→narrow/short→100x30、overlay draft/no-submit、Ctrl-G/T/K fake settlement、EOF/output failure/signals、
cursor/raw/paste/SGR/scroll-region restore、listener cleanupとrestore後late write 0をdirect観測する。fixed string snapshot
だけでUX完成を主張しない。

## Dependency decision and references

runtime/dev dependencyとlockfileを追加しない。現行Deno/TypeScript treeにeditor、terminal、event、fake-test primitiveが
あり、Pi framework/state modelはscopeより広く、ZotのGo rendererも直接採用できない。新frameworkはpackage trust、
permission、maintenance、size、rollbackを増やすだけでcore/UI ownership splitを解決しない。

implementation中にdependencyが不可欠と判明した場合はlocal deltaにせずconcept reviewへ戻し、exact package/version/hash、
transitive size、license、permission、maintenance、rollbackを提示する。

read-only reference evidence:

- Pi pinned `a69bef789bc95abf0acee16f7b4660b70b650bb9`: interactive modeのscroll viewとbottom dock分離、manual
  anchor/follow、overlay focus restoration、main-screen retained redraw、sanitized width-priority footer
- Zot pinned `9b7bb6a4f36bc8c8deb2cc5796a8f557f4fb7479`: scrolling chatとbottom-sticky dialog/input/status、stream/tool
  row update、bottom-band height/content deltaに対するanchor test

Henjiはbehavioral patternだけを独立実装し、package/API/session model/extension/provider featureを採用しない。

## Risks, rollback, and flake policy

- terminal drift: retained frame、byte cap、resize PTY、existing idempotent restoreで閉じる。
- lost/resubmitted input: immutable base、fixed lanes、overlay generation、failure settlement matrixで閉じる。
- authority leakage: namingではなくactual import graphとforbidden-edge mutationで拒否する。
- streaming duplication/scroll jump: adapter-private correlationとsource anchor direct testで閉じる。
- sensitive display: allowlisted projection、fixed error、central escaping、canary negative evidenceで閉じる。
- typing latency: 256 KiB/512 entries、revision cache、structural work counter、visible-only outputで閉じる。
- PTY flake: rerunだけでwaiveしない。一回だけisolateしてoutputを保持し、source変更なしのcomplete PTY suiteとfinal full
  gate成功が揃った場合だけnon-reproducing harness observationとできる。再現すればdefectとして扱う。
- human UX: mechanical evidenceは成功条件1〜9だけを閉じ、10を閉じない。

partial migrationをship/recordしない。final switch前はnew modulesをproduction unreachableにできるが、switch後はlegacy
direct edgeとmixed controllerをtopologyで拒否する。session/context/security/terminal invariantを維持できなければ現行
wiringへ一体でrollbackし、boundaryを弱めない。

schema、manifest、Definition、replay、provider wire、credential、stored-data migrationはない。rollbackはcontract/adapter、
state/layout/renderer/controller、decoder、composition、tests/tasks/topology/README/results/lifecycleを一incrementとして戻す。
existing session/context data conversionやcleanupは不要である。

## Requirements-to-evidence

| Success | Evidence |
|---|---|
| 1 三領域 | all-state pure geometry、fake frame、80x24 PTY |
| 2 causal task/stream/tool/final | adapter identity、fragmented fake flow、integrated PTY |
| 3 bounded editor/no loss | editor/layout、pending/recovery/discard matrix、paste/history/path PTY |
| 4 predictable scroll/resize | source-anchor reducer、structural reflow、new-below/latest PTY |
| 5 overlay restoration/no submit | before/after state equality、generation、F1/G/T/K PTY isolation |
| 6 compact discoverable startup | startup known answer、F1 details、credential/fetch/tool 0 |
| 7 detached typed boundary | import topology/mutations、contract immutability、direct implementation reference 0 |
| 8 shared unchanged core | headless import closure/known answer、Definition/manifest/session/context regression |
| 9 security/persistence/restore | credential/fetch/Bash canary、successful commit、signal/failure PTY、permission topology/full gate |
| 10 human daily-use acceptance | post-integration本人実画面Human Gate一回だけ。snapshot/PTYで代替しない |

## Planning review disposition

initial read-only reviewはBlocker 0 / P1 1 / P2 2だった。

- P1: blanket stale-overlay suppressionがold-close後のauthoritative binding adoptionまで捨て、core bindingと表示sessionを
  乖離させ得た。disposable payloadとauthoritative transitionを分離し、new-generation binding/checkpoint projectionと
  delayed correlation evidenceを追加した。
- P2: idle/draft/overlay中にresizeを起動する経路がなかった。bounded/coalesced UI-local SIGWINCH、fatal redraw routing、
  unregister/late-write 0とdirect PTY evidenceを追加した。
- P2: topology leafがroot `v0/domain.ts` / `v0/model.ts`を読めず完全graphを証明できなかった。exact read inventory、
  graph escape failure、root/core/provider reverse-edgeとadapter bypass mutationを追加した。

同じreviewerによる一回のnarrow re-reviewは3件をすべてClosedとし、correction-caused Blocker/P1なし、最終
`GO — Blocker 0 / P1 0 / P2 0`を返した。planning中にimplementation/test/provider/network/credential/persistent
product state/dependency/`_refs/`/commit/push/tag/publish/release操作は行っていない。

## Integrated acceptance package and Human Gates

Human Gate 2が承認するのは、この計画内のimplementation、provider-free fake tests、focused/PTY/full offline gate、
results/lifecycle、bounded review、一回のplan-scoped finding closure、narrow re-review、integrated candidate packageである。
途中slice/component/keyごとの本人確認は置かない。

final packageはreviewed diff/commit candidate identity、focused/full counts、final severity disposition、known limitations/
deviation、external operation記録、一つのprovider-free real-screen command、一つの短い代表操作列を含む。fixtureは
production TUI controller/rendererとneutral adapterをin-memory fake hostで使い、provider/network/credential、production
provider command、persistent product stateを使わない。exact commandとtask enrollmentはimplementation時に通常のDeno
permission topologyへ合わせて固定し、acceptance前にknown-answer testする。

本人操作は一回で、三領域確認、draft上F1 restore、fake stream/tool/final、scroll/new-below/latest、multilineと
steering/follow-up/recovery、picker/history/compaction cancel、resize、cancel/exit/restoreを代表確認する。このHuman Gate
だけが「Pi/Zotより大幅に劣る」という不受入理由の解消を判断する。不受入ならevidenceをconcept reviewへ返し、ad hoc
feature expansionを自動承認しない。

## Completion conditions

final human gateへ進めるのは、全slice integrated、legacy/mixed production path 0、focused/topology/full gate green、
independent reviewとbounded closureがBlocker/P1/P2 0、provider/network/credential/production provider operation 0、
actual persistent product stateと`_refs/`変更0、package完成、成功条件1〜9 direct evidence、成功条件10 explicit pendingの
すべてが成立した場合だけである。

## Scope exclusions

- Pi/Zot parity、外観clone、theme、mouse、image、rich Markdown、syntax highlighting
- browser/GUI/mobile/remote UI、server、multi-client
- provider/model/reasoning selector、login/credential UI、usage/cost、多provider
- session tree/branch/fork/edit/search/export/import/share/cross-workspace
- auto/background/multiple compaction、pending/editor/history persistence、in-flight recovery
- plugin marketplace、public UI SDK/event bus、Pi compatibility
- Definition/manifest/replay/self-revision/benchmark/promotion
- hard sandbox、deployment、package/release
- real provider/credential accessをmachine verificationの必須条件にすること

## Planner discretion

file/typeの細分化、style/color、retained-screen diff algorithm、immutable collection/cache、bounded wording、deterministic
permission-free fake seamは実装裁量とする。三領域、import/authority方向、session/context/cancellation/persistence/provider/
credential semantics、CLI command/flags、security/output bounds、dependency policy、scope exclusions、Human Gates、成功条件10は
裁量で変更できない。

## Concept-review stop conditions

次が必要になった時点で停止し、concept ownerへ返す。

- 三領域またはfinal human acceptance条件の変更
- UIによるruntime/provider/registry/session/context storage/side effect所有
- session schema、latest-only resume、canonical history、checkpoint atomicity、commit/replay、cancellation authority変更
- credential timing/non-disclosure/Bash noninheritance、provider wire、real-provider verification変更
- dependencyまたはproduction permission追加
- intermediate Human Gate追加、対象外feature拡張
- 成功条件1〜9をdirect観測できないarchitecture

未決のconcept-owner質問はない。Ctrl-G/T/Kのexisting empty-editor/no-pending admissionを維持し、draft restorationはF1で
full観測、draft存在時のG/T/Kはexact unchanged refusalとして観測する。
