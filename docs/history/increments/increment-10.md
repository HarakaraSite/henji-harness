# 通常利用 increment 10 — 非対話CLIのheadless Host / Worker統合

ステータス: local実装・検証完了。2026-09-08に利用者が初期計画を承認し、第三者reviewと最終gateまで完了

## 利用者が必要とする動作

1. 非対話`agent:run`も、production TUIと同じDeno Web Worker内でAgent Definitionを評価し、
   AgentCompositionとturnを実行する。
2. `agent:run`の既存入力文法、final-only stdout、failure JSON、exit code、one-shot・Session非永続の性質を維持する。
3. Workerが合成する有効toolのguidelineを非対話実行でもmodelへ渡し、TUIとの`read`、`bash_output`、
   `web_search`利用方針の差をなくす。
4. HostがDefinition revision、Worker generation、base state revision、commit proposal、ack、closeを所有し、
   非対話CLIから直接`runAgent`を呼ばない。
5. production Workerと同じ固定credential fileをrequest時に使い、credential値をHost / Worker command、引数、
   logへ入れない。Session transcriptは保存しないが、失敗診断、provider evidence、execution artifactはTUIの
   `--no-session`と同じworkspace別state rootへ保存してreadback可能にする。

## 根拠

- repository-wide consistency reviewで、`deno task agent:run`が`runtime_cli.ts`から`runRuntime`へ進み、
  CLI process内で`runAgent`を直接実行する経路が見つかった。これはDeno Web Workerを実行primitiveとする
  architecture、およびDefinition評価・composition・turnをWorkerが所有する境界と一致しない。
- 同じ経路のRegistryは`bash_output`、`read`、`web_search`のguidelineを持つが、direct runtimeの
  `systemInstruction`には`## Active tool guidelines`がなく、production TUIとmodel-visible instructionが異なる。
- `createWorkerTuiSession({ persistence: 'none' })`は、memory session handleを使いながらDefinition revisionの
  pre-read、Worker起動、proposal/commit/ack、diagnostic/evidence/artifact storage、closeを既に実行できる。
  この共通部分はTUI固有ではないため、headless Surfaceから再利用できるHost session factoryとして扱える。
- `docs/operations/openrouter-credential.md`はnormal Worker production compositionの正本を固定credential fileと
  している。Worker統合後の`agent:run`だけを旧environment credentialへ残す理由はない。

## 実装方針

### 1. 共通Worker session factory

- 現`createWorkerTuiSession`のworkspace解決、instruction/skill snapshot、Definition revision確定、memoryまたは
  durable handle、diagnostic/evidence/artifact store、`WorkerHostSession`起動を、TUIだけを前提としない
  `createWorkerSession`として明示する。
- production TUIは同じfactoryを引き続き使い、navigation、display startup projection、history export等の
  Host-owned Surface機能を維持する。
- 既存のprovider-free `capsuleFactory`等のseamは、実Worker経路をnetworkなしで確認するため維持する。

### 2. headless one-shot runner

- Worker Host層にone-shot headless runnerを追加する。built-in agent選択とtaskを受け、
  `persistence: 'none'`、`physicalIoMode: 'production'`で共通factoryを起動し、一turnをsubmitして必ずcloseする。
- 戻り値は現在のCLIが必要とする`LoopOutcome`とrequest countに限定する。progress event、TUI renderer、
  Presentation overlay、navigationは構築しない。
- `runtime_cli.ts`のproduction default runnerをこのheadless runnerへ切り替える。入力検証とstdout/stderr変換は
  現在のCLIに残し、既存のinjected runner seamでchannel contractを直接確認できるようにする。
- `runtime.ts`と`runRuntime`はoffline evaluation、sentinel、既存direct testの内部経路として残すが、
  production `agent:run`からは到達させない。

### 3. launcherとcredential / state境界

- `agent:run`用launcherでphysical workspace、workspace別state root、固定Deno 2.9.4、固定credential fileへの
  必要なpermissionを確定してから`runtime_cli.ts`を起動する。
- production taskから`HENJI_OPENROUTER_API_KEY`のallow-envを外す。Worker内の
  `createProductionPhysicalIo`が`readCredentialFile`をrequestごとに呼ぶ現契約へ統一する。
- Session record/context checkpointは作らない。failure diagnostic、provider evidence、execution artifactだけを
  state rootへ保存する現在の`--no-session`境界を使う。

### 4. 文書の同期

