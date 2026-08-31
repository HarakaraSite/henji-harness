# Portable launch and startup orientation implementation plan

## Decision summary

**GO、初期implementation Human Gate待ち。**

Roadmap Step 81では、exact Deno 2.9.4が`PATH`上で利用できるrepository rootから、次をnormal
TUIのportableな利用者入口とする。

```text
deno task --quiet --config deno.v0.json agent:tui
```

`v0/agent/session_launcher.sh`はcheckout外の固定Deno pathを廃止し、`PATH`から解決した
executableがexact Deno 2.9.4であることを確認して、現在と同じpermission envelopeでTUIを起動する。
JSR、installer、global install、binary配布、他taskの一括portable化は行わない。

`prepareRuntimeComposition()`がDefinition、resource selection、resolved manifestの検証を終えた直後に、
一つのimmutableなread-only表示stateを構築する。CLIとTUIは同じprepared stateを使い、UI側でDefinition
評価、resource再構成、manifest生成、model/registry materializationを行わない。

startupではcredentialの値、presence、path、metadataを一切読まない。orientationにはselected
providerのcredentialを各provider request直前に検証する固定policyだけを表示する。現行のrequest-time /
per-request credential解決、resolution前cancel時read 0、missing・空文字・resolution exception時fetch 0、
failed turn commit 0を維持する。

implementation、test、review、results/lifecycle更新は別のHuman Gateまで開始しない。

## Planning base

- canonical input: `/tmp/planner-inputs/henji-portable-launch-startup-orientation.md`
- concept revision 33 / roadmap Step 81
- input SHA-256:
  `538e757efe426512e01c63b644a09f819d1cd226ee8aaaa8fce5da4a5ff4fd66`
- base: `main` / `d98f1a651a1fec981117d93c8c40e1d643809d1c`
- tracked treeはclean。既存untracked `_refs/*`はuser-ownedであり変更しない。
- Step 80までaccepted、authoritative offline gate 578/578、final Blocker/P1/P2 0。
- `agent:tui`は既に`session_launcher.sh`を呼ぶが、launcher内のDeno executableはAbyssaeonの
  absolute pathに固定されている。
- `prepareRuntimeComposition()`はworkspace、instruction、skills、Definition、resource selection、
  manifestを解決・検証し、`materializePreparedRuntimeComposition()`がmodelとregistryを作る。
- OpenRouter credentialは各`generate()`でrequest validationとcancellation check後、fetch直前に解決される。
  startup readは0である。
- empty persistent sessionはclose時にdirectoryとlockを残さず、failed turnはcommitされない。
- Bash subprocessは`clearEnv: true`でcredentialを継承しない。
- Deno 2.9.4実機の`deno task --help`で上記`--quiet --config`構文を確認済み。

Revision 32で要求されたstartup credential readiness分類はRevision 33で削除された。固定verification
timingだけを表示し、startupからinput受付までcredential read 0 / provider fetch 0とするため、旧planning
stopは解消している。

## Scope

このincrementは次だけを追加する。

1. repository rootからのportable normal-TUI command
2. validated startup stateから一度だけ作るbounded secret-free display projection
3. task input前のstartup orientationとcurrent-action help
4. portable process/PTY、projection/rendering、startup lifecycle、permission topologyのoffline evidence
5. minimal user documentation、results、repository lifecycle更新

次は変更しない。

- Steps 82–84のeditor/history/file/session-navigation/daily-use/publish surface
- public Definition/catalog/loader、provider/model selector、login/credential UI
- manifest/replay/session schema、provider wire、tool registry、request budget
- hard sandboxまたはmanaged deployment
- dependency/lockfile、`_refs`、archive、sibling repository
- real provider/network/credential/production task
- commit、push、tag、publish、release

## Portable launch contract

### User command and support boundary

READMEの既存normal TUI導線へ、唯一のportable user commandとして次を記録する。

```text
deno task --quiet --config deno.v0.json agent:tui
```

既存の`--agent default|planner`、`--continue`、`--session <id>`、`--no-session`は同じ入口から
task引数として渡せる。前提は次のとおり。

