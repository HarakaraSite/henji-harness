# Normal CLI offline process E2E plan

## Concept review

**GO。** roadmap step 11のproduct contractを変えず、test-only fixtureを独立Deno processで起動すれば、
actual argv/stdin、permission、exit status、stdout/stderr、process terminationをprovider/credentialなしで
検証できる。

現在のnormal runtime direct suiteは`main`と`RuntimeTestSeam`を使う14件のin-process vertical sliceであり、
full offline gateは92件である。既存`v0`にはsubprocess testとkill/reap patternがあるが、normal runtimeを
独立processとして検証するfocused E2Eはまだない。本incrementはこのgapだけを閉じる。

実環境のembedded Deno 2.9.4で`--no-remote`、`--no-prompt`、exact `--allow-run`が利用可能であること、
既存treeに`Deno.Command`、`clearEnv: true`、timeout後のkill/reap patternがあることを確認済みである。

## Scope and precedence

競合は`AGENTS.md`、本計画、active handoff、step 11 plan、pinned Zot commit
`9b7bb6a4f36bc8c8deb2cc5796a8f557f4fb7479`の順で解決する。

本incrementはoffline process boundaryだけを扱う。task corpus、capability eval、prompt A/B、live E2E、
cost eval、coverage campaign、fuzz、load、soakは後続incrementとする。

production provider/network operation、production credentialの存在確認・値読取り、production attempt、
dependency/lockfile、persistent product state、broad tool、session、commit、push、tag、publish、releaseは
含めない。

## Product and test contract

product runtime、CLI option、output schema、fixed profile/endpoint、tool registry、maximum 8 requests、retry 0は
step 11から一切変更しない。追加するのはtest-only process contractだけである。

```text
focused Deno test
  └─ Deno.Command(embedded Deno 2.9.4, clearEnv: true)
       └─ deno run --no-prompt --no-remote
            tests/v0/fixtures/runtime_process_fixture.ts
            <fixture-mode> [actual application argv]
              └─ fixtureがmodeだけ除去
                   └─ runtime_cli.main(actual argv, {
                        stdinIsTerminal,
                        runtimeSeam: { dummy credential, fake fetch }
                      })
                        └─ actual runRuntime
                             └─ fixed Registry / runAgent
                                  └─ deterministic in-memory fake fetch
```

- argv caseはactual child argvを`main`へ渡す。
- stdin caseはparentがchild stdin pipeへ実bytesを書いてcloseする。
- stdout/stderrとexit statusはOS process boundaryでcaptureする。
- fixtureは`run`関数を注入せず、既存`runtimeSeam`だけを使うためactual runtime compositionを通る。
- fixture modeは`argv-success`、`stdin-success`、`runtime-failure`、`tty`の4値だけとし、production
  application argvへ渡さない。
- success fakeはprovider request bodyに期待taskが含まれることを検証してfixed finalを返す。
- runtime failure fakeはsensitive markerを含むrejectionを返し、CLI redactionを検証する。
- fixture自身が`Deno.exit(await main(...))`を行う。

`Deno.Command`はPTYを割り当てないため、terminal-without-task caseだけ既存`stdinIsTerminal` seamへ`true`を
渡す。real PTY integrationは本incrementで証明しない。

## Fixture trust and permission boundary

- fixtureは`tests/v0/fixtures/`だけに置き、`v0/`からimportしない。
- production `agent:run`、`agent:acceptance`、READMEのproduction commandから到達不能とする。
- fixture controlをproduction CLIへ渡さず、provider/endpoint/model/credential sourceのproduction optionを
  追加しない。
- credentialはsource内の明示的dummy値だけとし、host envを読まない。
- fake fetchはnetworkへ委譲しない。
- childは`clearEnv: true`、`env: {}`、permission grantなし、`--no-prompt --no-remote`で起動する。
- parent focused testはembedded Denoへのexact `--allow-run`と`--allow-read=deno.v0.json`だけを持ち、
  env/net/write/broad read permissionを持たない。
- child argvに`--allow-*`がないことを直接assertする。

process harnessは各caseに2秒のhard deadlineとstdout/stderr各16 KiBのcapture上限を持つ。timeoutまたは
output overflow時はchildをkillし、必ずstatusをawaitしてreapする。正常matrixはdeadline内の自然終了を
要求し、kill発火を成功として扱わない。

## Ownership and files

実装承認後のwrite ownershipを次に限定する。

- new `tests/v0/fixtures/runtime_process_fixture.ts`
- new `tests/v0/agent_runtime_process_test.ts`
- `deno.v0.json`: focused task、check、gate integrationだけ
- `README.md`: focused offline process test commandだけ
- new `docs/plans/normal-cli-offline-process-e2e-results.md`
- repository ownerだけが`AGENTS.md`と`.handoff/handoff.md`をphase/checkpoint用に更新する

次は変更しない。

- `v0/agent/runtime.ts`
- `v0/agent/runtime_cli.ts`
- `v0/agent/contracts.ts`
- `v0/agent/loop.ts`
- `v0/agent/openrouter_model.ts`
- `v0/agent/tools.ts`
- production profile、endpoint、CLI option/output contract
- `agent:run`、`agent:acceptance`のtask文字列
- dependency、lockfile、persistent state、archive、`_refs/`

これらの変更が必要になった場合は実装を止め、原因、証拠、影響、plan delta、検証方法をdefaultへ返す。

## Ordered increments

### 1. Add bounded process harness

- embedded Denoへのexact command builderを実装する。
- `clearEnv`、permission grantなし、deadline、capture上限、kill/reapを実装する。
- child argvとproduction task definitionsをliteralに検査する。

### 2. Add test-only fixture

