# Step 83 continuation: full-capability human acceptance

Status: **Human Gate 2 pending; implementation not authorized**

## Recommendation

Step 83Rのneutral presentation boundary、core-owned adapter、immutable retained state/layout、
三領域renderer、typed controller、overlay/resize/scroll契約を保持し、本人がproduction UXを判断する
ために不足している次の四点だけを一つのbounded continuationとして追加する。

1. bare `henji`を任意workspaceから起動し、caller cwdをtool/session workspaceとして保持する。
2. 固定repo-external credential fileをprovider requestごとに検証して読むproduction sourceを接続する。
3. F1を内部metadata dumpからtask-orientedな人間向けhelpへ置き換える。
4. fake hostを使わず、default Agent、実provider、full work tools、persistent sessionを一度に使う
   final Human Gate packageを準備する。

Human Gate 2承認後はlocal implementation、offline test、review、単一finding closure、owner gate、
machine launcher install/readbackまで自律的に進める。credential value read、provider/network、production
TUI、actual acceptance workspace/session作成は、統合候補完成後の別の明示承認まで行わない。

## Planning base

- Canonical input: `/tmp/planner-inputs/henji-step-83-full-capability-human-acceptance.md`
- Input SHA-256: `8334eb6e567b6fd527d76bedee8322110c2eae5637b72abfd450368e8f23f600`
- Concept revision: 39
- Roadmap step: 83-continuation
- Base: `main` / `d2cba6b2504b67d7ef79ef587d388d58e42920cd`
- Step 83R plan: `docs/plans/detached-three-band-human-ui.md`
- Step 83R plan SHA-256: `17fc9d71afa3c8ba818bd4aa9a65c09736abaed2647e467943b2dfca20bd9568`
- Step 83R results: `docs/plans/detached-three-band-human-ui-results.md`
- Step 83R results SHA-256: `fe5cdd4c888b609cbe1adcee1fb5504e31a35ee2e66d059f9b74290ebaef7598`
- Baseline: authoritative `v0:gate` 703/703、topology 2/2、check/fmt/lint/diff green、
  review Blocker/P1/P2 zero
- Machine entry: `/home/masat.guest/.local/bin/henji`
- Current machine entry SHA-256: `33adeae91697778d5c648d948a2df50ff2d6476aa72b9fdf29ac3fe8437f1c12`
- Fixed Deno: `/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno`
- Fixed credential path: `/home/masat.guest/.config/henji-harness/openrouter-api-key`

Tracked treeはcleanで、user-owned untracked `_refs/*`だけが存在する。planningではcredential value、
provider/network、production command、actual persistent state、machine entryを操作していない。

## Keep / change / remove

| 項目 | 扱い | 契約 |
|---|---|---|
| `v0/presentation/contract.ts` | Keep | credential path/presence/resolverを追加しない |
| `v0/agent/tui_presentation_adapter.ts` | Keep | sanitization、opaque identity、typed authorityを維持 |
| `v0/tui/state.ts` / `layout.ts` | Keep | immutable retained state、三領域、source anchorを維持 |
| retained `render.ts` | Keep + narrow change | state modelは保持し、F1のbounded textだけを変更 |
| typed controller | Keep | F1 open/dismissとbase-state復帰を維持。core side effectを追加しない |
| session/context/cancel/stream/tool/restore | Keep | schema、commit、admission、cleanup precedence不変 |
| default registry | Keep | read/write/edit/bash/submit/delegateを保持 |
| fake acceptance | Keep as regression | mechanical evidenceのみ。本人受入には使用しない |
| machine wrapperの`cd "$repo"` | Remove | caller workspaceを失うため |
| production TUIのcredential env依存 | Change | fixed fileのrequest-time sourceへ置換。headless CLI不変 |
| F1 metadata/key dump | Change | task-oriented helpへ置換 |
| fake final Human Gate | Remove | production `henji`だけを本人受入に使う |

Step 83Rの機械契約は成立しており、失敗したのはF1の情報設計とfake acceptanceの判断可能性である。
UI/core分離やretained rendererの全面再設計は行わない。

## Target architecture and responsibility