- roadmap F01/F02/F09/F12の非対話経路を、同じWorker capsuleとHost commit経路を使う現在状態へ更新する。
- `v0/agent/README.md`へheadless production entryの配置を反映する。
- `docs/operations/openrouter-credential.md`の移動前source pathを現配置へ直し、TUIと非対話CLIが同じ
  request-time credential sourceを使うことを記録する。
- 実装後にincrement 10 resultsとhandoffを更新する。

## 維持するcontract

- `agent:run --task TEXT`、`agent:run --agent NAME --task TEXT`、引数なしのnon-TTY stdin入力。
- TTYとstdin/argvの組合せ、空入力、64 KiB超過、未知agent/optionの拒否。
- 成功時はfinal text一件だけをstdoutへ出し、末尾newlineを一つ保証する。
- 失敗時は既存shapeのJSON一件だけをstderrへ出し、exit 1とする。
- `default` / `planner`の選択、root maxSteps、request count、tool terminal result。
- 一回のcommandでSessionを作成・再開・一覧化せず、次のinvocationへtranscriptを持ち越さない。

## 対象外

- `agent:run`へのstreaming、progress表示、interactive cancel、steering、follow-up、Session選択、history表示。
- external Definitionを選ぶ新しいCLI option。
- direct runtime、corpus、sentinel、comparison runnerのWorker移行または削除。
- general Surface load / replacement API、durable AgentInstance、self-revision機能。
- provider/model/tool schema、retry、fallback、Web search backendの変更。
- live provider実行、credential内容の確認、push、publish、tag、release。

## 検証

- provider-freeなreal Workerでheadless runnerを一turn実行し、Definition pre-read、Worker composition、
  commit proposal/ack、final outcome、request count、closeを確認する。
- headless Workerのmodel requestに、選択済みtoolのactive guidelineが一回だけ含まれることを確認する。
- injected runnerを使い、既存argv/stdin、stdout/stderr、failure JSON、exit code contractを確認する。
- production task/launcherが`runtime_cli.ts`へ到達し、固定credential fileとstate rootに必要なpermissionだけを渡し、
  environment credentialとdirect `runRuntime`へ到達しないことを確認する。
- focused test、`v0:check`、format、lint、`git diff --check`を実行する。stable candidateのreview後、
  authoritative offline `v0:gate`はcoordinating ownerが一回だけ実行する。
- live providerとreal terminalはこのlocal実装の自動検証では実行しない。production human gateが必要なら、
  実装結果を確認した後に利用者の明示指示を受ける。

## 実装結果

- `createWorkerTuiSession`の本体をSurface非依存の`createWorkerSession`として公開し、TUI名は互換aliasにした。
  TUIと新しいheadless runnerは同じfactoryから`WorkerHostSession`を起動する。
- `runHeadlessWorker`はbuilt-in選択と一taskを受け、memory session handleでsubmitし、結果とexternal request
  countを返した後にcooperative closeする。
- `runtime_cli.ts`のproduction defaultからdirect `runRuntime`依存を除き、CLI parserとchannel projectionだけを
  Host側に残した。`runRuntime`はevaluation、corpus、sentinel用の直接経路として残した。
- `agent:run`は`runtime_cli_launcher.sh`を入口とし、physical workspace、workspace別state root、Deno 2.9.4を
  確定する。`HENJI_OPENROUTER_API_KEY`を渡さず、Worker内の固定credential file sourceを使う。launcherの
  `umask 077`により、headless実行が先にstate rootを作っても後続のdurable Session directory modeと整合する。
- one-shot実行ではSession directoryを作らず、failure diagnostic、provider evidence、execution artifactの
  storeはproduction `--no-session`と同じstate rootで有効なままにした。
- roadmap、architecture、source layout、credential運用文書を実装後の経路へ同期した。

## Focused検証結果

- `agent:worker-foundation:test`: 40 passed。real WorkerのDefinition pre-read、proposal/commit/ack、final、close、
  active tool guideline、Session非永続とartifact永続、CLI channel、launcher permissionを確認した。
- `v0:check`: 成功。
- `v0:fmt`: 成功。
- `v0:lint`: 成功。
- `sh -n v0/agent/runtime_cli_launcher.sh`: 成功。
- production task smoke `agent:run --unknown`: provider/credentialへ進まず、既存`invalid_input` JSON一件とexit 1を
  返した。
- 第三者re-review: GO。P1/P2の解消を確認し、対応必須findingなし。
- authoritative offline `v0:gate`: 一回実行して成功。
- `git diff --check`: 成功。
- credential内容とprovider networkは参照していない。