- exact Deno 2.9.4が`PATH`上にある
- POSIX shell、real stdin/stdout TTY、repository rootから実行する
- defaultはnew autosave session
- default Agentの`bash`、`edit`、`write`はOS-user accessで動き、hard sandboxやper-tool
  confirmationはない
- credentialはstartupでは確認せず、各provider request直前に確認する
- taskを送らずempty Ctrl-Dで終了できる
- 全項目を一画面で読むsupport boundaryは80x24以上。狭いterminalではscrollbackまたはbounded
  truncationを許す

Step 83のroot README全面再構成は行わず、portable normal-TUI導線と前提だけを最小更新する。

### Launcher resolution and permissions

`session_launcher.sh`は次の順序を守る。

1. 現行argv/session modeをside-effect-freeに検証する。
2. persistent modeでは現行state rootを検証する。
3. launcher自身から`script_dir`と`repo_root`を解決する。
4. `command -v deno`でDenoを解決し、absolute regular executableでなければsanitized
   `startup_failure`にする。
5. resolved executableの`--version`を一回実行し、first lineがexact `deno 2.9.4`でなければ、
   raw path/version/errorを表示せず`startup_failure`にする。
6. 現行と同じ`--no-prompt --no-remote`、workspace/state read-write、OpenRouter host、
   credential env names、`/bin/bash` permissionで`exec`する。

version probeはcredential envを読まずnetworkを使わない。production child permissionは広げない。

- `--allow-env=HENJI_OPENROUTER_API_KEY,HENJI_SESSION_STATE_ROOT`
- `--allow-net=openrouter.ai`
- `--allow-read=<repo-root> --allow-write=<repo-root>`
- persistent modeだけexact state root read/write
- `--allow-run=/bin/bash`
- `--no-prompt --no-remote`

env permissionの付与はcredential readではなく、existing adapterのrequest-time lookupを維持する既存契約である。

### Deliberately unchanged paths

`agent:run`、historical/legacy/corpus/acceptance/sentinel task、credential-file launcher、pinned-Deno
focused tests、`v0:check` / `v0:fmt` / `v0:lint` / existing gate owner command、historical resultsの
command evidenceは一括変更しない。topologyは新しいportable entry/direct leavesだけにportable executableを
許し、それ以外のpinned ownershipを保持する。

## Runtime display state

### Owner and shape

new internal module `v0/agent/startup_orientation.ts`が`RuntimeDisplayState`とpure projectionを所有する。
stateは概念上、次だけを持つ。

```ts
interface RuntimeDisplayState {
  readonly workspace: string;
  readonly agentId: "default" | "planner";
  readonly model: {
    readonly provider: "openrouter";
    readonly profileId: string;
  };
  readonly sessionMode:
    | { readonly kind: "new" }
    | { readonly kind: "continue" }
    | { readonly kind: "exact" }
    | { readonly kind: "none" };
  readonly instructions: {
    readonly loaded: boolean;
    readonly source: "AGENTS.md" | "AGENTS.MD" | "none";
  };
  readonly skills: {
    readonly count: number;
    readonly names: readonly string[];
    readonly omitted: number;
  };
  readonly trust: {
    readonly hardSandbox: false;
    readonly osUserTools: readonly ("bash" | "edit" | "write")[];
  };
  readonly credentialVerification: "before_each_provider_request";
}
```

projectionは入力をdefensive snapshotし、nested object/arrayまでfreezeする。getter、function、credential
source、model、registry、workspace object、raw Definition/resource selection、instruction/skill本文を保持しない。
public config、serialization、provider payload、event、transcript、session record、manifest、replay envelopeには
露出しない。

### Construction order

`prepareRuntimeComposition()`のorderを次に固定する。

1. workspace resolve
2. workspace-root instruction snapshot discovery
3. project-local skill catalog discovery
4. selected built-in Definition evaluation
5. Definition/resource topology validation
6. resolved manifest construction、standalone validation、selection correlation
7. manifest成功後にdisplay stateをexactly once project
8. prepared compositionへstateを保持
9. nonpersistent pathはprepared compositionをmaterialize
10. persistent TUIはexisting store list/open/allocate/record validation後にmaterialize

