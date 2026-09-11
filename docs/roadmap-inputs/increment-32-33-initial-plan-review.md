# Increment 32/33 当初計画と第三者review

ステータス: **当初案・初回reviewの履歴 — 現行計画ではない**

作成日: 2026-09-11

照合基準commit: `fb8e04a0`

## この文書の目的

Self-revision Cycle 1前段として検討しているIncrement 32とIncrement
33について、review前の当初案、
第三者reviewのfinding、findingを受けた修正推奨案を分けて保存する。利用者が計画をじっくり確認し、
未決事項を判断するための検討資料である。

この文書は、承認済みincrementの要件または実装許可ではない。利用者が計画を承認した後、採用内容を
`docs/increments/increment-32.md`と`docs/increments/increment-33.md`へ分けて正本化する。

その後に確定した利用者判断と追加reviewを反映した現行案は、
[`increment-32-34-externalization-concept-plan.md`](increment-32-34-externalization-concept-plan.md)にある。
特に本資料3章のlegacy migration推奨と4章の判断待ちは現行案ではなく、比較用の履歴として残している。

## 参照した正本とactive source

- [`../architecture/henji-host-agent-worker.md`](../architecture/henji-host-agent-worker.md)
- [`../roadmap.md`](../roadmap.md)の「Self-revision Cycle 1前段 —
  配布とDefinition revision基盤」
- [`../../v0/agent/session_launcher.sh`](../../v0/agent/session_launcher.sh)
- [`../../v0/agent/runtime_cli_launcher.sh`](../../v0/agent/runtime_cli_launcher.sh)
- [`../../v0/agent/henji_machine_launcher.sh`](../../v0/agent/henji_machine_launcher.sh)
- [`../../v0/agent/session/session_store_paths.ts`](../../v0/agent/session/session_store_paths.ts)
- [`../../v0/agent/session/session_store_contract.ts`](../../v0/agent/session/session_store_contract.ts)
- [`../../v0/agent/worker/worker_definition_revision.ts`](../../v0/agent/worker/worker_definition_revision.ts)
- [`../../v0/agent/worker/worker_tui_session.ts`](../../v0/agent/worker/worker_tui_session.ts)
- [`../../v0/agent/worker/worker_bootstrap.ts`](../../v0/agent/worker/worker_bootstrap.ts)
- [`../../v0/agent/worker/worker_capsule.ts`](../../v0/agent/worker/worker_capsule.ts)
- [`../../v0/agent/worker/worker_host_session.ts`](../../v0/agent/worker/worker_host_session.ts)
- [`../../v0/agent/cli/tui_cli.ts`](../../v0/agent/cli/tui_cli.ts)
- [`../../v0/agent/cli/runtime_cli.ts`](../../v0/agent/cli/runtime_cli.ts)
- [`../../v0/agent/provider/credential_file.ts`](../../v0/agent/provider/credential_file.ts)
- [`../../deno.v0.json`](../../deno.v0.json)

外部仕様の確認先:

