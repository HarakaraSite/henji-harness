# Agent Definition resource identity implementation plan

## Decision summary

**GO、初期implementation Human Gate待ち。**

Planning baseはclean tracked HEAD
`93480dbd6abfacb90ef14ed333e07b48f9bc9255`である。既存のuntracked `_refs/`はuser-ownedとして保持する。
正本入力は`/tmp/planner-inputs/henji-agent-definition-resource-identity.md`、SHA-256
`0d3af9f66bc3c314aa7d37ccecb44e1e95be8c2671f9489450eec5335e77eeef`
（concept revision 22、roadmap step 76）である。

このincrementは、built-in `default` / `planner` Definitionが選んだmodel profile、instruction source、skill、
tool、planner subagentを、runtime objectやfunctionではなくstable internal identityで表す。同時にDefinitionの
有限loop parameterをdata-only selectionへ置き、runtime materialization前にidentityと既存宣言の対応を
fail closedで検証する。

外部CLI/TUI、provider wire、tool能力、planner非再帰境界、request上限、session/event/streaming、
persistenceは変更しない。step 77のmanifest、serialization、digestは作らない。

記録済みbaselineはdirect `v0:test` 505、owner `v0:gate` 507、review Blocker/P1/P2 zeroである。

## Confirmed current state

- `v0/agent/agent_definition.ts`はpure synchronousなDefinitionを持ち、resolved outputへprofile object、
  registry declaration、workspace、skill catalog、composed instruction、`maxSteps: 8`を含める。
- `v0/agent/runtime.ts#createRuntimeComposition`はworkspace、optional root `AGENTS.md`、project-local skillsを
  一度解決後、selected Definitionを一度評価してmodel/registryをmaterializeする。
- admitted delegation時だけ、同じstartup snapshotからbuilt-in planner Definitionをlazy評価する。
- production registryのexact tool集合は、skillsなしで`bash`, `delegate_to_planner`, `edit`, `read`,
  `submit_json_result`, `write`、skillsありで`skill`を加えた7件である。
- planner registryはskillsなしで`read`, `submit_json_result`、skillsありで`skill`を加えた3件である。
- skill effective nameは既に`^[a-z0-9][a-z0-9._-]{0,63}$`で検証され、catalogはname昇順でfreezeされる。
  `sourceDirectory`、body、tool resultはidentityに不要である。
- current model declarationはprovider `openrouter`、profile id
  `openrouter-google-gemini-3.7-flash-vertex-v0`である。profile objectにはendpoint、credential environment名、
  transport/budget fieldsもあるがidentityへ含めない。
- planner admissionは1 parent turnにつき1 child、request admissionはparent 8 / child 8 / aggregate 16である。
  これは既存execution policyであり、このincrementで変更しない。
- current permission topologyでは`agent:definition:test`はpermission-free、`agent:runtime:test`は既存
  workspace/Bash test用のbounded permissionsを持ち、central topology testがdirect test ownership、leaf
  permissions、gate compositionをexactに固定する。

## Reference decision

限定比較はApache-2.0のOpenComputer snapshot、pinned commit
`d54f2c239a293216ff13f069ffc1ed7b853f9761`の次だけとする。

- `_refs/opencomputer/agent/src/index.ts`: `ResourceReference { id }`、named model/tool/subagent選択、
  authoring declarationとexecutionの分離
- `_refs/opencomputer/agent/README.md`: model、tool、subagentをnamed resourcesとして選ぶ考え
- `_refs/opencomputer/README.md`
- `_refs/opencomputer/LICENSE`
- `_refs/README.md`のpin/license record

採用するのは、human-readable string identityによりresource selectionとruntime implementationを分離する
考えだけである。codeはcopy/importしない。Henji固有のgrammar、ordering、validationを独自実装するため、
追加license noticeは不要である。