- fixture modeを検証して除去し、残りargvをactual `main`へ渡す。
- actual child stdinとstdout/stderrを使う。
- dummy credentialとdeterministic fake fetchだけを`runtimeSeam`へ渡す。
- request bodyのtaskを検証し、不一致ならsuccessを返さない。

### 3. Implement exact process matrix

| Case | Child input | Expected |
| --- | --- | --- |
| topology/config | config readbackとconstructed argv | embedded Deno、`clearEnv`、`--no-prompt --no-remote`、`--allow-*`なし、production tasks不変・未呼出し |
| argv success | `argv-success --task '  argv task  '`、TTY seam true | exit 0、stdout exact `offline argv answer\n`、stderr empty、request task=`argv task` |
| piped stdin success | `stdin-success`、stdin=`"  piped task\n"` | exit 0、stdout exact `offline stdin answer\n`、stderr empty、request task=`piped task` |
| preflight failure | `tty --unknown` | exit 1、stdout empty、exact `invalid_input` JSON、全counter 0、fetch 0 |
| runtime failure | `runtime-failure --task valid` | exit 1、stdout empty、exact `agent_failure` JSON、steps/request=`1/1`、tool counters 0、sensitive markerなし |
| prompt termination | `tty`、argvなし、stdin null | 2秒以内に自然終了、exit 1、stdout empty、preflight JSON、全counter 0、kill未発火 |

preflight stderrは次のcompact JSONと末尾newline 1個だけとする。

```json
{"ok":false,"outcome":"contract_failure","stopReason":"contract_failure","steps":0,"toolCallCount":0,"toolResultCount":0,"requestCount":0,"error":{"code":"invalid_input","message":"invalid agent invocation"}}
```

runtime failure stderrは次のcompact JSONと末尾newline 1個だけとする。

```json
{"ok":false,"outcome":"contract_failure","stopReason":"contract_failure","steps":1,"toolCallCount":0,"toolResultCount":0,"requestCount":1,"error":{"code":"agent_failure","message":"agent run failed"}}
```

### 4. Integrate focused task and gate

追加するfocused taskのpermission上限は次とする。

```text
deno test --no-prompt
  --allow-run=/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno
  --allow-read=deno.v0.json
  tests/v0/agent_runtime_process_test.ts
```

- task名は`agent:runtime:process:test`とする。
- testとfixtureを`v0:check`へ追加する。
- focused taskを`v0:gate`へ追加する。
- `v0:gate`がproduction `agent:run`または`agent:acceptance`をtaskとして呼ばないことを検査する。
- full gateの既存broad parent permissionは本incrementで変更しない。childへは継承せず常にgrantなしとする。

### 5. Complete offline evidence

次をembedded binaryで実行する。

```sh
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --config deno.v0.json agent:runtime:process:test
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --config deno.v0.json agent:runtime:test
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --config deno.v0.json v0:check
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --config deno.v0.json v0:fmt
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --config deno.v0.json v0:lint
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --config deno.v0.json v0:test
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --config deno.v0.json v0:gate
git diff --check
```

resultsへexact child argv、permission、`clearEnv`、case結果、exit/output、自然終了、provider/network calls 0、
production credential未確認・未読、production task実行0、deviation、review、remaining riskを記録する。

### 6. Bounded independent review

30分以内のread-only reviewでfixture隔離、actual `main`/runtime通過、argv/stdin process boundary、permission、
environment clear、timeout/reap、output limit、exact presentation、redaction、production task不変・gate非到達、
scope外変更なしを確認する。10分間新しい証拠がなければ停止する。

fix後のchanged-lines re-reviewは15分以内で一回だけとする。Blocker/P1/P2が残る場合、またはproduct/shared
contract変更が必要な場合はNO-GOとしてdefaultへ戻す。

## Acceptance conditions

- 6 process casesがembedded Deno 2.9.4でgreen。
- actual argv、pipe stdin、exit status、stdout/stderrをOS process境界で観測。
- no-task terminal branchがdeadline前に自然終了。
- child permission grant 0、environment clear、remote import禁止を証拠化。
- provider/network request 0、production credential確認・読取り0。
- production `agent:run`と`agent:acceptance`の実行0かつtask定義不変。
- focused task、direct runtime、check/fmt/lint/full test/gate、diff checkがgreen。
- results packageがrequirementsと直接証拠を対応付ける。
- independent reviewがBlocker/P1/P2 0でGO。

## Compatibility and rollback

additiveかつtest-onlyでmigrationはない。rollbackはfixture、process test、resultsを削除し、`deno.v0.json`の
focused task/check/gate entry、READMEのfocused command、phase/checkpointだけを戻す。product source、
production task、step 11 evidence、untracked `_refs/`、worktree全体をresetしない。

## Remaining risks and deferred work

- TTY判定はexisting seam経由でありreal PTY integrationを証明しない。
- fake providerはlive provider、credential validity、model品質を証明しない。
- fixed final/failureだけでtool capability corpusやevalを証明しない。
- 2秒deadlineは極端に遅いschedulerでflakyになり得る。実証された場合だけtest-local plan deltaを検討する。
- task corpus、eval runner、live E2E、repeated eval/A-B、cost、coverage、fuzz、load、soakは後続とする。

## Human Gate

本計画の承認は、上記test-only fixture、process E2E、task/gate integration、README、results、offline
validation、bounded read-only reviewだけを許可する。

production `agent:run`または`agent:acceptance`の実行、network/provider operation、production credentialの
確認・読取り、product/shared runtime contract変更、dependency/lockfile、persistent state、commit、push、
tag、publish、releaseは含まない。必要になった時点で停止して別判断へ戻す。
