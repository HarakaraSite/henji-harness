# Increment 32 — standalone executableとexternalization共通境界

ステータス: **完了 — 2026-09-11**

基準commit: `a27b3be0`

対象機能: F01、F03、F04、F06、F07、F09

## 利用者が必要とする動作

- 一つの`henji` executableを任意pathへ置き、repository checkoutや別途導入したDenoに依存せず、任意の
  workspaceからTUI、非対話turn、Session管理、diagnostics、version確認を利用できる。
- binary、XDG config、将来のmanaged data、runtime state、workspace inputの場所とauthorityを区別して
  readbackできる。
- built-in Agent Definitionをmachine/path非依存のexact logical refとしてSessionと実行証拠から確認できる。
- 一turnを実行したHenji buildとDefinition refをSession、execution artifact、provider evidenceで相関できる。
- workspace `AGENTS.md`、workspace Skill、user-scope Skillをinstall操作なしに起動時発見できる。
- 現行のunmanaged `--definition <path>`はなくなり、Increment 33までbuilt-in Definitionだけを利用する。

## 根拠と確認済みの現在地

- architecture正本は、standalone binary、XDG config/data/state、`ManagedResourceRef`、logical/physical ref分離、
  native discoveryを要求する。
- roadmap正本はIncrement 32をF01、F03、F04、F06、F07、F09へ割り当て、旧永続schemaを移行しない破壊的
  cutoverを承認済みである。
- 計画作成時のinstalled `henji`は`~/.local/bin/henji`にあるshell wrapperで、repository、固定pathのDeno 2.9.4、
  複数のshell launcherへ依存していた。
- 現在のproduction TUIは`v0/agent/cli/tui_cli.ts`、非対話turnは`runtime_cli.ts`、Session管理は
  `session_cli.ts`、diagnosticsは`failure_diagnostic_cli.ts`を別々のlauncherから起動する。
- built-in Worker entryとDefinition entryは`import.meta.url`から組み立てたfile URLで読み、現行の
  `DefinitionRevisionRef`はそのphysical URL、entry SHA-256、source bytesを永続化する。
- 現行Sessionはschema v1〜v5、execution artifactとprovider evidenceはschema v1である。
- Skill discoveryはworkspace配下の`.zot/skills`、`.claude/skills`、`.agents/skills`だけをこの順に読む。
  user scopeは未実装である。