- [Deno compile](https://docs.deno.com/runtime/reference/cli/compile/)
- [Deno permissions](https://docs.deno.com/runtime/reference/permissions/)
- [Deno security and permissions](https://docs.deno.com/runtime/fundamentals/security/)
- [XDG Base Directory Specification](https://specifications.freedesktop.org/basedir/0.8/)
- [denoland/deno_graph](https://github.com/denoland/deno_graph)

---

## 1. Review前の当初案

### 1.1 Incrementの分割

- Increment 32: Henji本体をstandalone binary化し、embedded
  resourceと外部stateの境界および path authorityを確立する。
- Increment 33: 外部Agent Definitionをimmutableなmodule
  revisionとして登録、参照、実行する。

Increment 32でimmutableなcore/runtime artifactを成立させ、Increment
33は完成したbinary境界の上へ 書換可能なDefinition revision storeを追加する。

### 1.2 binaryに埋め込むresourceと外部に置くstate

| 分類                     | 内容                                                                                                                                                                                             | 配置                                                                                         |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| binary embedded resource | CLI router、TUI、Host、Worker bootstrap、protocol、core loop、built-in default/planner Definition、built-in instruction/tool/provider/model catalog、`@henji/agent` API、build resource manifest | 単一の`henji` executable内                                                                   |
| config                   | OpenRouter/OpenAI credential、将来の利用者設定                                                                                                                                                   | `$XDG_CONFIG_HOME/henji-harness/`。未設定時`$HOME/.config/henji-harness/`                    |
| managed data             | 登録したAgent Definitionのimmutable closure、revision metadata、provenance                                                                                                                       | `$XDG_DATA_HOME/henji-harness/modules/`。未設定時`$HOME/.local/share/henji-harness/modules/` |
| runtime state            | Session、context checkpoint、provider evidence、failure diagnostic、execution artifact、history export、lock                                                                                     | 現行どおり`$XDG_STATE_HOME/henji-harness/`。未設定時`$HOME/.local/state/henji-harness/`      |
| workspace input          | `AGENTS.md`、`.agents/skills`等、toolが読む・変更するfile                                                                                                                                        | 起動時のworkspace。binaryにもmodule storeにも複製しない                                      |
| ephemeral                | Worker generation、未commit turn、TUI draft/viewport、一時bash出力、atomic write staging                                                                                                         | memory、`/tmp`、各store内のtemporary file                                                    |
| binary隣接path           | なし                                                                                                                                                                                             | binaryの隣には書き込まない                                                                   |

XDGの分類では、module
revisionを再利用する利用者data、Sessionや履歴を再起動後に継続するstate、
credentialをconfigとして分離する。

### 1.3 Increment 32 — standalone executableと配置境界

目的は、repositoryと導入済みDenoを必要とせず、任意の場所へ配置したHenjiから任意のworkspaceを
対象に現行機能を利用できることである。

#### 統合CLI entry

一つのcompiled entryを設ける。

```text
henji                         # TUI
henji run --task ...          # 非対話実行
henji diagnostics ...         # 現行diagnostics
henji --version               # build identityのreadback
```

現在のshell launcherはrepository開発用として残せるが、installed production
commandの実行正本には しない。

#### Host path resolver

- state、config、dataの三rootをXDG環境変数とHOME fallbackから解決する。
- 現在のcredential絶対path `/home/masat.guest/.config/...`を廃止する。
- 現在のphysical working directoryをworkspace authorityとして維持する。
- binary pathまたはsource checkoutからstate/config/data pathを導出しない。

#### Embedded resource manifest

build時に次を確定し、binaryへ埋め込む。

- build revision
- Deno version
- target
- Worker bootstrap
- built-in Definition
- `@henji/agent` API
- runtime source集合のdigest

built-in Definitionのrevisionは、現在の薄いentry
TypeScript一枚のhashだけでなく、embedded runtime revisionへ結び付ける。

#### Logical revisionとphysical specifierの分離

Sessionへ永続化する`DefinitionRevisionRef`を論理的なrevision
authorityとし、Worker起動時だけHostが binary内specifierまたは将来のmanaged-store
pathへ解決する。

```text
persisted:
  builtin/default + embedded revision

runtime-only:
  Workerがimportする実際のspecifier
```

binaryの配置場所が変わってもSession bindingが変わらない形を目指す。

#### Compile設定

- 初期targetは`x86_64-unknown-linux-gnu`。
- `--app-name henji`を使用する。
- Worker bootstrapとcomputed importされるbuilt-in Definition
  rootを明示的に`--include`する。
- experimentalな`--bundle`は使わない。
- build
  outputは`dist/`へ置き、標準の`install`またはcopyで任意pathへ配置できるようにする。
- `deno.v0.json`はbuild入力であり、runtimeに隣接配置するresourceにしない。

#### Runtime permission

任意workspaceと現行`bash`
toolを維持するため、初期binaryへ次をcompile時に固定する。

- filesystem read/write
- `/bin/bash`実行
- `openrouter.ai`と`api.openai.com`へのnetwork
- HOME、XDGおよび必要なOpenAI SDK環境変数
- `uid`

現行runtimeは`trusted-local · no hard sandbox`であり、`/bin/bash`を通じてOS
user権限でcommandを
実行できる。standalone化だけを理由に、実効性のない狭いfilesystem
permissionを新設しない。

#### 当初の互換性案

- legacy built-in entry identityが同じembedded
  revisionへ対応する場合、既存Sessionを読めるようにする。
- 異なるrevisionを同じものとして黙って再解釈しない。

#### 当初の検証案

1. focused test、type check、format、lintを実行する。
2. disposableなsource copyからcompileし、そのsource copyを削除する。
3. binaryを別directoryへ移動し、PATHからDenoを外して起動する。
4. isolated XDG rootと任意workspaceでdiagnostics、TUI、非対話taskを確認する。
5. 既存built-in Sessionの互換読込を確認する。
6. 実providerでTUI一turnと非対話一turnを実行する。
7. stable candidateに対するauthoritative `v0:gate`を一回実行する。

release
automation、複数platform配布matrix、tag、publish、releaseは対象外とする。

### 1.4 Increment 33 — managed Agent Definition revision

目的は次のflowを成立させることである。

```text
任意pathのTypeScript source
  -> Hostがmodule closureを確定
  -> immutable revisionとしてXDG data storeへ登録
  -> 元sourceから独立
  -> exact revisionを指定して新しいSessionを開始
  -> 同じWorker / protocol / commit経路で実行
```

#### 当初のCLI案

```text
henji module install ./my-agent.ts --id my-agent
henji module list
henji module inspect --id my-agent --revision sha256:<full-digest>

henji --definition-revision my-agent@sha256:<full-digest>
henji run --definition-revision my-agent@sha256:<full-digest> --task ...
```

- 実行selectorはfull
  revisionだけを受理し、短縮digestまたは暗黙の`latest`を設けない。
- 現行`--definition <path>`はunmanagedな開発用direct-path互換として残す。

#### 当初のimport contract案

- entryとdependencyは`.ts`。
- staticなrelative import/exportを許す。
- embedded APIの`@henji/agent`を許す。
- module rootは既定でentryの親directoryとする。
- 必要なら`--root <directory>`でmodule rootを明示する。
- local closureはmodule root内に限定する。
- remote URL、JSR、npm、computed dynamic importは初回対象外とする。
- closure解析にはpinしたmodule graph
  parser/libraryをbinaryへ組み込み、導入済みDeno CLIを
  subprocess起動しない。当初案では`@deno/graph`を候補とした。

#### 当初のstore案

```text
$XDG_DATA_HOME/henji-harness/modules/
└── agent-definition/
    └── my-agent/
        └── sha256-<digest>/
            ├── revision.json
            └── source/
                ├── my-agent.ts
                └── relative-dependency.ts
```

`revision.json`には次を保持する。

- schema version
- resource kind: `agent-definition`
- module ID
- closure全体のrevision digest
- entry relative path
- 各fileのrelative path、SHA-256、byte数
- `@henji/agent` contract version
- 元source path
- 登録日時

revision
digestは、provenanceと登録日時ではなく、順序を正規化したclosure内容から計算する。同じ内容の
再登録は同じrevisionとする。

#### 当初のlogical ref案

```text
external
  resourceKind: agent-definition
  moduleId: my-agent
  revision: sha256:...
```

絶対data-root pathはmanaged Sessionへ保存しない。Hostが起動時にlogical
refからstore pathを解決し、 Workerへ物理load descriptorを渡す。

#### 当初の検証案

1. 二file以上のrelative dependencyを持つDefinitionを任意pathから登録する。
2. `list`と`inspect`でidentity、revision、entry、全dependency、provenanceをreadbackする。
3. 元sourceとdependencyを変更または削除する。
4. repository外workspaceから同じrevisionで新しいSessionを開始する。
5. process再起動後もSessionを復元する。
6. execution artifactとprovider evidenceにexact logical
   refが残ることを確認する。
7. built-inとexternalが同じWorker、protocol、commit経路を通ることを確認する。
8. 実providerで通常taskを一turn実行する。
9. stable candidateに対するauthoritative `v0:gate`を一回実行する。

AIから呼べるmodule-install tool、activate/update、hot
reload、既存Sessionのrevision切替、remove/GC、
instruction/tool/provider外部化、複数platform releaseは対象外とする。

---

## 2. 第三者reviewの範囲と結果

第三者reviewerはread-onlyで、当初案をarchitecture、roadmap、active
sourceへ照合した。評価範囲は resource/state境界、increment分割、Deno
compileの実現性、Definition closure/revision契約、既存永続
schemaとの互換性、検証計画である。一般的なsecurity/hardening review、provider
call、E2E、compile、 full
gate、file変更、commit、push、publishは実施していない。

結果はBlocker 0、P1 3、P2
2である。計画承認前にP1を解消し、P2を計画へ反映することを推奨した。

### P1 — legacy built-in Sessionをsame embedded revisionへ自動対応させる根拠がない

現行built-in refが保存するのはentry fileのfile
URL、digest、byte数だけである。digestもentry fileだけを 読み、実体のbuilt-in
entryは`worker_agent_api.ts`をimportする薄いfileである。transitiveなruntime、
core、instruction、toolの変更はlegacy refへ反映されない。

schema v1はDefinition
ref自体を持たず、現行restoreはagentが一致すれば現在のbuilt-inを受け入れる。このため、
「legacy entry identityが同じembedded
revisionへ対応する場合」という当初条件は、保存済みrecordだけでは 判定できない。

利用者影響:

- 古いSessionを新binaryで再開した際、過去と異なるembedded
  runtimeを同じrevisionとして実行し得る。
- readback可能であることと、exact
  revisionとしてresume可能であることを区別しないと、移行時に黙った
  reinterpretationが生じる。

reviewerの改善候補:

- legacy built-in Sessionを一覧・履歴読取だけにし、新Sessionを要求する。
- exact性の例外として、現在buildへの明示的な一回migrationまたは利用者承認を設ける。
- 当時のfull build identityとの信頼できる対応表が存在する場合だけmappingする。

根拠:

- [`../../v0/agent/session/session_store_contract.ts`](../../v0/agent/session/session_store_contract.ts)
- [`../../v0/agent/worker/worker_capsule.ts`](../../v0/agent/worker/worker_capsule.ts)
- [`../../v0/agent/worker/worker_builtin_definition.ts`](../../v0/agent/worker/worker_builtin_definition.ts)
- [`../../v0/agent/worker/worker_builtin_planner_definition.ts`](../../v0/agent/worker/worker_builtin_planner_definition.ts)
- [`../architecture/henji-host-agent-worker.md`](../architecture/henji-host-agent-worker.md)

### P1 — managed revisionがclosure全体とembedded APIを確実にbindしていない

現行Workerはentryだけをpre-read/hashしてから通常importし、relative
dependencyのbytesを照合しない。当初案は 各file digestとembedded API contract
versionをmetadataへ持たせるが、次が未確定だった。

- execution時にclosure全fileをrevision metadataと照合する地点。
- `@henji/agent` contract identityをrevision digestへ含めるか、別のruntime
  compatibility checkにするか。
- 同じclosure bytesを別API contractでinstallした場合のstore path衝突。
- 同じrevisionを再installしたときのprovenanceと登録日時のauthority。

利用者影響:

- managed store内のdependencyが変更または破損しても、同じlogical
  refで別codeを実行し得る。
- binary更新後に同じsource digestが異なるembedded API contractで解釈され得る。
- immutable `revision.json`へ異なる登録情報を書こうとする可能性がある。

reviewerの改善方向:

- canonical digestを、closure schema、embedded API contract
  identity、正規化relative path、file bytesへ bindする。
- Host解決時にmanifestと全fileを検証してからphysical descriptorをWorkerへ渡す。
- provenance/timeを初回registration metadataとするか、immutable content
  manifestとregistration eventを 分離する。

根拠:

- [`../../v0/agent/worker/worker_bootstrap.ts`](../../v0/agent/worker/worker_bootstrap.ts)
- [`../architecture/henji-host-agent-worker.md`](../architecture/henji-host-agent-worker.md)

### P1 — logical refへのschema移行とunmanaged `--definition`のdurable semanticsが未定義

現行Session codecとexecution artifact codecはfile
URL型refをstrictに検証する。logical refへin-place変更すると
既存Session、artifact、diagnosticのreadbackを壊す一方、旧shapeだけを維持するとphysical
pathが永続authorityの ままになる。

また、現在の`--definition <path>`はnew、continue、exact
Session指定と組み合わせてdurable Sessionを作成・
再開できる。当初案はunmanaged互換を維持するとしたが、新しいlogical
refとの関係を定義していなかった。

利用者影響:

- schema変更によって既存の永続記録を読めなくなる可能性がある。
- direct-path Sessionを再開できなくする場合、現行product behaviorの変更になる。

reviewerの改善方向:

- Sessionに新schema versionを設ける。
- execution artifactにも新versionまたは明示的な互換decoderを設ける。
- `ResolvedDefinition { logicalRef, physicalLoadDescriptor }`のようにprotocolまで分離する。
- unmanaged pathをdurableに保つ場合は、保存したunmanaged
  identityと再提示したlocatorを照合する。
- 旧direct-path
  Sessionについてreadback、resume、failureのどこまで維持するか明記する。

根拠:

- [`../../v0/agent/session/session_record_codec.ts`](../../v0/agent/session/session_record_codec.ts)
- [`../../v0/agent/worker/worker_execution_artifact.ts`](../../v0/agent/worker/worker_execution_artifact.ts)
- [`../../v0/agent/worker/worker_host_contract.ts`](../../v0/agent/worker/worker_host_contract.ts)
- [`../../v0/agent/cli/tui_cli.ts`](../../v0/agent/cli/tui_cli.ts)

### P2 — managed external Definitionのroot roleが未定義

公開APIはparentとplannerのcompositionを作れるが、現行HostはSessionの`agent: default | planner`からroot
roleを 先に決める。Worker ready後のmanifest
roleがHost選択と異なれば起動を拒否する。当初CLI、revision metadata、 Session
bindingのいずれにもmanaged moduleのroot roleがなかった。

利用者影響:

- planner compositionをdefault
  exportする正規のmoduleを、Hostがparentとして起動して拒否する可能性がある。
- 暗黙にparent-onlyとすると、公開済みcomposition APIよりproduct
  contractが狭くなる。

reviewerの改善方向:

- 初期contractをparent-onlyとするなら明示的なproduct制約として承認する。
- plannerも扱うなら、install metadataまたはSession bindingでroot
  roleを確定して永続化する。

根拠:

- [`../../v0/agent/worker_agent_api.ts`](../../v0/agent/worker_agent_api.ts)
- [`../../v0/agent/session/session_store_contract.ts`](../../v0/agent/session/session_store_contract.ts)
- [`../../v0/agent/worker/worker_host_session.ts`](../../v0/agent/worker/worker_host_session.ts)

### P2 — portable credential pathの利用者文書更新が計画にない

READMEとsourceは現在、開発者固有の絶対credential
pathを使用している。sourceだけXDG config resolverへ
変更してREADMEを更新しない場合、別userまたは別machineで利用者がcredentialを正しいpathへ置けない。

改善方向:

- Increment 32へOpenRouter/OpenAI両credential path、XDG
  fallback、build/install/run commandのREADME更新を 含める。

根拠:

- [`../../README.md`](../../README.md)
- [`../../v0/agent/provider/credential_file.ts`](../../v0/agent/provider/credential_file.ts)

### Reviewで妥当とされた点

- Increment 32でstandalone executableとpath/resource境界を作り、Increment
  33でmanaged Definition storeを 載せるdependency order。
- embedded、config、managed data、runtime state、workspace
  input、ephemeralの分類。
- binary隣接pathを書込みの正本にしないこと。
- XDG Dataへmodule revision、XDG StateへSession/history/evidenceを置くこと。
- full revision指定と、暗黙の`latest`を初回に設けないこと。
- installとactivationを別operationとして扱うこと。
- `--bundle`を使わず、Worker等の必要なcomputed rootを明示的にincludeすること。
- disposable sourceを削除してrepository非依存を確認すること。
- offline
  fixtureだけで完了とせず、実provider、Session、evidenceを含むproduction経路を確認すること。

---

## 3. Findingを受けた修正推奨案

以下は第三者reviewを受けたcoordinating
ownerの推奨であり、まだ利用者が承認した計画ではない。

### 3.1 Legacy built-in Session

- schema v1〜v5のlegacy
  Sessionは、一覧、history表示、`/history export`を維持する。
- legacy recordだけから当時のfull embedded revisionは復元できないため、exact
  revisionとして自動対応させない。
- `/sessions`で利用者がlegacy
  Sessionを選択するとき、`legacy; resume binds current build`と表示する。
- その明示的な選択を、現在のbinary revisionへbindするmigration
  actionとして扱う。
- `--continue`ではlegacy Sessionを暗黙migrationしない。
- migration後の最初のdurable commitで新Session schemaへ保存する。

### 3.2 Managed closure revision

canonical revision digestを次から計算する。

```text
closure schema version
+ resource kind
+ @henji/agent contract identity
+ sorted(relative path + exact file bytes)
```

- Hostはlogical refを解決するとき、revision manifestとclosure全fileを照合する。
- Workerはimport直前に同じclosure descriptorを照合する。
- `@henji/agent` contract identityが異なる場合、同じsource
  bytesでも別revisionになる。
- binary build identityはDefinition
  revisionとは別にSession/evidenceへattributionする。

### 3.3 Persisted schemaとruntime load descriptor

- 新しいlogical refを保存するSession schema v6を追加する。
- execution
  artifactも新versionへ更新し、旧versionをreadbackできるdecoderを維持する。
- provider evidence、failure diagnosticその他、Definition
  refを内包または参照する永続schemaを調査し、 同じ互換規則を適用する。
- Host内部に次の分離を設ける。

```text
ResolvedDefinition
  logicalRef             # Session/evidence/artifactのauthority
  physicalLoadDescriptor # 現在processのWorker起動にだけ使用
```

### 3.4 Unmanaged direct-path Definition

- 現行`--definition <path>`を削除または`--no-session`専用へ狭めない。
- unmanaged Definitionは、managed revisionと別の`unmanaged` refとしてabsolute
  canonical path、entry hash、 byte数を保存する。
- resume時は同じpathの現在内容を保存済みidentityと照合する。
- managed revisionだけが「元source pathをruntime
  authorityにしない」という保証を持つ。
- legacy direct-path external Sessionを自動的にmanaged storeへimportしない。

### 3.5 Root role

当初CLIへroot roleを追加する。

```text
henji module install ./my-agent.ts --id my-agent --role parent
henji module install ./planner.ts --id my-planner --role planner
```

- `--role`未指定時は`parent`とする。
- roleをimmutable revision metadataとSession bindingへ保存する。
- selectorから起動するとき、Hostは保存済みroleをroot roleとして使用する。

### 3.6 Reinstallとprovenance

- immutable revision manifestへ最初のregistration
  provenanceと登録日時を保存する。
- 同一module
  ID、同一revisionの再installは既存revisionを返し、metadataを書き換えない。
- 複数registration eventのappend-only履歴は今回追加しない。
- 同一contentを別module IDで登録した場合、pair
  `(module ID, revision)`として別の登録になる。

### 3.7 利用者文書

Increment 32へ次を追加する。

- OpenRouter/OpenAI両credentialのXDG config pathとHOME fallback。
- 現環境では従来と同じ`$HOME/.config/henji-harness/`になること。
- binaryのbuild、任意pathへのinstall/copy、TUI、非対話、diagnosticsの実行例。
- state、config、managed data、workspace inputの配置説明。
- `trusted-local · no hard sandbox`とcompile時permissionの関係。

---

## 4. 利用者判断が必要な点

計画承認前に、少なくとも次を確認する。

1. legacy built-in
   Sessionを、履歴readbackは常に可能、`/sessions`で明示選択した場合だけ現在buildへ
   migrationしてresume可能、とするか。
2. unmanaged `--definition <path>`によるdurable
   Sessionを、現在同様に維持するか。
3. managed external Definitionでparentとplannerの両root
   roleを扱い、未指定時parentとするか。
4. 同一revision再installでは最初のprovenanceと登録日時を保持し、registration履歴は作らないか。

これらが承認されたら、本資料の修正推奨案をIncrement 32とIncrement
33の正本へ分け、実装、focused verification、差分review、production
proof、各incrementのauthoritative gateへ進む。