```text
installed /home/masat.guest/.local/bin/henji
  └─ repo-owned canonical wrapperのbyte-identical copy
       ├─ caller cwdを変更しない
       ├─ fixed repo / Deno / config / launcherを検証
       └─ all argvをrepo session launcherへforward
                         │
                         ▼
v0/agent/session_launcher.sh
  ├─ argv/state/workspace preflight
  ├─ absolute repo source/configを使用
  ├─ workspace/state/credentialのexact Deno permissions
  └─ process cwdはinvocation workspaceのまま
                         │
                         ▼
v0/agent/tui_cli.ts ── host credential source ──► v0/agent/credential_file.ts
  │                                                ├─ fixed path
  │                                                ├─ metadata/opened-file validation
  ▼                                                └─ one synchronous read per request
runtime parent / lazy planner
  └─ cancellation → admission → credential read → cancellation recheck → fetch
                         │
                         ▼
presentation adapter → retained TUI
  credential value/path/presenceは到達しない
```

Import invariants:

- credential moduleはagent/core側に置き、`v0/tui/`からimportしない。
- TUIはprovider、credential、runtime、store implementationをimportしない。
- neutral contractへfile path、credential presence、resolverを追加しない。
- F1は既存sanitized projectionとUI-local stateだけから作る。
- `tui_cli.ts`だけがproduction host sourceとTUIをcomposeする。
- headless `runtime_cli.ts`へTUI/helpのtransitive edgeを追加しない。

## Arbitrary-workspace launch contract

### Canonical machine wrapper

新しいrepo-owned sourceを `v0/agent/henji_machine_launcher.sh` に置く。

- fixed repo、Deno 2.9.4、config、session launcherをsanitizedに検証する。
- caller cwdを保存するための`cd`を行わない。
- fixed Deno directoryをchild PATHの先頭へ置くが、credential envを設定しない。
- absolute session launcherへall argvをそのままforwardし、exit/signal statusを保持する。
- errorへrepo/Deno/credential pathやraw child errorを出さない。

`session_launcher.sh`はphysical cwdを取得し、absolute regular directoryかつDeno permissionで表現可能
（comma/LF/CRなし）であることをside-effect前に検証する。cwdは変更しない。runtimeが得るcanonical
workspaceとpermission rootを一致させる。

Production Deno permissions:

- read: exact repo root、physical workspace、fixed credential file
- write: physical workspace
- persistent modeのみread/write: exact state root
- env: persistent modeの`HENJI_SESSION_STATE_ROOT`だけ
- sys: `uid`
- net: `openrouter.ai`
- run: `/bin/bash`

`HENJI_OPENROUTER_API_KEY`はnormal TUIのallow-envから除く。`--no-session`ではstate env/read/writeを
付けない。別workspaceからrepo sourceへのwrite permissionを付けない。

### Install / check / rollback

`v0/agent/install_henji_machine_launcher.sh`をrepo-owned管理入口とし、exact
`check | install | rollback`だけを受ける。

- `check`: canonical sourceとmachine entryのbytes、regular non-symlink、owner、0755を検証。
- `install`: fixed target parent/sourceを検証する。既存targetを動かさず、そのbytesをsame-directory
  backup tempへcopyし、close/chmod/readback後にfixed backup
  `henji.pre-step83-continuation`へatomic renameする。既存backupは上書きしない。その後canonical
  candidateを別のsame-directory tempへwrite、close/chmod/readbackし、最後の一回のatomic renameでtargetを
  replacementする。backup作成失敗は旧targetを保持し、candidate replacement失敗も旧targetを保持する。
- `rollback`: fixed backupだけを検証してatomicに戻し、candidateをrecovery nameへ保全する。
- arbitrary source/destination、profile編集、PATH編集、sudo、global installは持たせない。

Tests/review green前にmachine `install`を実行しない。Human Gate 2は一回のinstall/check/readbackと必要時
rollbackを承認対象に含む。install後もproduction `henji`はfinal Human Gateまで起動しない。

Installer testsはopen/write/short-write/close/chmod、backup temp rename、candidate target rename、readbackの
各failureを注入し、全地点でtargetに旧entryまたは完全な新entryのどちらか一方がregular non-symlink 0755で
残ることを固定する。backup/recovery tempのbounded cleanup failureはsanitizedに報告し、targetを消さない。

## Request-time credential file contract