- repositoryで固定したDeno 2.9.4の`deno compile --help`と
  [公式`deno compile`文書](https://docs.deno.com/runtime/reference/cli/compile/)を確認した。runtime permissionは
  compile時に固定され、Workerや非静的dynamic importは`--include`で明示的に組み込める。通常compileは
  runtimeとmodule graphを単一executableへ埋め込む。
- user-scope Skillの互換locationとprecedenceは、固定snapshot
  [`_refs/zot/docs/skills.md`](../../_refs/zot/docs/skills.md)のnative/Claude/agent互換順序を根拠にする。

## Product contract

### 1. 一つのCLI entry

新しいTypeScript dispatcherを唯一のproduction CLI entryとし、次を提供する。

| invocation | 動作 |
| --- | --- |
| `henji [TUI flags]` | 現行TUI。`--agent`、`--continue`、`--no-session`、`--session`、`--max-steps`、`--provider-timeout-ms`、`--root-provider`を維持する |
| `henji run [--task TEXT] [--agent ROLE]` | 現行の非対話一turn。TTYでは`--task`、pipeではstdinを使う既存contractを維持する |
| `henji sessions list` | current workspaceのSession metadata JSONを返す |
| `henji sessions delete --session ID --yes` | current workspaceの指定Sessionだけを削除する既存operationを維持する |
| `henji diagnostics ...` | 現行diagnostic、execution、provider evidenceのlist/show/deleteを維持する |
| `henji diagnostics runtime` | build manifest、executable path、workspace、解決済みconfig/data/state rootをcredential値なしのJSONで返す |
| `henji --version` | product version、build ID、source revision、Deno version、target、runtime digest、supported Definition API contractを一行で返す |

dispatcherはargvをworkspace、terminal、credential、stateへ触れる前に分類する。`--definition`はshellとTypeScript
parserの両方から削除し、旧flagを渡した場合は既存のinvalid invocation形式で終了する。

repository依存のproduction shell launcherは削除する。開発taskも同じTypeScript dispatcherまたはcompile taskを
入口とし、shell版を第二のproduction経路として残さない。

### 2. Build manifestとbuild command

`BuildManifestV1`を次のdata-only contractとして導入する。

```text
schemaVersion
productVersion
buildId
sourceRevision
sourceDirty
denoVersion
target
embeddedRuntimeSha256
supportedAgentDefinitionApiContracts
```

- `productVersion`は`jsr.json`のversion、`sourceRevision`はbuild対象checkoutのGit commit、`sourceDirty`はruntime
  digest対象fileにそのcommitとの差分またはuntracked fileがあるかを表す。無関係な文書やoutput artifactは含めない。
- `embeddedRuntimeSha256`は、dispatcher、Worker bootstrap、built-in DefinitionをrootとしてDenoが解決した
  local/vendor module closureと、`deno.v0.json`、`deno.lock`、`jsr.json`を、relative pathとbyte lengthを含む
  canonical順序でSHA-256した値にする。absolute checkout pathとbuild時刻は含めない。
- `buildId`は`buildId`自身を除く上記identity fieldのcanonical encodingをdomain-separated SHA-256した値にする。
- build時刻はcode identityではないためmanifestへ入れない。同じ入力からは同じbuild identityを得る。
- supported contractはIncrement 32で一つの`henji-agent-definition-v1`を定義する。

repository-owned build scriptは現在実行中のDenoが2.9.4であることを確認し、Git/JSR/config/module graphからmanifestを
作る。生成manifestをliteralとして持つ一時wrapper entryをtemporary directoryに作り、次の条件でcompileする。この
entry sourceはDenoのcompile入力としてartifactへ埋め込まれるが、一時directoryはbuild後に削除し、runtime filesystem
dependencyや永続authorityにはしない。

- current Linux ARM64 targetのみを対象にする。cross-platform build matrixは扱わない。
- `--bundle`と`--self-extracting`は使わない。
- Worker bootstrapとbuilt-in parent/planner Definitionを`--include`する。
- remote module解決をruntimeへ残さず、固定lock/vendor/configをbuild inputにする。
- outputは既定で`dist/henji`、`--output <path>`で任意pathを指定できる。既定outputは`.gitignore`へ追加し、
  repositoryの配布sourceやbuild identityへ混入させない。

build taskは`deno task --config deno.v0.json henji:compile [--output PATH]`とする。binaryを`~/.local/bin`等へcopyして
既存launcherを置換する操作はbuildに含めず、完成artifactの利用者確認後に別途行う。

### 3. Runtime permission

compiled binaryは現行の`trusted-local · no hard sandbox`を維持する。任意workspaceとXDG/user skill locationを
実際に扱えるようread/writeはpathで固定せず、network、subprocess、environmentは現行product経路に必要なものを
compile時へ移す。

- read/write: workspace、XDG root、user-scope Skill、embedded Worker/module、`/tmp`を扱えるruntime permission。
- run: `/bin/bash`。
- net: `openrouter.ai`、`api.openai.com`。
- sys: `uid`。
- env: `HOME`、`XDG_CONFIG_HOME`、`XDG_DATA_HOME`、`XDG_STATE_HOME`、`ZOT_HOME`、および現行provider診断に
  必要な`OPENAI_LOG`、`OPENAI_CUSTOM_HEADERS`。
- permission promptは出さない。

これは新しいsandbox modelではない。startup headerのruntime表示も引き続き`trusted-local · no hard sandbox`とする。

### 4. XDG ownershipとstate layout cutover

production runtimeは一つのresolverで次を確定し、各CLIから再利用する。

| authority | path |
| --- | --- |
| config | `${XDG_CONFIG_HOME:-$HOME/.config}/henji-harness` |
| managed data namespace | `${XDG_DATA_HOME:-$HOME/.local/share}/henji-harness` |
| runtime state v1 | `${XDG_STATE_HOME:-$HOME/.local/state}/henji-harness/v1` |
| workspace input | invocation時のphysical cwd |

- OpenRouter/OpenAI credential fileはconfig root直下の`openrouter-api-key`、`openai-api-key`とし、現在の利用者では
  従来pathと一致する。credential値はmanifest、diagnostics、Sessionへ入れない。
- data rootはIncrement 33のmanaged storeに備えてresolve/readbackだけ可能にし、Increment 32ではresource storeを
  作らない。
- current state layout `${...}/henji-harness/<workspace-digest>`は変更・削除しない。新binaryはversioned v1 layoutだけを
  読み書きし、旧recordをlist、resume、diagnosticsで新schemaとして解釈しない。
- test seamの明示state rootは残せるが、production launcher固有の`HENJI_SESSION_STATE_ROOT`はauthorityにしない。

### 5. Logical resource refとphysical descriptor

共通refの最初のschemaを次に固定する。

```ts
interface ManagedResourceRefV1 {
  readonly schemaVersion: 1;
  readonly resourceKind: string;
  readonly resourceId: string;
  readonly revision: {
    readonly algorithm: 'sha256';
    readonly digest: string;
  };
}

type DefinitionRevisionRef = ManagedResourceRefV1 & {
  readonly resourceKind: 'agent-definition';
};
```

- built-in resource IDは`builtin/default`と`builtin/planner`とする。
- built-in revision digestはresource ID、parent/planner role、`henji-agent-definition-v1`、
  `embeddedRuntimeSha256`から作るcanonical identity manifestのSHA-256とする。薄いentry fileだけのdigestにはしない。
- external Definition ID、manifest/store、dependency bindingはIncrement 33以降で追加する。Increment 32の
  Definition validatorはbuilt-in IDだけを受け入れる。

Hostはlogical refを選んだ後、現在process内だけで次を持つphysical load descriptorへ解決する。

```text
definition ref + embedded module URL + entry SHA-256 + source bytes
```

Worker protocolはload/verificationのためdescriptorを受け取れるが、Session、execution artifact、provider evidenceへ
永続化するのはlogical refだけとする。Workerはembedded sourceをimport前に従来どおりentry digestとbytesで確認する。

### 6. Build/Definitionのturn attributionとschema cutover

旧recordを同じdirectoryでinvalid recordとして混在させないため、前記state v1 namespaceと同時に次へ切り替える。

- `SessionRecordV6`: current Definition refに加え、commit済みturnごとのbuild manifestとDefinition refを持つ
  `turnExecutions`を追加する。rename、model change、Session restoreの既存意味は維持する。
- `WorkerExecutionArtifactV2`: `BuildManifestV1`とlogical Definition refを持ち、physical specifier fieldを持たない。
- `ProviderEvidenceV2`: Session ID、turn、`BuildManifestV1`、logical Definition refを持ち、既存request/response/parser/
  runtime eventの診断証拠を維持する。
- failure diagnostic schemaはcredential非保持の小さいfactとして維持し、既存diagnostic-to-evidence linkからbuild、
  Definition、raw provider evidenceへ到達できるようにする。

Session schema v1〜v5、execution artifact v1、provider evidence v1のdecoder/migrationをactive production経路から外す。
旧fileは旧state layoutに残り、新binaryは削除も自動importも行わない。decode不能recordをbuilt-in current revisionとして
補完しない。

### 7. Native Skill discovery

既存Skill file contract、snapshot/catalogのgeneration単位固定、同名skillは先に見つけたものを採用する意味を維持し、
探索rootだけを次の順序へ広げる。

1. `<workspace>/.zot/skills`
2. `$ZOT_HOME/skills`。未指定時はLinux上で`${XDG_STATE_HOME:-$HOME/.local/state}/zot/skills`
3. `<workspace>/.claude/skills`
4. `$HOME/.claude/skills`
5. `<workspace>/.agents/skills`
6. `$HOME/.agents/skills`

workspace rootの`AGENTS.md`/`AGENTS.MD`探索は現状を維持する。user-scope `AGENTS.md`、recursive skill discovery、
Pi固有`.pi/skills`、新しいSkill metadata semanticsはIncrement 32へ追加しない。native inputをmanaged data rootへcopyせず、
startup headerが示すskill catalogも実際に選ばれたsnapshotと一致させる。

## 実装slice

### Slice A — identity、build manifest、XDG resolver

1. `BuildManifestV1`、canonical digest、`ManagedResourceRefV1`、built-in Definition identityをdata-only moduleへ置く。
2. config/data/state/workspace resolverを一か所へまとめ、credential resolverと各store/CLIへ渡す。
3. Session v6、execution artifact v2、provider evidence v2のcontract/codecを導入し、legacy decoderとphysical ref永続化を
   active pathから外す。

### Slice B — embedded Worker経路

1. HostのDefinition selectionをlogical ref、loadをprocess-local descriptorへ分ける。
2. Worker protocol/bootstrapをembedded module descriptorで起動できるようにし、built-in parent/plannerを同じ経路へ通す。
3. build/Definition attributionをWorker generationとturn commitへ一度だけ渡し、Session、artifact、evidenceへ同じ値を
   記録する。
4. `--definition`とexternal fixtureをproduction selectorから外す。Increment 33用のmanaged loaderは実装しない。

### Slice C — CLI統合とcompile

1. TUI、run、sessions、diagnostics、runtime diagnostics、versionをdispatchする一つのentryを作る。
2. shell launcherを削除し、repository taskとproduction E2EをTypeScript entry/compiled artifactへ更新する。
3. module graph digest、temporary wrapper、explicit Worker/Definition includeを行うcompile taskを追加する。
4. READMEへbuild、任意pathからの実行、XDG配置、credential path、runtime permission、旧state非移行を記載する。

### Slice D — user-scope Skillとproduction証拠

1. Skill discoveryへ前記user rootとprecedenceを追加し、workspace/user sourceをstartup projectionまで保持する。
2. compiled artifactをsource checkout外へ移し、version/runtime diagnostics、Session操作、provider-free failure/readbackを
   repositoryとPATH上のDenoなしで確認する。
3. stable candidateを差分review、authoritative gate、実provider TUI/runの順で確認する。

## 変更予定領域

- 新規: unified CLI entry、build/runtime manifest、runtime path resolver、managed resource ref、compile script、
  Increment 32 focused test。
- 更新: `.gitignore`、`deno.v0.json`、README、TUI/runtime/session/diagnostic CLI、credential resolver、Skill discovery、Worker
  Definition loader/protocol/bootstrap/Host、Session store/codec、execution artifact、provider evidence、presentationの
  logical Definition projection、production E2E。
- 削除: repositoryと固定Deno pathへ依存するproduction shell launchers、unmanaged external Definitionのproduction
  selectorとそれだけを支えるlegacy test expectation。
- 維持: provider adapters、agent loop、tool behavior、atomic turn commit、TUI操作、canonical transcript、history export、
  model/provider selection、diagnostic raw evidence、credential validation。

## 検証計画

各確認は先に定義したproduct動作へ対応させる。実装中に`v0:test`や`v0:gate`を繰り返さない。

### Focused確認

- dispatcher: 各subcommand/flagが対応する既存mainへ一度だけ渡り、unknown commandと`--definition`をside effect前に
  拒否する。
- build/identity: 同じsource closureから同じbuild/ref digest、contentまたはcontract変更から別digestを作り、absolute
  checkout/output pathをidentityへ含めない。
- paths: XDG指定時とHOME fallbackがconfig/data/state v1を一貫して返し、全CLIとcredential pathが同じresolverを使う。
- codecs: v6/v2/v2がbuildとlogical refをround-tripし、physical pathをencodeせず、旧shapeを新shapeとして読まない。
- Worker: embedded parent/plannerがlogical refから同じcapsuleで起動し、Session/artifact/evidenceのturn attributionが
  一致する。
- native discovery: 6 locationのprecedence、user-scopeのみ存在するSkill、workspaceによる同名override、startup
  catalogとの一致を確認する。
- compiled process: 移動したbinaryの`--version`、`diagnostics runtime`、Session list、missing-credential failureが
  source checkout/PATH上のDenoなしに動く。

変更に対応するfocused test、type check、format、lint、`git diff --check`を実装sliceごとに行う。

### 第三者差分review

stable candidateをread-only reviewerへ一回渡し、次だけを確認する。

- repository/Denoへのruntime参照が残らないこと。
- logical ref、physical descriptor、build attributionがSession/Worker/evidenceで混ざらないこと。
- legacy cutoverが旧recordを黙って再解釈または削除しないこと。
- TUI、run、sessions、diagnosticsとatomic turn commitの具体的regression。
- native Skill precedenceと実際のstartup catalogが一致すること。

reviewerはfull gate、build、provider E2Eを実行しない。findingを反映したstable candidateに対し、coordinating ownerが
authoritative `v0:gate`を一回実行する。

### Production受入

1. disposable checkoutから`dist/henji`をbuildし、binaryをcheckout外の別pathへ移す。
2. source checkoutを参照できず、PATHにDenoがない環境で`--version`と`diagnostics runtime`を実行する。
3. isolated `XDG_STATE_HOME`/`XDG_DATA_HOME`と任意workspaceで、workspace instruction/Skillおよびisolated user-scope
   Skillの発見を確認する。credentialをcopyせず、real provider確認時だけ既存`XDG_CONFIG_HOME`を利用する。
4. compiled binaryから非対話の実provider turnを完了する。
5. compiled binaryをreal TTYで起動して一turn完了し、Sessionを再開する。
6. Session、execution artifact、provider evidenceをdiagnosticsから読み、同じbuild ID、logical Definition ref、
   Session/turnを相関する。
7. output binaryを別pathへ移して同じ`--version`と通常起動が成立することを確認する。

## 完了条件

- 一つのcompiled artifactだけでTUI、run、sessions、diagnostics、versionが動き、repositoryとDenoへruntime依存しない。
- config/data/state/workspace authorityが実際のpath resolverとdiagnostics readbackで一致する。
- built-in Definition refにphysical pathがなく、build/Definition attributionが三つの永続記録で一致する。
- old state layoutを変更せず、新state layoutが旧schemaを自動移行・再解釈しない。
- native workspace/user Skillが合意したprecedenceでzero-install discoveryされる。
- `--definition`がなく、external Definitionを実行する別経路が残らない。
- focused確認、第三者差分review、一回の`v0:gate`、compiled binaryの実provider TUI/run受入が完了する。

## 実装・検証結果

- `henji`のproduction入口を一つのTypeScript dispatcherへ統合し、TUI、`run`、`sessions`、`diagnostics`、
  `diagnostics runtime`、`--version`をcompiled binaryから利用できるようにした。repository依存のproduction shell
  launcherとunmanaged `--definition`経路は削除した。
- build manifest、XDG authority resolver、built-in Definitionのlogical managed refを導入した。Session v6、Worker
  execution artifact v2、provider evidence v2は同じbuild、Definition revision、Session、turnを保持し、physical file
  URLを永続identityへ含めない。
- Skill discoveryを合意したworkspace/user precedenceへ拡張した。Workerがgenerationに使用したinstruction/Skill
  snapshotをHostへ返し、startup headerもその同じsnapshotから描画する。
- 第三者差分reviewは当初Blocker/P1なし、P2 2件だった。XDG指定時の不要な`HOME`要求と、Host/Workerの二重Skill
  discoveryを修正し、差分再reviewで解消を確認した。
- coordinating ownerがauthoritative `v0:gate`を一回実行し、type check、format、lint、全offline testが成功した。
- gate後のproduction受入で、compiled build manifestのproperty順序をSession v6が誤って拒否する問題と、headless
  `run`が先に作ったstate directory modeにより後続TUIが起動できない問題を実測した。共通build validatorと全storeの
  `0700` directory契約へ修正し、該当focused test、type check、format、lint、`git diff --check`を成功させた。これら2件
  だけの追加第三者reviewでもconcrete findingなしを確認した。
- 最終compiled build ID `c6dba818916ea2ee7d3889d493dc127ffad88f02b69a4834798ff114632cef5b`をcheckout外で
  実行した。PATHにDenoを置かず、実OpenRouterで非対話turn `increment32-run-after-fix`とreal-TTY turn
  `increment32-tty-ok`を完了した。作成したSessionをexact IDで再開し、さらにbinaryを別pathへ再配置してversion、
  runtime diagnostics、通常TUI復元が成立した。
- 実TTY turnのSession v6、execution artifact v2、provider evidence v2は、同じbuild ID、`builtin/default` revision、
  Session ID、turn 1で相関した。既存credentialは通常のXDG config resolver経由でのみ利用し、値の表示・copy・記録は
  行っていない。
- 利用者の明示指示により、完成artifactを`~/.local/bin/henji`へinstallし、旧shell launcherを
  `~/.local/bin/henji.pre-standalone-launcher`へ退避した。利用者は別workspace
  `/home/masat.guest/src/henji`から既存Sessionのexact復元、repository調査、workspace Skill `handoff-read`の発見、
  tool実行がinstalled binaryで成立することを確認した。

## 対象外

- external Agent Definitionのinstall/list/inspect/activation。
- managed resource store、manifest、dependency graph resolver。
- Definition revision export/import。
- user-scope `AGENTS.md`、recursive Skill discovery、Pi固有Skill location。
- MCP client/resource、他resource kindの外部化。
- sandbox/permission modelの新設、release automation、tag、publish、複数platform matrix、binary self-update。
- 旧Session/evidence/artifactのmigration、import、削除。
- `~/.local/bin/henji`の自動置換。

## Human Gateと停止条件

- この文書の承認がIncrement 32の実装許可である。承認前にcode、test、README、build taskを変更しない。
- compiled binaryを実providerで確認することは計画承認に含むが、credentialを表示・copy・記録しない。
- repository外のinstalled `henji`置換、commit、push、tag、publishは別の利用者指示を必要とする。
- Deno 2.9.4のcompiled virtual filesystemでWorkerまたはbuilt-in Definitionを同じcapsuleから起動できない実証が
  得られた場合は、`--self-extracting`や別processへ黙って変更せず、観測結果と代案を利用者へ返す。
- architecture、roadmap、外部contract、対象機能、受入水準を変える必要が生じた場合は実装を止め、利用者判断へ戻す。