公式current authoring説明`https://opencomputer.dev/agents/`（2026-08-30確認）とも比較し、reactive hook、
per-call render、DSL、deployment、connection、secret resolution、MCP、schedule、session data、sandboxは
採用しない。Henjiはonce-per-compositionのままである。

## Normative resource identity contract

新規`v0/agent/resource_identity.ts`へ、次と同等のinternal branded string contractを置く。

```ts
export type AgentResourceIdentity = string & {
  readonly __agentResourceIdentity: unique symbol;
};

export interface AgentResourceSelection {
  readonly resources: readonly AgentResourceIdentity[];
  readonly parameters: Readonly<{
    readonly maxSteps: number;
  }>;
}
```

brandはcompile-time misuse防止だけに使い、runtime resource valueはstring、parameter valueはnumberだけとする。
resource entryにobject/function reference、workspace、instruction text、skill body、credential、profile objectを
含めない。

### Identity grammar

identityはASCIIのみ、次のexact grammarとする。

```text
model:<provider>:<profile-id>
instruction:<instruction-id>
skill:<effective-skill-name>
tool:<tool-name>
subagent:<agent-id>
```

Normative component grammar:

```text
provider       = [a-z][a-z0-9-]{0,31}
profile-id     = [a-z0-9][a-z0-9._-]{0,127}
instruction-id = [a-z0-9][a-z0-9._-]{0,127}
tool-name      = [a-z0-9][a-z0-9._-]{0,127}
agent-id       = [a-z0-9][a-z0-9._-]{0,127}
effective-skill-name = [a-z0-9][a-z0-9._-]{0,63}
```

leading/trailing whitespace、uppercase、NUL、slash、backslash、additional colon、empty component、
out-of-bound componentを拒否する。slashを許可しないためabsolute/relative pathをidentityへ混入できない。

current model identityはexact `model:openrouter:openrouter-google-gemini-3.7-flash-vertex-v0`である。

### Allowed instruction identities

```text
instruction:workspace-agents
instruction:project-skill-manifest
instruction:builtin-planner-policy
```

- `workspace-agents`はresolved `agentInstructions`が`undefined`でない場合だけ含む。source filenameのcaseや
  workspace absolute pathには依存しない。
- `project-skill-manifest`はresolved catalog manifestが存在し、callable skillsが1件以上の場合だけ含む。
  `SkillCatalog`の型だけではこの対応を強制できないため、manifestなし/nonempty skillsまたは
  manifestあり/empty skillsはinvalid resolved inputとしてpre-materializationでrejectする。production
  discoveryは既にこのinvariantを満たす。
- `builtin-planner-policy`はplanner Definitionだけに常に含む。
- instruction textやmanifest text自体はidentityに含めない。

### Allowed tool and subagent identities

Known tool identitiesはexisting production/planner capabilityだけに限定する。

```text
tool:bash
tool:delegate_to_planner
tool:edit
tool:read
tool:skill
tool:submit_json_result
tool:write
```

Known subagent identityは`subagent:planner`だけである。

`tool:delegate_to_planner`はparent modelへadvertiseされるcall surface/schema/dispatch capability、
`subagent:planner`はそのtoolが選択できるbounded child Definition capabilityである。production defaultでは
両方が必要で、片方だけの宣言をvalidation errorにする。top-level plannerでは両方とも存在しない。

同様に、各`skill:<name>`はsaved instruction resource、`tool:skill`はそれらをmodelが選択してloadする
generic capabilityである。skillsが1件以上なら両方が存在し、empty catalogならどちらも存在しない。

## Canonical ordering

`resources`は次のkind rankで並べ、同kind内をASCII code-unitのstrict `<` / `>`比較で昇順にする。
`localeCompare`、object property enumeration、filesystem order、Registry materialization orderを使わない。

1. `model`
2. `instruction`
3. `skill`
4. `tool`
5. `subagent`