新しい `v0/agent/credential_file.ts`へ既存credential launcherの検証済み規則を共通化する。

- fixed path: `/home/masat.guest/.config/henji-harness/openrouter-api-key`
- maximum: 4,096 bytes
- regular file、non-symlink、effective UID owner、exact 0600、size 1..4096
- strict UTF-8
- terminal LFまたはcomplete CRLF列だけをstrip
- empty-after-strip、embedded LF/CR、NUL/control、Unicode whitespace、oversizeをreject

各provider requestで一回だけ次を行う。

1. effective UID取得
2. fixed path `lstat`
3. metadata検証
4. read-only open
5. opened metadataを再検証し、sizeと利用可能なdev/inode identityを照合
6. 4,097-byte ceilingでEOFまでread
7. short/extra/zero-progress異常をreject
8. 必ずcloseし、close failureも失敗扱い
9. close後にstrict decode/parseし、そのrequestのAuthorization header作成にだけ使用

値はmodule/runtime/presentation/session/manifestへcacheしない。同一sessionでもrequestごとに再openし、file
更新は次requestから反映する。既存live/sentinel launcherはshared parser/metadata contractをreuseして外部挙動を
変えない。one-shot secret-in-environment childをnormal TUIへ流用しない。

Runtimeはoffline seamとは別のfirst-class host credential sourceを受け、production TUIだけがfile sourceを渡す。
Normal TUIはenv fallbackへ到達しない。headless `agent:run`と既存sentinelは現契約を維持する。

Lifecycle order:

```text
request budget claim
→ request encoding/bounds
→ cancellation check
→ credential source
→ cancellation recheck
→ fetch count / fetch
```

これによりstartup/F1/navigation/history、budget rejection、source前cancelはread 0。missing/invalid/read/close
failureはfetch 0、successful commit 0。planner childもrequestごとに同じsourceを使う。raw error/path/valueは固定
sanitized provider errorへ畳む。

`bash`は既存のclear environmentを維持しcredential name/valueを渡さない。ただしBashはhard sandboxではなく
OS-user authorityを持つ。workspace外へ自発的に到達し得る点をhelpとHuman Gateで明示し、final taskはworkspace
内だけに限定する。

## Task-oriented F1 help

F1は既存modal経路を使い、F1またはEscで閉じる。新しいcore intentは追加しない。表示順を固定する。

1. `Henji help — F1 または Esc で作業画面へ戻る`
2. 作業を頼む: 下の`>`へ入力しEnter。Ctrl-Oで改行
3. 作業を見る: logに依頼、assistant途中経過、tool、結果、finalが順に出る
4. 実行中に伝える: Enterで一件steer、Alt+Enterで一件follow-up
5. 止める: 実行中Escでcancel、Ctrl-C二回でsettlement後exit。completed effectは自動rollbackされない
6. 終了と再開: 空入力Ctrl-D。同じdirectoryで`henji --continue`
7. session/history/context: Ctrl-G / Ctrl-T / Ctrl-K
8. default capability: workspace read/create/edit、Bash verification、必要時planner相談
9. trust: trusted-local。tools/BashはOS user権限で動きworkspace外/networkへ到達し得る
10. 現在: bounded workspace label、agent、session mode、committed turn

Model profile、skill manifest、instruction source、credential presence/pathは主helpから外す。finite templateとsanitized
factsだけを使い、80x24とnarrow/resizeでboundedにする。「入力」「止める」「再開」「trusted-local」を優先する。
新しいscrollable help subsystemは作らない。

F1 round tripでdraft、cursor、history position、log、source anchor/follow/new-below、pending metadata、projection、
lifecycle、footer/status、terminal cursorを保持する。F1/resize/dismissはsubmit、provider request、credential read、
session/context write 0。

## Full-capability final Human Gate package

`docs/plans/step-83-full-capability-human-acceptance-gate.md`へexact packageを記載する。READMEはbare
`henji`とtrusted-local警告への短い入口だけを持つ。fake launcherはpackageから参照しない。

### Workspace setup and launch