manifest failureではdisplay projection、model/registry materialization、store operation、terminal acquisition、
renderingを0にする。projectionはmanifest identityを再生成せず、Definitionを再評価しない。

`PreparedRuntimeComposition`とmaterialized compositionは同じstate objectを保持する。normal CLIは
session mode `none`で同じprojectionを作るが表示せず、existing final-only outputを維持する。ephemeral TUIと
persistent TUIはfactory resultから同じstateを受け取り、rendererは再計算しない。common fieldsは同じprepared
inputで等しく、session modeだけinvocationに応じて異なる。

### Instruction, skills, workspace, trust

`agent_instructions.ts`へone-read source/text snapshotを追加する。`AGENTS.md`、`AGENTS.MD`の
first-present-wins、regular non-symlink、strict UTF-8、16 KiB、invalid silent-skipは変えない。runtimeは
snapshot textをexisting formatted instructionへ使い、displayにはsource nameだけを渡す。本文解析や二度目の
filesystem readは禁止する。

skillsはexisting frozen lexical catalogからcount、first 5 names、`omitted = count - names.length`だけを
保持する。description、directory、body、tool resultは含めない。

workspaceはcanonical/security/session/replay identityには使わないbounded display labelとする。

- rootは`/`
- それ以外は末尾2 path components、前方省略時は`…/`
- maximum 96 UTF-8 bytes
- overflowはwell-formed UTF-8 suffixとleading ellipsis
- NUL、C0/C1、bidi controlはfixed `workspace` fallback
- rendererでもterminal escapingを行う

trustはvalidated built-in topologyから固定projectionする。

- default: `hardSandbox=false`、`osUserTools=["bash","edit","write"]`
- planner: `hardSandbox=false`、`osUserTools=[]`

registry materializationからtool listを再発見しない。

credential fieldはexact literal `before_each_provider_request`だけとする。value、set/unset/empty/readiness、
source、env name、file/path、metadata、header、resolution errorを含めない。`openrouter_model.ts`の
credential resolutionは変更しない。

## Startup orientation and help

### Lifecycle order

TUI production pathは次を固定する。

1. argv/session grammar parse
2. built-in Agent selection
3. stdin/stdout TTY preflight
4. runtime prepare through manifest validation and display projection
5. persistent modeではstore list/open/allocate/record validation
6. model/registry/session materialization
7. controller construction and signal installation
8. terminal raw acquisition
9. orientation render
10. existing session ID line
11. resumed transcript render
12. controller run
13. first input acceptance

1–13完了までcredential read 0、provider fetch 0、tool execution 0。orientation write failureはexisting
`terminal_failure`へ入りsession closeとterminal restorationを行う。raw acquisition前はterminal controlを
出さず、acquisition後はexisting bracketed-paste/cursor/scroll-region/SGR/raw restorationを維持する。

turn commitなしのnew persistent sessionをorientation/input/exit/startup failureで閉じた場合、existing
empty-close cleanupでsession JSON、directory、lock、tempを残さない。

### Exact logical content

normal widthでは次の12 logical linesをexact orderで表示する。

```text
Henji Harness
workspace> <bounded workspace label>
agent> <default|planner>
model> openrouter / <profile-id>
session> <new (autosave)|continue newest|exact session|no session>
instructions> <none|./AGENTS.md|./AGENTS.MD>
skills> <count>: <first five names or none><optional " (+N more)">
credential> verified immediately before each provider request; not checked at startup
trust> <fixed agent-specific warning>
keys> Enter submit · busy Enter steer · busy Alt+Enter follow-up
keys> busy Esc cancel · busy Ctrl-C cancel+exit
keys> idle Ctrl-C twice within 500 ms exit · empty Ctrl-D exit
```

trust lineは次のいずれか。

```text
trust> NO HARD SANDBOX; bash/edit/write run with your OS-user access
trust> NO HARD SANDBOX; planner has no bash/edit/write
```