全listはcanonical orderで既に並んでいなければrejectする。validator側で黙って並べ替えない。これにより
Definition authoring driftを発見し、step 77はvalidated listをそのまま参照できる。

## Exact built-in selections

### `default`, no workspace instruction, no skills

```text
model:openrouter:openrouter-google-gemini-3.7-flash-vertex-v0
tool:bash
tool:delegate_to_planner
tool:edit
tool:read
tool:submit_json_result
tool:write
subagent:planner
```

Parameters: `{"maxSteps":8}`.

### `default`, workspace instruction and skills `format`, `review`

```text
model:openrouter:openrouter-google-gemini-3.7-flash-vertex-v0
instruction:project-skill-manifest
instruction:workspace-agents
skill:format
skill:review
tool:bash
tool:delegate_to_planner
tool:edit
tool:read
tool:skill
tool:submit_json_result
tool:write
subagent:planner
```

Instruction IDsのcanonical lexical orderはsystem-instruction concatenation orderを変更しない。既存compositionは
workspace instruction、skill manifest、planner policyの順を維持する。

### `planner`, no workspace instruction, no skills

```text
model:openrouter:openrouter-google-gemini-3.7-flash-vertex-v0
instruction:builtin-planner-policy
tool:read
tool:submit_json_result
```

Parameters: `{"maxSteps":8}`.

### `planner`, workspace instruction and skills `format`, `review`

```text
model:openrouter:openrouter-google-gemini-3.7-flash-vertex-v0
instruction:builtin-planner-policy
instruction:project-skill-manifest
instruction:workspace-agents
skill:format
skill:review
tool:read
tool:skill
tool:submit_json_result
```

`maxSteps: 8`だけをDefinition-owned finite loop parameterとしてselectionに置く。parent 8 / child 8 /
aggregate 16とone-child-per-turnはshared turn-execution/admission policyであるためresource selectionへ複製しない。

## Validation and materialization seam

`resource_identity.ts`はstrict parser/constructor、canonical comparator、immutable selection constructor、
`validateResolvedAgentResources(definition)`相当のinternal validator、sanitized
`AgentResourceIdentityError`を提供する。errorはpath/content/secretをechoしない。

validatorはmodel/registry implementation objectをinspectしてidentityを生成しない。resolved declarationのstable
scalar fieldsとknown topologyからexpected listを独立構築し、Definitionが明示したlistとexact比較する。

Correlation rules:

- model identityは`definition.model.provider`と`definition.model.profile.id`にexact一致
- instruction identitiesは`agentInstructions`/manifestのpresenceとregistry kindにexact一致
- skill identitiesはcatalogのeffective namesにexact一致
- catalogは`skills.length > 0`と`manifest !== undefined`がexactに同値でなければreject
- tool identitiesはregistry kindとskills presenceから得るexact known setに一致
- production `plannerDelegation: true`は`tool:delegate_to_planner`と`subagent:planner`の両方を要求
- planner registryはdelegation tool/subagentの両方を拒否
- resourcesのmissing、extra、unknown、duplicate、noncanonical orderを拒否
- `parameters.maxSteps`はpositive safe integerで、runtimeが消費する唯一のmax-step値
- selection envelopeはown enumerable string keysがexactに`resources`, `parameters`、parametersのown keysが
  exactに`maxSteps`でなければrejectする。missing/extra key、accessor、symbol key、non-plain prototype、
  non-number/non-safe/non-positive値をrejectし、shape検査のproperty enumerationをresource identity生成や
  canonical orderingには使わない

`ResolvedAgentDefinition`はtop-level `maxSteps`を`resourceSelection.parameters.maxSteps`へ移す。二つの同義fieldを
残してdrift可能な二重正本にはしない。built-in Definitionsがresource selectionを明示的に返す。

`createRuntimeComposition`はDefinition評価直後、credential source read、model constructor callback、planner handler
作成、Registry materializationの前にvalidationする。validation成功後だけ既存provider/registry switchを実行する。