```sh
umask 077
henji_accept_workspace=/tmp/henji-step83-full-capability-acceptance
henji_accept_expected=/tmp/henji-step83-full-capability-expected
[ ! -e "$henji_accept_workspace" ]
[ ! -e "$henji_accept_expected" ]
mkdir -- "$henji_accept_workspace"
printf '%s\n' \
  'Project: Henji acceptance' \
  'Owner: Masato' \
  'Status: draft' \
  > "$henji_accept_workspace/request.txt"
cd -- "$henji_accept_workspace"
test "$(pwd -P)" = "$henji_accept_workspace"
test "$(command -v henji)" = /home/masat.guest/.local/bin/henji
henji
```

Startup workspaceが専用workspaceでなければ停止する。F1を一度開き、入力、実行表示、停止、再開、default
capabilities、trusted-local authorityを理解できるか観測して閉じる。

### Turn 1

```text
このworkspace内だけで作業してください。request.txtを読み、その内容からacceptance-note.mdを新規作成してください。文書は「# Henji acceptance」「Owner: Masato」「Status: draft」「Check: pending」の4行にします。作成後にそのfileを読み返し、「Status: draft」だけを「Status: READY」へ編集し、Bashで4行がその順序・完全一致であることを検証してください。必要ならplannerに相談して構いません。行ったことと検証結果を短く報告してください。workspace外は変更しないでください。
```

Expected settled file:

```text
# Henji acceptance
Owner: Masato
Status: READY
Check: pending
```

Exact tool sequenceはoracleにしない。meaningful read/create/edit、Bash verification、tool result、assistant finalと
file stateの対応を見る。planner delegationはoptional。Bashだけで全操作を代替しwrite/edit UXを観測できない場合は
retryせずnamed blocker候補として記録する。

### Turn 2 follow-up

```text
同じacceptance-note.mdの「Check: pending」だけを「Check: passed」へ変更し、Bashでもう一度4行の完全一致を確認してください。ほかのfileや行は変更せず、結果を短く報告してください。
```

Expected fileは`Check: passed`。successful final後、empty editor/pendingを確認しCtrl-Dで正常終了する。

### Continue and Turn 3

```sh
cd -- /tmp/henji-step83-full-capability-acceptance
henji --continue
```

同じdefault agent/session/workspaceと前二turnの復元を確認し、次を入力する。

```text
前の作業を続けます。acceptance-note.mdを読み、末尾へ新しい1行「Resumed: yes」を追加してください。Bashで全5行が順序・完全一致であることを確認し、再開前の作業を引き継げたか短く報告してください。workspace外は変更しないでください。
```

Expected final file:

```text
# Henji acceptance
Owner: Masato
Status: READY
Check: passed
Resumed: yes
```

Successful final後、empty editorでCtrl-Dし正常終了する。

### Assertions and cleanup

固定expected fileを作り`diff -u`する。workspace top-level entriesはexactly
`acceptance-note.md`と`request.txt`でなければ停止する。`session_cli_launcher.sh`はproduction launcherと同じ
physical-cwd validationを行い、session CLIへcaller workspaceのread-only permission、state rootのread/write、
`HENJI_SESSION_STATE_ROOT`だけを付与する。provider/net/credential/Bash permissionは持たない。

Acceptance workspaceから次を実行する。

```sh
cd -- /tmp/henji-step83-full-capability-acceptance
/home/masat.guest/src/henji-harness/v0/agent/session_cli_launcher.sh list
```

JSONのworkspace identityとmetadataからこのwork periodのfull UUIDを一つだけ同定する。zero、複数、別workspace、
invalid JSONなら停止する。本人が出力から確認したexact値だけを`<SESSION_UUID>`へ置換して実行する。

```sh
cd -- /tmp/henji-step83-full-capability-acceptance
/home/masat.guest/src/henji-harness/v0/agent/session_cli_launcher.sh delete --session <SESSION_UUID> --yes
/home/masat.guest/src/henji-harness/v0/agent/session_cli_launcher.sh list
```

削除後のlistに同UUIDが残る、lock/tempが残る、または別sessionへ影響した場合は停止し、workspaceを消さない。
このexact list→delete→re-listはdisposable state rootとexternal cwdのprocess testで固定する。

Cleanupは観測記録後だけ行う。fixed two pathsをliteral equalityでguardし、`/tmp`へ移動後にworkspace treeとexpected
fileを削除して不存在を確認する。diagnosisが必要なら保持し、retry/rerunしない。