helpはcurrent submit、steer、follow-up、cancel、exitだけを示す。multiline/editor、history、file
picker/completion、queue recovery/multi-item queue、session picker/list/navigation、history inspection、
manual compaction、login/credential input、provider/model selectorは表示しない。

### Rendering bounds

`TuiRenderer`へstartup orientation renderingを追加し、dynamic valueはexisting
`escapeTerminalText()`を通す。

- stateのcanonical JSON相当 maximum 1,024 UTF-8 bytes
- workspace maximum 96 bytes
- skill names maximum 5
- rendered orientation maximum 2,048 UTF-8 bytes、exact 12 logical lines
- terminal columnsはvalid sizeを8–160へclamp、invalid sizeはexisting 80x24 fallback
- labelを保持してright sideをexisting cell-width logicでclipし末尾ellipsis
- row数でlineを省略・reorderしない。13未満はmain-screen scrollbackへ通常flowで書く
- alternate screen、resize listener、full redrawを追加しない

80x24 known answerではprovider/profile、credential policy、trust、key summaryをtruncateしない。

### Request-time credential failure

missing、空文字、credential source exceptionはstartupで分類しない。first task後に起きた場合もexisting
sanitized failure pathを維持する。

- provider fetch 0、tool dispatch 0、failed draft commit 0
- pending follow-up/steeringはexisting failure cleanupでdrop
- controllerは`agent_failure`としてrestore後exit 1
- credential value、presence、env name、source exception、stackを表示しない
- first-turn persistent sessionはclose時にghostを残さない
- retry、fallback、automatic rerun、credential setup UIを追加しない

## File responsibilities

| File | Responsibility |
|---|---|
| new `v0/agent/startup_orientation.ts` | frozen display-state type、bounds、projection |
| `v0/agent/agent_instructions.ts` | one-read instruction source/text snapshot |
| `v0/agent/runtime.ts` | manifest後single projectionとprepared/materialized propagation |
| `v0/agent/runtime_cli.ts` | shared no-session context、existing output維持 |
| `v0/agent/tui_cli.ts` | parsed session mode、factory state、startup order |
| `v0/tui/render.ts` | exact bounded orientation/help rendering |
| `v0/agent/session_launcher.sh` | PATH Deno resolution、exact version preflight、fixed permissions |
| `deno.v0.json` | portable direct leaves、check target、ordered gate enrollment |
| `README.md` | minimal portable commandとsupport/trust前提 |
| new `tests/v0/agent_startup_orientation_test.ts` | pure state/render known answersとnonleakage |
| new `tests/v0/portable_tui_launch_process_test.ts` | disposable-checkout real-PTY launch |
| relevant existing tests | ordering、failure、restoration、credential/session regressions |
| `tests/v0/offline_gate_topology_test.ts` | exact portable exception、ownership、permissions、mutations |
| results/lifecycle documents | requirement-to-evidence、counts、review、final state |

`controller.ts`、`input.ts`、session/manifest/replay modulesはbehavior change不要。evidenceが必要でも
product logicを変更しない。

## Direct tasks and topology

二つのdirect leavesを追加する。exact names/permissionsはimplementation時のactual dependency inspectionで
確定するが、計画上の上限は次とする。

```json
{
  "agent:startup-orientation:test": "deno test --no-prompt tests/v0/agent_startup_orientation_test.ts",
  "agent:portable-tui:process:test": "deno test --no-prompt --allow-read=.,/tmp --allow-write=/tmp --allow-run=/usr/bin/script tests/v0/portable_tui_launch_process_test.ts"
}
```

両taskをordered `v0:test`へexact once登録する。current 47 leaves / 49 direct filesから49 leaves /
51 direct filesになる見込みを、implementation時のactual inventoryとexact ownership assertionで確定する。

topology parserはこの二taskだけ、first token exact `deno`とexact flags/order/targetを許す。その他のleaf、
check/fmt/lint、composition ownerはcurrent pinned Deno tokenを要求する。次のmutationをrejectする。