`RuntimeTestSeam`へdirect-test-onlyの`plannerDefinition?: AgentDefinition`と
`onResourceSelectionValidated?: (role: 'parent' | 'planner', selection: AgentResourceSelection) => void`
を追加する。productionは常にfixed `plannerAgentDefinition`を使い、observerはvalidation成功直後かつ
materialization前だけ同期的に呼ぶ。これによりhard-coded lazy childのproduction contractを変えず、admission前0、
admission後1のvalidationとinvalid childのpre-materialization failureを直接観測する。

runtime consumersは`definition.resourceSelection.parameters.maxSteps`を使う。validated `resourceSelection`は
`RuntimeComposition`へdata-only fieldとして保持するが、CLI/TUI output、event、transcript、session record、
provider requestへ送らない。これがstep 77のresolved manifest producerが将来参照する唯一の接点となる。
step 76ではserialization、schema version、digestを追加しない。

lazy planner childもDefinition評価直後に同じvalidationを通し、validation failure時はchild model、Registry、
credential、fetchを開始しない。既存のsanitized planner failure、counter、parent continuation契約は変えない。

normal Definition compositionではselection parameterが`maxSteps`の唯一のresolved sourceである。一方、Definitionを
通らないfixed work-tools sentinelは現行`runtime.ts` export `MAX_STEPS`を使うため、これを
`DEFAULT_AGENT_MAX_STEPS`から直接導出するcompatibility aliasとして維持する。sentinel behavior/fileは変更せず、
normal parent/childだけがselection parameterを消費する。

## Ownership and files

### Product source

- new `v0/agent/resource_identity.ts`: grammar、ordering、known static IDs、selection construction、validation、error
- `v0/agent/agent_definition.ts`: `resourceSelection`、exact built-in resources、parameter source-of-truth
- `v0/agent/runtime.ts`: parent/child pre-materialization validation、composition selection、max-step consumption
  およびdirect-test-only planner Definition/validation observer seams。`MAX_STEPS` compatibility aliasは維持

`agent_catalog.ts`、`registries.ts`、`tools.ts`、`skills.ts`、`execution_context.ts`はbehavior sourceのままとし、
product変更は原則不要である。materialized objectをidentity sourceにすることは禁止する。

### Tests and gate

- `tests/v0/agent_definition_test.ts`: grammar、sets、ordering、negative validation、data-only/non-exposure
- `tests/v0/agent_runtime_test.ts`: validation timing、parent/lazy child wiring、behavior compatibility
- `deno.v0.json`: `v0:check`へnew sourceを追加。existing leaf task/permissionsは変更しない
- `tests/v0/offline_gate_topology_test.ts`: exact `v0:check` source inventoryへnew sourceを追加。direct test
  inventory、leaf ownership、permissions、gate edgesは変更しない

新しいdirect test file/taskは作らない。pure identity testsはpermission-free `agent:definition:test`、runtime evidenceは
existing bounded `agent:runtime:test`へ所属させ、このincrementのためにpermissionを追加しない。

### Documentation/lifecycle after implementation

- new `docs/plans/agent-definition-resource-identity-results.md`
- `README.md`: internal stable selection boundaryとnon-public/non-serialized contract
- `AGENTS.md`: measured results、review、scope exclusions
- `.handoff/handoff.md`: plan SHA、Human Gate、implementation/review checkpoint

## Exact offline test contract

### Pure identity and Definition tests