## Ordered implementation slices

### A. Launcher and workspace authority

Files:

- new `v0/agent/henji_machine_launcher.sh`
- new `v0/agent/install_henji_machine_launcher.sh`
- modify `v0/agent/session_launcher.sh`, `v0/agent/session_cli_launcher.sh`, `deno.v0.json`
- new `tests/v0/henji_machine_launcher_process_test.ts`
- modify portable/session process and TUI/session topology tests

Evidence: two arbitrary cwd identities、absolute source/config、new/continue/exact/no-session/agent forwarding、invalid
argv pre-effect rejection、cwd canonicalization、workspace partition、empty reservation cleanup、external cwdでの
session list/exact delete/re-list、drift/install/rollback、各install failureで旧または新entryの常時存在、exit/signal
forwarding。Session management topologyはworkspace read-only/state read-writeだけでprovider/net/credential/run 0を
固定する。Testsはcopied launcher/fake Denoだけを使いactual machine entryを変更しない。

### B. Credential source

Files:

- new `v0/agent/credential_file.ts`
- modify live credential launcher、runtime、TUI composition、session launcher
- new credential direct tests
- modify transport/runtime/cancellation/work-tools/session/topology tests

Evidence: metadata/opened identity/content matrix、startup/read-zero、failure fetch/commit-zero、two-request refresh、
parent/child per-request reads、all leakage surfaces negative、Bash env negative、normal TUI env permission removal、headless
and sentinel compatibility。

### C. Task-oriented F1

Files:

- modify `v0/tui/render.ts`
- only if required, narrow layout/state changes
- modify render/layout/state/controller/startup/PTY tests

Evidence: required topics、plain language、default/planner capability accuracy、80x24/narrow/resize/multibyte/control/bidi、
exact overlay round trip、all side effects zero、terminal/frame bounds。

### D. Acceptance package and docs

Files:

- new gate/results documents
- modify README and task/check inventories
- lifecycle documents only after final local evidence

Package known-answer test rejects fake task/fixture references and fixes workspace、three tasks、continue、assertions、cleanup、
48-request ceiling、no-retry rule。Human Gateはoffline taskに登録しない。

### E. Verification, review, install

Run focused launcher/topology、credential/runtime/transport/cancel/session/work-tools、presentation/TUI/PTY、persistent
session/navigation/context/stream/tool suites、then offline topology、check、fmt、lint、diff check、authoritative `v0:gate`。

New credential direct testはfilesystem/fetch seamsでpermission-free。Launcher process testはcopied wrapper/fake Denoを
`/tmp`で使い、PTYはexisting `/usr/bin/script`だけを許可。Offline gateへnetwork、live credential、machine entry、
production `henji`、Human Gate taskを入れない。

Initial reviewは30分上限でBlocker/P1/P2、secret lifecycle、workspace authority、permissions、reverse imports、session
commit、terminal settlement、fake回避を確認する。Plan-scoped findingは一回のclosure、15分以内の一回narrow
re-review。Ownerがaffected suitesとfull gateを再実行しBlocker/P1/P2 zeroを確認する。

その後だけinstallerでmachine entryを一回更新し、check/metadata/hash readbackする。production entryは起動しない。
Driftならfixed backupへrollbackし、候補完成扱いにしない。

## Test matrix

| Area | Required observation |
|---|---|
| Machine entry | arbitrary cwd、repo resolution、argv/status、drift/install/rollback |
| Workspace | tool root、session partition、new/continue/exact/no-session/agent |
| Credential metadata | owner/mode/type/symlink/size/dev/inode/open/read/close |
| Credential lifecycle | startup/cancel read 0、failure fetch/commit 0、per-request refresh |
| Leakage | projection/event/help/footer/error/session/context/manifest/replay/subprocess zero |
| Capability | production default exact registry。acceptanceだけ縮小しない |
| Help | task-oriented topics、bounds、resize、round-trip、side effects zero |
| UI boundary | Step 83R contract/adapter/state/layout/controller/render/topology |
| Acceptance package | production command、natural tasks、file states、continue、cleanup、bounds |
| Regression | session/context/cancel/stream/tool/runtime/PTY/topology/full gate |

