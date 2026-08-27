# Planner delegation sentinel response guard fix plan

## Status and recommendation

**GO、local implementationの初期Human Gate待ち。**

診断済みの`model_adherence_failure` false negativeだけを修正する。sentinelのprovider-response
検査をobject key/JSON byte完全一致から、現行`OpenRouterAgentModel`が消費するsemantic projectionの
厳密検査へ変更する。通常adapter、runtime、profile、prompt、registry、CLI/TUI、launcher、report、
2/1/3 request上限は変更しない。credential、network、production provider commandは実行しない。

## Authority and evidence

- User direction: `guard修正 ＞やろう`
- Existing plan: `docs/plans/planner-delegation-real-model-sentinel.md`、SHA-256
  `a6e0ccc655411ebb3b2d0700cca6f3ce3f767648e69297423c8361c364a0b07c`
- Implementation revision: `2d9f149`
- Gate Sとdiagnostic one-shotはいずれもfirst responseでexternal 1/3、retry等0で停止した。
- Diagnostic evidenceでは、assistant/content/sole tool/name/taskはsemanticに正しかった。
- OpenRouterがmessageへ`reasoning`、`reasoning_details`、`refusal`、tool callへ`index`を追加し、
  sentinelの`exactKeys`/whole-object比較だけが拒否した。
- Raw body、reasoning、call ID、usage/cost、temporary instrumentationは削除済み。

既存の未コミット`AGENTS.md`、`.handoff/handoff.md`、results記録とuntracked `_refs/`を保持する。

## Exact semantic response contract

### Common

- payloadはobject、`choices`はexactly one、sole choiceの`message`はobject。
- `message.role`はexactly `assistant`。
- 必須semantic fieldの型と値は厳密検査する。
- payload、choice、message、tool call、function objectの追加metadata fieldは無視する。
- metadata内の値で誤った必須semantic fieldを補完または上書きしない。

### First parent response

- `message.content === null`。
- `message.tool_calls`はarray、length exactly one。
- sole callはobject、`id`はnonblank string、`type === "function"`。
- `function`はobject、`name === "delegate_to_planner"`、`arguments`はstring。
- `arguments`を`JSON.parse`した値はnon-array object。
- parsed keysはexactly `task`一つ、値は`FIXED_DELEGATED_TASK`完全一致。

Argumentsのbyte-exact serializationは要求しない。normal adapterはJSON parse後の値をruntimeへ渡すため、
whitespace等の非semantic差は受理する。malformed JSON、null/array/scalar、missing/wrong task、extra parsed
property、non-string argumentsは拒否する。

### Child and final parent responses

- `message.content`は各expected final text完全一致。
- `message.tool_calls`はabsentまたは`null`だけを許容する。
- empty arrayを含むその他の値は拒否する。これはnormal adapterのfinal decode条件と一致する。
- 追加metadataは許容する。
- Child mismatchは`model_adherence_failure`、parent mismatchは`parent_final_mismatch`を維持する。

## Unchanged guarantees

- later parent requestのcanonical call/resultとcall-ID correlation。
- exactly one delegation、request order `parent` / `child` / `parent`。
- parent 2、child 1、aggregate/external 3、fourth requestはfetch前reject。
- planner mutation/recursion zero、retry/fallback/rerun/follow-up zero。
- workspace、credential、launcher lifecycle、sanitized report boundary。

## File scope

Implementation agent owns:

```text
v0/agent/planner_delegation_sentinel.ts
tests/v0/planner_delegation_sentinel_test.ts
docs/plans/planner-delegation-real-model-sentinel-results.md
README.md (only if an existing description becomes false)
```

Repository owner updates `AGENTS.md` and `.handoff/handoff.md` after verified results. Do not change
`openrouter_model.ts`、runtime、launcher、deno config、dependencies/lockfile、`_refs/`。

## Test matrix

1. Observed metadata regression:
   - parent messageに`reasoning`/`reasoning_details`/`refusal`、callに`index`。
   - child/final messageにもmetadata。
   - full fake `parent` / `child` / `parent` flowが2/1/3で成功。
2. Arguments:
   - semantic-equivalent noncanonical whitespace serializationを受理。
   - malformed、null/array/scalar、missing/wrong/extra task、non-stringを拒否。
3. Metadata cannot hide wrong semantics:
   - wrong role/content/id/type/name/task/functionはmetadataが正しくても拒否。
4. Tool topology:
   - absent/empty/multiple/extra call、blank ID、wrong type/nameを拒否。
   - sole semantic-exact callと追加metadataは受理。
5. Child/parent finals:
   - metadata plus absent/null `tool_calls`を受理。
   - empty/nonempty `tool_calls`、wrong textを拒否。
6. Existing correlation、fourth-request、mutation/second-delegation、redaction、workspace/count
   regressionsを維持。

## Verification and review

Repository-pinned Deno 2.9.4で次を実行する。

```text
agent:planner-delegation:sentinel:test
agent:planner-delegation:sentinel:process:test
agent:planner-delegation:sentinel:topology:test
agent:transport:test
agent:planner-delegation:test
agent:runtime:test
agent:runtime:process:test
v0:check
v0:fmt
v0:lint
v0:gate
git diff --check
```

Fake/dummy providerだけを使い、`agent:planner-delegation:sentinel:credential-file`、normal production
commands、credential/network/provider operationは実行しない。

実装後にindependent read-only reviewを行う。severityはBlocker/P1/P2、初回30分、10分間新証拠なしで
中断する。metadata許容がnormal adapterより広いsemantic behaviorを作らないこと、required fields、
parsed exact task、final zero-tool-call、correlation/2/1/3/redaction、preserved componentsを確認する。
finding修正後はchanged-lines re-review一回、15分以内。completionはBlocker/P1/P2 zero。

## Results, rollback, and stop conditions

Resultsへplan hash、changed files、observed metadata regression、negative matrix、focused/full counts、review、
provider/credential/network zeroを追記する。消費済みattempt記録やraw materialは変更・復元しない。

Rollbackはこのpredicate変更、追加tests、plan/results/lifecycle記録だけを戻し、既存sentinel、runtime、
credential state、消費済みevidence、user-owned差分を保持する。

次が必要なら停止してplan deltaを返す。

- adapter、runtime、profile、prompt、registry、CLI/TUI、launcherの変更。
- role/content/sole-call/id/type/name/parsed exact task、final zero-tool-callの緩和。
- outgoing correlationまたは2/1/3 ceilingの緩和。
- retry/fallback/rerun/follow-up、raw provider material、credential/provider operation。
- dependency/lockfile、`_refs/`、sibling repository変更。

このHuman Gateはlocal implementation、fake tests、full offline gate、results/lifecycle更新、bounded review
だけを対象とする。追加real-provider attemptはlocal completion後も別の明示承認を必要とする。