- portable leafまたはlauncherへのhome/Abyssaeon/ai-dev path再混入
- portable leafをabsolute executableへ置換
- nonportable leafをambient `deno`へ置換
- extra env/read/write/run/net permission
- production/provider/credential task edge
- direct file omission、duplicate ownership、reorder、cycle

authoritative gateをai-devで実行するときだけ、installed Deno 2.9.4 directoryをそのprocessの`PATH`へ追加する。
repository task/source/documented commandへabsolute pathを保存しない。

## Required tests

### Display state and renderer

- default/planner、instruction none/`AGENTS.md`/`AGENTS.MD`、skills 0/2/5/6/24
- session new/continue/exact/none
- workspace root/short/deep/96-byte boundary/multibyte overflow/control fallback
- exact known-answer、recursive freeze、defensive snapshot、total bounds
- lexical first-five、omitted count、fixed trust and credential policy
- instruction/skill body、description/directory、absolute root、transcript、queue、tool result、
  provider object、credential marker non-exposure
- exact 80x24 default/planner output、79/80/160 columns、8-column minimum、size failure
- rows 8/12/13/24でline omissionなし、UTF-8/wide/combining clipping
- ESC/C0/C1/bidi/newline/tab escaping、orientation byte bound
- current actionsの存在、idle Ctrl-Cのsecond press within 500 msというexact timing、Steps 82–83 actionの不在

### Runtime, instruction, and skills

- instruction/skills/Definition evaluationとdisplay projection各exactly once
- Definition/resource/manifest validation後、materialization前のprojection
- invalid Definition/resource/manifestでprojection/model/registry/credential/fetch/store/terminal 0
- prepared→materializedでstate identity維持、CLI/TUI common fields一致
- instruction source/textがsame filesystem pass、first-present-winsとinvalid/symlink/size/UTF-8契約不変
- skill discovery bounds/order/disabled reservation/manifest/tool behavior不変、display reread 0
- startup credential read 0/fetch 0
- requestごとのreread、resolution前cancel read 0
- missing/empty/throwでfetch 0、credential marker non-exposure

### TUI/session lifecycle

- all four session modes
- prepare→store→materialize→acquire→orientation→replay→input
- orientationより前のinput read 0
- orientation/output/startup failure、no-turn Ctrl-D、double Ctrl-C、SIGINT/SIGTERM/SIGHUPのrestore
- first-turn credential failureでfetch/tool/commit 0、empty session artifacts 0
- resumed record unchanged、successful commit/replay unchanged
- steering/follow-up/cancel settlement unchanged
- fixture factoryにもstateを必須化し、TUI recomputation seamを作らない

### Portable process/PTY

new testは`/tmp`へtracked `deno.v0.json`と必要なtreeをcopyし、test processの`Deno.execPath()`を
temporary absolute `PATH` directoryの`deno`として参照する。`/usr/bin/script`配下のreal PTYで次を実行する。

```text
deno task --quiet --config deno.v0.json agent:tui --no-session
```

credential envをunsetしtaskをsubmitせず、orientationとprompt後にempty Ctrl-Dで終了する。

- exact version preflight、orientation-before-prompt、help、normal exit 0
- credential absentでもstartup/input受付へ到達
- provider/model request、tool call、session write、credential read 0
- terminal restore exact once、timeout/overflowなし、temp cleanup
- documented command、`agent:tui` task value、launcher、そのreachable production sourceにforbidden
  checkout markerなし。unchanged task valuesを含む`deno.v0.json`全体にはこのassertionを適用しない
- missing executable、wrong version、probe failureはsanitized startup failure、TUI child/network/credential 0

### Regression and owner gate

instructions、skills、Definition selection/Definition、manifest、comparison variant、replay、fresh comparison、
runtime direct/process、planner delegation、session/store/process/TUI、cancellation、streaming、tool progress、
steering、context、work tools、TUI direct/process/topology、offline topologyをrerunする。Bash credential
noninheritanceを維持する。最後にrepository-defined`v0:check`、`v0:fmt`、`v0:lint`、`v0:test`、
`v0:gate`、`git diff --check`を実行する。