1. current model、all instruction/tool/subagent IDs、boundary-length skill IDをacceptする。
2. empty component、uppercase、whitespace、NUL、slash/backslash、extra colon、overlength、unknown kindをrejectする。
3. duplicate identityをrejectする。
4. kind rankまたはsame-kind lexical orderが崩れたlistをrejectする。
5. no-context/no-skill defaultが上記exact list、length 8、`maxSteps: 8`へ一致する。
6. workspace instructionと意図的にunsortedなtwo-skill fixtureからdefaultがcanonical 13-resource listを返す。
7. no-context/no-skill plannerが上記4 resourcesと`maxSteps: 8`へexact一致する。
8. context/two-skill plannerがcanonical 9-resource listを返し、bash/edit/write/delegation identitiesを持たない。
9. empty/nonempty catalogでskill-manifest、per-skill IDs、`tool:skill`が三者一貫して消失/出現する。
   manifestなし/nonempty skillsとmanifestあり/empty skillsの両mutationをrejectし、既存Definition testの
   empty-skills/nonempty-manifest fixtureもcoherent catalogへ直す。
10. productionからdelegation toolまたはplanner subagentの片方だけを削るmutationを各々rejectする。
11. plannerへdelegation tool/subagentを加えるmutationをrejectする。
12. unknown/missing/extra tool、wrong model correlation、missing planner policy、catalogにないskillをrejectする。
13. resources/parametersがfreezeされ、JSON round-trip可能で、resource entryがstringだけである。
14. sentinel workspace path、instruction/manifest content、skill path/body/result、profile `secretEnv`、dummy credentialが
    serialized selectionへ一つも現れない。
15. workspace rootやskill path/bodyを変えても、stable scalar selection inputsが同じならexact一致する。
16. `AGENTS.md` / `AGENTS.MD`由来instructionはいずれも同じ`instruction:workspace-agents`へなる。
17. selection/parametersのmissing/extra own key、symbol key、accessor、non-plain prototype、および`maxSteps`の
    undefined/string/NaN/infinite/non-safe/zero/negativeをrejectする。

### Runtime tests

1. valid defaultはvalidation後にmodel/production Registryを各1回materializeし、Registry tool namesとtool
   identitiesがexact一致する。
2. valid top-level plannerはdelegation capabilityなしでmaterializeする。
3. malformed/duplicate/unknown/noncanonical injected Definitionはstartupでrejectされ、model/registry
   materialization、credential-source、fetchが全て0となる。
4. no-delegation default pathはplanner Definition/resource validation/materialization 0のまま。
5. direct-test-only validation observerで、no-delegation pathはplanner validation 0、admitted delegationはparent
   selectionを一度、planner selectionをadmission後に一度だけvalidateし、既存値を維持する。
6. direct-test-only planner Definition overrideが返すinvalid child selectionはchild materialization/credential/fetchを
   開始せず、既存sanitized parent continuation/failure envelope/counterを維持する。productionのfixed childは不変。
7. alternate-profile test declarationはmatching identityの場合だけoffline materializationでき、mismatchは事前rejectする。
8. exact default/planner wire tools、instruction composition、one-shot/session max-step、omitted/explicit defaultを維持する。
9. one-child-per-turn、parent 8 / child 8 / aggregate 16、nonrecursive registry testsをrerunする。

CLI/TUI process matrix、session/event/streaming/persistenceの新規E2Eは作らず、shared runtimeを通るfull gateを回帰証拠とする。

## Ordered implementation

1. canonical planを保存してSHA-256を固定し、initial implementation Human Gateで停止する。
2. `resource_identity.ts`へgrammar、ordering、data-only selection、validation/error contractを追加する。
3. built-in Definitionsへexact resourcesと`parameters.maxSteps`を宣言する。
4. runtimeへparent/child pre-materialization validationを接続し、compositionへvalidated selectionを保持する。
5. normal parent/child max-step consumersをselection parameterへ切替え、旧top-level resolved fieldを除去する。
   sentinel向け`MAX_STEPS = DEFAULT_AGENT_MAX_STEPS` compatibility aliasは維持する。