## Rollback

- Repository: continuationのlauncher、credential source、help、tests/tasks/docs/lifecycleだけをrevert。Step 83Rと
  session/context dataは戻さない。
- Machine entry: repo-owned rollbackでfixed backupを戻し、旧SHA、0755、owner metadataをreadback。
- Credential: fileは変更しないためmigration/rollbackなし。
- Session schema: 変更なし。
- Human Gate artifacts: exact session deleteとfixed `/tmp` pathsだけをcleanup。
- Human Gate不成立: Step 83R全体を自動rollbackしない。観測を記録しconcept ownerへ返す。

## Requirements to evidence

| Success condition | Local evidence | Final Human Gate |
|---|---|---|
| 1 arbitrary cwd bare launch | copied wrapper process/workspace tests | fixed `/tmp`からbare `henji` |
| 2 session modes/authority | session process/store/topology | exit、continue、same history/file |
| 3 credential security | parser/runtime/transport/cancel/leakage | first real requests、secret非表示 |
| 4 Step 83R preservation | presentation/boundary/retained tests | same three-band UI |
| 5 useful F1 | topic/bounds/round-trip tests | 本人理解 |
| 6 real provider/full tools | fake-provider production registry tests | actual file/tool/meaningful final |
| 7 follow-up/restart | commit/replay/process tests | Turn 2/3 and final file |
| 8 one work period | package known-answer | no intermediate approval、one decision |
| 9 no regression | focused/review/full gate | restore/cleanup |
| 10 adoption decision | never substituted by tests | three-way judgment and reason |

## Planner / implementer discretion

Allowed: helper/type names、installer temp suffix、help punctuation/wrapping while preserving required topics/priority、focused
test split/task names、results layout。

Not discretionary: capability reduction、delegation forcing、fake acceptance、credential path/validation、request/step ceiling、
session schema/provider/hard sandbox/per-tool confirmation、Step 83R redesign、final tasks/file/judgment semantics。

## Exclusions

No new TUI framework/dependency、public installer/package/profile/global install、provider selector/login/credential editor/cost
UI、hard sandbox/container/confirmation、session tree/schema migration、rich UI、`_refs` work、production repo acceptance、
credential value inspection、push/tag/publish/release。

## Concept-review stop conditions

Stop and return evidence if caller cwd requires changing session authority; absolute launch cannot work; request-time source
requires startup retention/env injection; credential validation requires broad home read/value inspection; full registry cannot be
kept; F1 requires reverse import/provider coupling; schema/dependency/provider contract changes; offline proof requires live
credential/network; final task requires external/destructive or exact-tool oracle; one bounded closure cannot reach zero; current
model/API availability is not verified before final gate; or a 48-request worst-case cost ceiling cannot be presented.

## Human Gates

### Human Gate 2: implementation approval

Approves the bounded repository implementation/tests/docs、offline gate、review/one closure/re-review、and one machine-local
launcher install/check/readback/necessary rollback. It does not approve credential value read、provider/network、production
`henji`、acceptance workspace/session、final Human Gate、commit/push/tag/release。

**Stop after presenting this plan. Do not implement before explicit approval.**

### Final full-capability Human Gate: separate approval

The approval package must repeat exact workspace/commands/tasks and disclose credential/provider/network/write/edit/Bash/session
state authority. Bounds:

- parent max steps 8
- planner child max steps 8
- aggregate requests per accepted turn 16
- accepted user turns exactly 3
- total external/model requests maximum 48
- planner execution at most once per turn
- application retry/fallback/rerun/additional follow-up 0
- context compaction 0

Immediately before approval, verify official current model/API availability and official pricing, then present a 48-request
worst-case cost ceiling. Stop without retry on launcher drift、workspace/agent/session mismatch、secret/path/raw payload display、
workspace-external/destructive activity、credential/provider/contract failure、bound reached、turn failure/cancel/uncommitted
result、unexpected turn、tool/file mismatch、terminal restoration failure、lock/temp residue、wrong continue target、file assertion
failure、or inability of the user to judge safety/meaning/state。

On stop, preserve workspace/session for diagnosis and record the observation. The user makes one final decision only:
`採用可能`、`方向は有望だがnamed blockerあり`、or `不採用`, with reason.