local gateはcredential env unsetまたはtest-only dummy sourceだけを使い、real credential/provider/network/
production taskを使わない。

## Ordered implementation

1. pure display state、bounds、permission-free known answers
2. instruction one-read source/text snapshotとregressions
3. manifest-success後のruntime single projection、CLI/TUI propagation、credential read 0
4. bounded rendererと80x24/narrow/injection known answers
5. TUI startup order、session modes、orientation-before-input、restoration
6. launcher PATH/exact-version preflightとREADME minimal documentation
7. disposable-checkout PTY leaf
8. task/check/gate/topology ownershipとmutations
9. focused regressions、check/fmt/lint/direct/full offline gate、diff check
10. results/lifecycle更新、bounded independent review
11. approved finding closureがあれば一回、narrow re-review、owner final gate

## Completion evidence and acceptance

resultsは成功条件ごとにportable command/support boundary、launcher version/permission、display known answers/
bounds、single construction、CLI/TUI correlation、credential read/fetch 0、per-request reread/cancel/missing/
empty/throw、commit/ghost 0、orientation/help bytes、terminal restoration、schema/provider-wire no-change、
focused/full counts、topology inventory、review/final disposition、deviation/rollback/residual risk、external
operation zeroを記録する。

完了条件はrequired focused suites、`v0:check`、`v0:fmt`、`v0:lint`、authoritative `v0:gate`、
`git diff --check`がgreenで、independent reviewとowner final dispositionがBlocker/P1/P2 0であること。

offline gateとreview GO後のrepresentative human acceptanceは別の明示Human Gateとする。一回だけ、
clean/disposable checkout相当、exact Deno 2.9.4 on `PATH`、credential env unset、disposable state rootで
documented commandを起動し、taskをsubmitせずorientationを読み、empty Ctrl-Dで終了する。terminal
restoration、session ghost 0、provider/network request、credential read、tool execution、retry/rerun 0を確認する。
これはprovider acceptanceではない。

## Rollback and residual risks

rollbackはstartup orientation module/runtime propagation、instruction snapshot、renderer/TUI wiring、launcher、
README、portable leaves/topology、tests/results/lifecycleを一incrementとして戻す。session/persistent data
migrationやcleanupは不要で、test temporary stateだけをfinallyで削除する。

residual risk:

- exact Deno 2.9.4以外はunsupported、PATH misconfigurationはstartup failure
- 80x24未満ではscrollbackまたはbounded truncation
- credential readinessは表示せず、failureは最初のprovider requestで判明
- Bashは引き続きOS-user executionでhard sandbox/complete descendant containmentはない
- same-user race、directory fsync、broader sandbox hardeningは本incrementの対象外

## Pi/Zot boundary

Piから採用するのは一貫したruntime-state projectionとcompact startup orientationというcontractだけである。
Pi Agent class/API、telemetry、hooks、custom message、provider/model selector、extension/package systemは
採用しない。Zotはsmall integrationのcomparison evidenceに留める。HenjiのDefinition、resource/manifest、
replay ownershipを維持する。

## Stop conditions and Human Gate

次が必要になった場合は停止してoperations/user判断へ戻す。

- startupでcredential value、presence、path、metadataを読む
- request-time/per-request resolutionまたはcancel-before-readを変更する
- provider/network/real taskなしでacceptanceできない
- dependency、installer、publish、global configurationが必要
- Definition/resource/manifest/replay identity、session schema/migrationを変更する
- Step 82–84のsurfaceが必要
- portable direct gateがcheckout外固定pathなしで成立しない
- permission envelopeを現行以上に広げる
- Why/What、成功条件、trust boundaryを変更する

初期implementation Human Gateが許可するのは、上記file scopeのlocal implementation、disposable offline
tests、task/topology、README最小更新、results/lifecycle、bounded reviewだけである。provider、network、
credential、production command、actual persistent product state、dependency/lockfile、`_refs`、commit、
push、tag、publish、releaseは別の明示承認を要する。