6. permission-free Definition/identity testsを追加する。
7. runtime suiteへpre-materialization failure、lazy child、object/secret/path非露出回帰を追加する。
8. `v0:check` inventoryとcentral topology expectationだけを更新する。
9. focused、related、full offline verificationを行う。
10. results、README、AGENTS、handoffへmeasured evidenceを記録する。
11. bounded independent read-only reviewを行い、accepted findingを一回のplan-scoped closureで修正し、
    changed-lines re-reviewを最大1回行う。

## Validation commands

provider、credential、network、production `agent:run` / `agent:tui` commandを実行しない。

```sh
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --config deno.v0.json agent:definition:test
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --config deno.v0.json agent:runtime:test
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --config deno.v0.json agent:planner-delegation:test
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --config deno.v0.json agent:definition-selection:test
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --config deno.v0.json v0:offline-gate:topology:test
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --config deno.v0.json v0:check
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --config deno.v0.json v0:fmt
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --config deno.v0.json v0:lint
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --config deno.v0.json v0:test
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --config deno.v0.json v0:gate
git diff --check
```

`v0:gate`をauthoritative offline regressionとする。resultsへ実測test countを記録し、計画段階で増分countを固定しない。

## Review contract

initial review対象はapproved plan、step 76 diff、focused/full evidence、task/topology、results/lifecycle文書である。

- environment: trusted-local single-user Deno runtime
- severity: Blocker/P1/P2
- initial上限30分、10分間新しい証拠・tool result・中間結論がなければ中断
- re-reviewはchanged linesと既存finding closureだけ、15分、最大1回
- GO条件: Blocker/P1/P2 zero

重点はexact sets/order、optional instruction/skill一貫性、delegation dual-resource、path/secret/object非依存、
pre-materialization fail closed、maxStepsの単一正本、request/permission/runtime behavior不変、step 77非混入である。

## Acceptance package

resultsへauthority input/plan/revision、changed files、両built-inのexact resources/parameters、requirement-to-test
mapping、negative validation/non-exposure evidence、parent/lazy-child materialization counts、8/8/16 regression、
focused/full commandと実測count、permission topology、review/fix/re-review、deviation/rollback/risk、外部操作zeroを記録する。

Completionはfocused/full gates green、`git diff --check` clean、documentation整合、review Blocker/P1/P2 zeroである。

## Compatibility, rollback, and residual risk

migration/data conversionはない。identityはinternal、startup-only、nonpersistentであり、existing session schema、
transcript、event、provider requestへ書かない。

Rollbackはnew identity module、Definition selection/parameter、runtime validation/composition/max-step wiring、
Definition/runtime tests、check/topology inventory、README/results/AGENTS/handoff entriesに限定する。unrelated source、
user-owned `_refs/`、session state、prior plans/resultsを変更しない。

残る承認済みrisk:

- canonical serialization/version/digestはstep 77まで未定義。
- planner capabilityはmodel-visible capability boundaryでありOS sandboxではない。
- identityはselectionを示すがtool schema、instruction content、skill body、provider profile全fieldのdigestではない。
- compile-time built-ins以外のload、variant、replay、comparisonは未対応。

## Stop conditions and unresolved decisions

identityへtext/body/path/credential/object/functionが必要、current behavior/permission変更が必要、step 77 contractが必要、
public/dynamic API、dependency/lockfile、`_refs/`変更、provider/network/credential/production command、session/event/
persistence schema変更が必要、またはcurrent topologyがauthorityと矛盾する場合は実装せずownerへ返す。

現時点でWhy/What/Whetherのblocking contradictionはない。

## Human Gate

このplanの保存、hash固定、read-only review、必要なplanning-only修正、lifecycle planning record後に停止する。
ユーザーが別途明示承認するまでproduct source、tests、task config、results文書を変更せず、testも開始しない。

承認対象はstep 76 repository implementation、offline disposable tests、full offline gate、results/lifecycle更新、
bounded reviewだけである。provider/network/credential/production command、actual persistent product state、
dependency/lockfile、`_refs/`、commit、push、tag、publish、releaseは含めない。
